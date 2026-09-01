// prometheus collector (§5.2, slice 2d) — scrape one /metrics endpoint and turn it
// into the same payload shape a push agent sends.
//
// Shape choice: the output mirrors the AGENT PROTOCOL payload (`cpu.pct`,
// `mem.used_gb/total_gb`, `disk.used_gb/total_gb`, `net.rx_bps/tx_bps`, `uptime_s`),
// not exec.js's sysreportLocal(). Two reasons. Every real machine card in this
// deployment already maps the agent shape, so a scraped host renders through exactly
// the same map and the same templates with nothing new to learn. And sysreportLocal()
// reports `net` in kbps while normalize.js documents that field as BYTES/sec — no
// config maps it today so the mismatch is latent, but copying it would have made it
// real (see the note in the slice write-up).
//
// Counters, not gauges: node_cpu_seconds_total and node_network_*_bytes_total only
// mean something as a rate, so this collector keeps the previous reading per target
// and reports the delta. The first scrape of a target therefore has no CPU or network
// value — null, rendered "—" — which is correct rather than a fabricated zero.
import { checkPrivateIp } from '../net_guard.js';

// Only these families are retained while parsing; node_exporter's page is several
// hundred KB and there is no reason to hold the rest in memory.
const WANTED = new Set([
  'node_cpu_seconds_total',
  'node_memory_MemTotal_bytes',
  'node_memory_MemAvailable_bytes',
  'node_filesystem_size_bytes',
  'node_filesystem_avail_bytes',
  'node_filesystem_free_bytes',
  'node_network_receive_bytes_total',
  'node_network_transmit_bytes_total',
  'node_boot_time_seconds',
]);

// Pseudo filesystems that would otherwise show up as a root-sized "disk".
const PSEUDO_FS = new Set(['tmpfs', 'ramfs', 'devtmpfs', 'squashfs', 'overlay', 'autofs']);

const GB = 1024 ** 3;

// Rate state per target url: { ts, cpuIdle, cpuTotal, rx, tx }. Keyed by url because
// that is what identifies a scrape endpoint; a removed target leaves one small entry
// behind, which is an acceptable trade against threading target lifecycle in here.
const prev = new Map();

/**
 * Minimal Prometheus text-format parser.
 * Handles `name{label="v",...} value` and `name value`; skips # HELP / # TYPE and
 * blank lines; ignores trailing timestamps. A malformed line is skipped, never thrown:
 * one bad line in a 5000-line page must not cost the whole scrape.
 * @returns {Map<string, {labels:Object, value:number}[]>}
 */
export function parsePromText(text, wanted = WANTED) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    const brace = line.indexOf('{');
    const sp = line.indexOf(' ');
    if (sp < 0 && brace < 0) continue;
    let name, rest;
    if (brace >= 0 && (sp < 0 || brace < sp)) {
      name = line.slice(0, brace);
      const close = line.lastIndexOf('}');
      if (close < 0) continue;
      rest = line.slice(close + 1);
      if (!wanted.has(name)) continue;
      const labels = parseLabels(line.slice(brace + 1, close));
      pushSample(out, name, labels, rest);
    } else {
      name = line.slice(0, sp);
      if (!wanted.has(name)) continue;
      pushSample(out, name, {}, line.slice(sp));
    }
  }
  return out;
}

function pushSample(out, name, labels, rest) {
  // `value [timestamp]` — take the first token only.
  const v = Number(String(rest).trim().split(/\s+/)[0]);
  if (!Number.isFinite(v)) return;
  if (!out.has(name)) out.set(name, []);
  out.get(name).push({ labels, value: v });
}

function parseLabels(s) {
  const labels = {};
  // key="value" with \" and \\ escapes — the only escapes the text format defines
  // inside a label value besides \n.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s))) labels[m[1]] = m[2].replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  return labels;
}

const sum = (rows) => (rows || []).reduce((a, r) => a + r.value, 0);
const one = (rows) => (rows && rows.length ? rows[0].value : null);

/**
 * @param {{url:string}} source
 * @param {number} timeoutMs
 * @returns {Promise<object>} agent-protocol-shaped payload
 */
