// exec collector (§5.4) — SECURITY CRITICAL.
// Config NEVER supplies a free command string. It may only reference a name in
// the ALLOWED registry below and pass validated arguments. Any unregistered
// command or illegal argument is refused and logged as an alert.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);
const isWin = process.platform === 'win32';

// ── helpers ─────────────────────────────────────────────────────────
// Private/LAN IPv4 only (RFC1918). Blocks SSRF-ish pings to arbitrary hosts.
function assertPrivateIp(host) {
  if (typeof host !== 'string') return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((x) => x > 255) || a > 255) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  return false;
}

// ── CPU% via os.cpus() delta sampling ───────────────────────────────
let _prevCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!_prevCpu) { _prevCpu = { idle, total }; return null; }
  const dIdle = idle - _prevCpu.idle;
  const dTotal = total - _prevCpu.total;
  _prevCpu = { idle, total };
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

// ── /proc/net/dev delta (Linux) for kbps ────────────────────────────
let _prevNet = null;
async function netKbps() {
  if (isWin) return { rx: null, tx: null };
  try {
    const { readFile } = await import('node:fs/promises');
    const txt = await readFile('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+):\s+(.*)$/);
      if (!m || m[1] === 'lo') continue;
      const cols = m[2].trim().split(/\s+/).map(Number);
      rx += cols[0] || 0; tx += cols[8] || 0;
    }
    const now = Date.now();
    if (!_prevNet) { _prevNet = { rx, tx, now }; return { rx: null, tx: null }; }
    const dt = (now - _prevNet.now) / 1000 || 1;
    const out = {
      rx: Math.max(0, ((rx - _prevNet.rx) * 8) / 1000 / dt), // kbps
      tx: Math.max(0, ((tx - _prevNet.tx) * 8) / 1000 / dt),
    };
    _prevNet = { rx, tx, now };
    return out;
  } catch { return { rx: null, tx: null }; }
}

async function diskRootGb() {
  if (isWin) return { pct: null, used_g: null, total_g: null };
  try {
    const { stdout } = await pexecFile('df', ['-kP', '/']);
    const line = stdout.trim().split('\n').pop().trim().split(/\s+/);
    const totalK = Number(line[1]), usedK = Number(line[2]);
    if (!Number.isFinite(totalK) || totalK <= 0) return { pct: null, used_g: null, total_g: null };
    return {
      pct: (usedK / totalK) * 100,
      used_g: usedK / 1024 / 1024,
      total_g: totalK / 1024 / 1024,
    };
  } catch { return { pct: null, used_g: null, total_g: null }; }
}

async function sysreportLocal() {
  const totalB = os.totalmem(), freeB = os.freemem();
  const usedB = totalB - freeB;
  const up = os.uptime();
  const [m1, m5, m15] = os.loadavg();
  const [disk, net] = await Promise.all([diskRootGb(), netKbps()]);
  return {
    cpu: cpuPercent(),
    mem: { pct: (usedB / totalB) * 100, used_g: usedB / 1024 ** 3, total_g: totalB / 1024 ** 3 },
    disk,
    load: [m1, m5, m15],
    net,
    uptime: { days: Math.floor(up / 86400), hours: Math.floor((up % 86400) / 3600) },
  };
}

async function pingHost(host) {
  if (!assertPrivateIp(host)) throw new Error(`illegal ping target (not a private IP): ${host}`);
  const args = isWin ? ['-n', '1', '-w', '1500', host] : ['-c', '1', '-W', '2', host];
  const started = Date.now();
  try {
    const { stdout } = await pexecFile('ping', args, { timeout: 4000 });
    const m = stdout.match(/=\s*([\d.]+)\s*ms/) || stdout.match(/time[=<]\s*([\d.]+)/i);
    return { status: 'online', latency_ms: m ? Math.round(Number(m[1])) : Date.now() - started };
  } catch {
    return { status: 'offline', latency_ms: null };
  }
}

async function probeTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: 'unknown', latency_ms: null };
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ctrl.signal });
    clearTimeout(timer);
    return { status: r.ok ? 'online' : 'offline', latency_ms: Date.now() - started };
  } catch {
    return { status: 'offline', latency_ms: null };
  }
}

// ── the allowlist (§5.4) ─────────────────────────────────────────────
const ALLOWED = {
  sysreport_local: () => sysreportLocal(),
  ping_host: (args) => pingHost(args?.[0]),
  probe_telegram: () => probeTelegram(),
};

export async function collectExec(source) {
  const name = source.command;
  const fn = ALLOWED[name];
  if (!fn) {
    console.error(`[exec:DENY] unregistered command "${name}" — refusing (§5.4)`);
    throw new Error(`exec command not allowed: ${name}`);
  }
  return fn(source.args || []);
}