export async function collectPrometheus(source, timeoutMs = 4000) {
  const url = source?.url;
  if (!url) throw new Error('prometheus source missing url');
  let u;
  try { u = new URL(url); } catch { throw new Error(`prometheus source has an invalid url: ${url}`); }
  // Defence in depth, exactly as tcp/tls do it: a stored row is data at rest, and a
  // hand-edited one must not be able to turn a scrape into an outbound request to
  // anywhere. The scheme is pinned too — node_exporter is plaintext, and allowing
  // https here would mean another self-signed-certificate decision for no gain.
  if (u.protocol !== 'http:') throw new Error(`prometheus source must be http:// (got ${u.protocol}//)`);
  const guard = checkPrivateIp(u.hostname);
  if (!guard.ok) throw new Error(`illegal prometheus target: ${guard.reason}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text;
  try {
    // Fetch the PARSED url, not the raw string. The WHATWG parser normalises a host
    // before we ever see it ("010.0.0.1" is already 8.0.0.1 by the time `u.hostname`
    // is read, which is why the guard above catches it as public rather than as a
    // leading zero). Handing fetch the same object we validated removes any chance of
    // the two re-parsing differently.
    const r = await fetch(u.href, { signal: ctrl.signal, headers: { accept: 'text/plain' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'timeout' : String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
  if (!text.includes('# HELP') && !text.includes('node_')) {
    throw new Error('response is not prometheus text (no node_* metrics)');
  }

  const m = parsePromText(text);
  const now = Date.now();
  const last = prev.get(url);
  const out = { status: 'online' };

  // ── cpu: rate over the counter, all cores summed ──────────────────
  const cpuRows = m.get('node_cpu_seconds_total');
  let cpuIdle = null, cpuTotal = null;
  if (cpuRows?.length) {
    cpuTotal = sum(cpuRows);
    cpuIdle = sum(cpuRows.filter((r) => r.labels.mode === 'idle'));
  }
  let cpuPct = null;
  if (cpuIdle != null && last?.cpuTotal != null) {
    const dTotal = cpuTotal - last.cpuTotal;
    const dIdle = cpuIdle - last.cpuIdle;
    // A restarted node_exporter resets the counter; a negative delta is that, not a
    // 100% spike. Report nothing for one interval and re-baseline below.
    if (dTotal > 0 && dIdle >= 0) cpuPct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  out.cpu = { pct: cpuPct };

  // ── memory ────────────────────────────────────────────────────────
  const memTotal = one(m.get('node_memory_MemTotal_bytes'));
  const memAvail = one(m.get('node_memory_MemAvailable_bytes'));
  if (memTotal != null && memAvail != null && memTotal > 0) {
    const used = Math.max(0, memTotal - memAvail);
    out.mem = { pct: (used / memTotal) * 100, used_gb: used / GB, total_gb: memTotal / GB };
  } else {
    out.mem = { pct: null, used_gb: null, total_gb: null };
  }

  // ── root filesystem ───────────────────────────────────────────────
  // used = size - FREE, not size - avail. The difference is ext4's root-reserved
  // blocks (5% by default, ~7.5G on this LAN's 146G root). `free` reproduces df's
  // Used column exactly, which is what the push agent reports via `df -kP` — and
  // consistency across cards is the point: the same host scraped and pushed must not
  // read 89.8G on one card and 82.0G on the next with nothing on screen explaining
  // the gap. `avail` is kept as the fallback for an exporter that omits free.
  const realFs = (rows) => (rows || []).filter((r) => r.labels.mountpoint === '/' && !PSEUDO_FS.has(r.labels.fstype));
  const fsSize = realFs(m.get('node_filesystem_size_bytes'))[0]?.value ?? null;
  const fsFree = realFs(m.get('node_filesystem_free_bytes'))[0]?.value
    ?? realFs(m.get('node_filesystem_avail_bytes'))[0]?.value ?? null;
  if (fsSize != null && fsFree != null && fsSize > 0) {
    const used = Math.max(0, fsSize - fsFree);
    out.disk = { pct: (used / fsSize) * 100, used_gb: used / GB, total_gb: fsSize / GB };
  } else {
    out.disk = { pct: null, used_gb: null, total_gb: null };
  }

  // ── network: rate over the counters, loopback excluded ────────────
  const netSum = (name) => {
    const rows = m.get(name);
    if (!rows?.length) return null;
    return sum(rows.filter((r) => r.labels.device !== 'lo'));
  };
  const rx = netSum('node_network_receive_bytes_total');
  const tx = netSum('node_network_transmit_bytes_total');
  let rxBps = null, txBps = null;
  if (rx != null && last?.rx != null) {
    const dt = (now - last.ts) / 1000;
    if (dt > 0) {
      const dRx = rx - last.rx, dTx = tx - last.tx;
      if (dRx >= 0) rxBps = dRx / dt;
      if (dTx >= 0) txBps = dTx / dt;
    }
  }
  out.net = { rx_bps: rxBps, tx_bps: txBps };

  // ── uptime ────────────────────────────────────────────────────────
  const boot = one(m.get('node_boot_time_seconds'));
  if (boot != null && boot > 0) out.uptime_s = Math.max(0, Math.floor(now / 1000 - boot));

  prev.set(url, { ts: now, cpuIdle, cpuTotal, rx, tx });
  return out;
}

/** Test seam: drop the rate baseline for one url (or all). */
export function resetPromState(url) {
  if (url) prev.delete(url); else prev.clear();
}
