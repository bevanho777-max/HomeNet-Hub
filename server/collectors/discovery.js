// discovery collector (slice 1) — read-only surface discovery of one LAN host.
//
// Answers "what could I monitor at this IP?" without credentials and without writing
// anything: TCP reachability over a fixed port set, an unauthenticated HTTP/TLS
// fingerprint of whatever answered, and a list of capabilities those findings would
// support. Nothing here is scheduled, stored, or fed into a target — the caller gets a
// manifest and decides.
//
// Security posture, following exec.js §5.4:
//   - the host is checked by net_guard BEFORE any socket is opened, and only the
//     canonical form it returns is ever connected to;
//   - the port set is a constant in this file. Callers cannot name a port, so this
//     endpoint can never be aimed at an arbitrary internal service;
//   - no shell anywhere. The one external command (ping, as an "up but no open ports"
//     fallback) goes through execFile with an argv array;
//   - every probe is individually try/catch'd and the whole run is bounded by a
//     deadline, so one hung socket cannot hold the request open.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkPrivateIp } from '../net_guard.js';
import { DISCOVERY_PORTS as PORTS, NODE_FAMILIES } from '../capabilities/ports.js';
import { suggestFor } from '../capabilities/catalog.js';

const pexecFile = promisify(execFile);
const isWin = process.platform === 'win32';

// The bounded port set and the node_exporter family list now live in
// capabilities/ports.js, imported above: the capability catalog needs the same table
// to decide what it may build a target for, and a table owned by either module would
// have made that a cycle.

const TCP_TIMEOUT_MS = 1200;
const TCP_CONCURRENCY = 20;
const HTTP_TIMEOUT_MS = 3000;
const TLS_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 2000;
const TOTAL_BUDGET_MS = 10000;
const BODY_LIMIT = 64 * 1024;         // enough for <head>; we only want <title>
const METRICS_LIMIT = 2 * 1024 * 1024; // node_exporter's full page is a few hundred KB

// ── TCP reachability ────────────────────────────────────────────────
function tcpProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ open, latency_ms: open ? Date.now() - started : null });
    };
    const sock = net.connect({ host: ip, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// Fixed-size worker pool. The port set is 16 entries so this is one wave in practice,
// but the cap is what keeps a future longer list from opening 200 sockets at once.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── HTTP fingerprint ────────────────────────────────────────────────
// Core http/https rather than fetch: LAN admin UIs (Proxmox, DSM) serve self-signed
// certificates, and fetch has no per-request way to accept them — every one of the
// hosts this is meant to fingerprint would fail before returning a status. We are
// reading a status line and a <title>, not trusting the peer, so the trade is sound.
// Redirects are deliberately NOT followed: the redirect target is itself a finding.
function httpProbe(ip, port, scheme, timeoutMs) {
  return new Promise((resolve) => {
    const mod = scheme === 'https' ? https : http;
    const started = Date.now();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = mod.request({
        host: ip, port, path: '/', method: 'GET',
        // No servername: SNI must not carry an IP literal, and we accept any cert.
        ...(scheme === 'https' ? { rejectUnauthorized: false } : {}),
        headers: { 'user-agent': 'HomeNet-Hub-discovery/1', accept: '*/*' },
      });
    } catch { return done(null); }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* noop */ } done(null); });
    req.once('error', () => done(null));
    req.once('response', (res) => {
      let body = '', len = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (len < BODY_LIMIT) { body += c; len += c.length; }
        else { try { res.destroy(); } catch { /* noop */ } }
      });
      const finish = () => done({
        http_status: res.statusCode,
        server: pick(res.headers.server),
        title: titleOf(body),
        location: pick(res.headers.location),
        latency_ms: Date.now() - started,
      });
      res.once('end', finish);
      res.once('close', finish);
      res.once('error', finish);
    });
    req.end();
  });
}

const pick = (v) => (typeof v === 'string' && v ? v.slice(0, 120) : undefined);

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return undefined;
  const t = m[1]
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e])
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 80) : undefined;
}

// ── node_exporter ───────────────────────────────────────────────────
function nodeExporterProbe(ip, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request({
        host: ip, port: 9100, path: '/metrics', method: 'GET',
        headers: { 'user-agent': 'HomeNet-Hub-discovery/1', accept: 'text/plain' },
      });
    } catch { return done(null); }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* noop */ } done(null); });
    req.once('error', () => done(null));
    req.once('response', (res) => {
      if (res.statusCode !== 200) { try { res.destroy(); } catch { /* noop */ } return done(null); }
      let body = '', len = 0, truncated = false;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (len < METRICS_LIMIT) { body += c; len += c.length; }
        else if (!truncated) { truncated = true; try { res.destroy(); } catch { /* noop */ } }
      });
      const finish = () => {
        if (!body.includes('# HELP')) return done(null);
        done({
          present: true,
          metric_families: NODE_FAMILIES.filter((f) => body.includes(f)),
          body_truncated: truncated,
        });
      };
      res.once('end', finish);
      res.once('close', finish);
      res.once('error', finish);
    });
    req.end();
  });
}

// ── TLS certificate ─────────────────────────────────────────────────
function tlsProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let sock;
    try {
      // rejectUnauthorized:false on purpose — a self-signed cert's expiry is exactly
      // the thing worth reporting, and refusing it would report nothing at all.
      sock = tls.connect({ host: ip, port, rejectUnauthorized: false });
    } catch { return done(null); }
    sock.setTimeout(timeoutMs, () => { try { sock.destroy(); } catch { /* noop */ } done(null); });
    sock.once('error', () => done(null));
    sock.once('secureConnect', () => {
      let out = null;
      try {
        const c = sock.getPeerCertificate();
        if (c && c.valid_to) {
          const exp = Date.parse(c.valid_to);
          out = {
            tls_valid_to: Number.isFinite(exp) ? new Date(exp).toISOString() : undefined,
            tls_expiry_days: Number.isFinite(exp)
              ? Math.floor((exp - Date.now()) / 86400000) : undefined,
            tls_subject_cn: pick(c.subject?.CN),
            tls_self_signed: c.issuer && c.subject
              ? JSON.stringify(c.issuer) === JSON.stringify(c.subject) : undefined,
          };
        }
      } catch { out = null; }
      try { sock.destroy(); } catch { /* noop */ }
      done(out);
    });
  });
}

// ── ping fallback ───────────────────────────────────────────────────
// Only used when no port answered: a host can be up with everything firewalled.
// execFile with an argv array — no shell, and the host is already canonicalised.
async function pingProbe(ip) {
  const args = isWin ? ['-n', '1', '-w', String(PING_TIMEOUT_MS), ip]
                     : ['-c', '1', '-W', '2', ip];
  const started = Date.now();
  try {
    const { stdout } = await pexecFile('ping', args, { timeout: PING_TIMEOUT_MS + 500 });
    const m = stdout.match(/=\s*([\d.]+)\s*ms/) || stdout.match(/time[=<]\s*([\d.]+)/i);
    return { alive: true, latency_ms: m ? Math.round(Number(m[1])) : Date.now() - started };
  } catch {
    return { alive: false, latency_ms: null };
  }
}

// ── OS inference ────────────────────────────────────────────────────
// Runs AFTER the fingerprints, on an evidence ladder rather than on the port set
// alone. Two deviations from the brief, both found by testing against this LAN:
//   - "445 open -> windows" types every Samba box as Windows; the NAS here
//     (Synology: 22 + 445 + 5000/5001) is exactly that shape.
//   - "3389 open -> windows" mistyped an Ubuntu host running xrdp, which was also
//     serving node_exporter and `Server: nginx (Ubuntu)`. Positive OS evidence beats
//     a port that merely tends to correlate.
// node_exporter is the strongest signal available without credentials (Windows boxes
// run windows_exporter instead), so it leads. os_hint_reason names the winning
// evidence so a wrong call is diagnosable instead of mysterious.
const LINUX_UA = /(ubuntu|debian|centos|fedora|alpine|unix|linux|synology|openresty)/i;

function osHint(openSet, services, nodeExp) {
  const has = (p) => openSet.has(p);
  if (nodeExp?.present) {
    return { os_hint: 'linux', os_hint_reason: 'node_exporter responding (unix exporter)' };
  }
  if (has(5000) || has(5001)) {
    return { os_hint: 'linux', os_hint_reason: 'synology dsm ports open (linux-based)' };
  }
  const ua = services.find((s) => LINUX_UA.test(s.server || '') || LINUX_UA.test(s.title || ''));
  if (ua) {
    return { os_hint: 'linux', os_hint_reason: `http banner on :${ua.port} — ${ua.server || ua.title}` };
  }
  if (has(22) && !has(3389)) return { os_hint: 'linux', os_hint_reason: 'ssh open, no rdp' };
  if (has(3389)) {
    return {
      os_hint: 'windows',
      os_hint_reason: has(22) ? 'rdp open (ssh too, no unix evidence)' : 'rdp/3389 open',
    };
  }
  if (has(445)) return { os_hint: 'windows', os_hint_reason: 'smb/445 open, no ssh or unix evidence' };
  return { os_hint: 'unknown', os_hint_reason: 'no evidence in the probed surface' };
}

/**
 * Read-only surface discovery of one private-IPv4 host.
 * Never throws for probe failures — a failed probe is an absent field.
 * @param {string} host
 * @param {{budgetMs?:number}} [opts]
 */
export async function discoverTarget(host, opts = {}) {
  const started = Date.now();
  const guard = checkPrivateIp(host);
  if (!guard.ok) {
    const err = new Error(guard.reason);
    err.code = 'EHOSTNOTALLOWED';
    throw err;
  }
  const ip = guard.ip;
  const budget = Math.min(Number(opts.budgetMs) || TOTAL_BUDGET_MS, TOTAL_BUDGET_MS);
  const deadline = started + budget;
  const left = () => deadline - Date.now();

  const manifest = {
    host: ip,
    reachable: false,
    latency_ms: null,
    os_hint: 'unknown',
    os_hint_reason: 'not probed',
    open_ports: [],
    services: [],
    node_exporter: null,
    suggested_capabilities: [],
    partial: false,          // true when the budget cut a phase short
    took_ms: 0,
  };

  // phase 1 — TCP sweep
  let open = [];
  try {
    const results = await pooled(PORTS, TCP_CONCURRENCY, (p) =>
      tcpProbe(ip, p.port, Math.max(200, Math.min(TCP_TIMEOUT_MS, left()))));
    open = PORTS.map((p, i) => ({ ...p, ...(results[i] || {}) })).filter((r) => r.open);
  } catch { manifest.partial = true; }

  manifest.open_ports = open.map(({ port, port_hint }) => ({ port, port_hint }));
  if (open.length) {
    manifest.reachable = true;
    manifest.latency_ms = Math.min(...open.map((o) => o.latency_ms ?? Infinity));
    if (!Number.isFinite(manifest.latency_ms)) manifest.latency_ms = null;
  } else {
    // phase 1b — nothing answered; the host may still be up behind a firewall
    try {
      const p = await pingProbe(ip);
      manifest.reachable = p.alive;
      manifest.latency_ms = p.latency_ms;
      manifest.probed_by = 'ping';
    } catch { /* stays unreachable */ }
  }

  // phase 2 — fingerprint the HTTP(S) ports that answered, plus certificates
  const httpTargets = open.filter((o) => o.scheme);
  let fingerprintSkipped = false;
  const services = [];
  if (httpTargets.length && left() > 500) {
    const fps = await pooled(httpTargets, Math.min(TCP_CONCURRENCY, httpTargets.length),
      async (t) => {
        const budgetMs = Math.max(300, Math.min(HTTP_TIMEOUT_MS, left()));
        const [fp, cert] = await Promise.all([
          httpProbe(ip, t.port, t.scheme, budgetMs).catch(() => null),
          t.tls ? tlsProbe(ip, t.port, Math.max(300, Math.min(TLS_TIMEOUT_MS, left())))
                  .catch(() => null)
                : Promise.resolve(null),
        ]);
        return { ...fp, ...cert };
      });
    httpTargets.forEach((t, i) => {
      const extra = fps[i] || {};
      const entry = { port: t.port, port_hint: t.port_hint, scheme: t.scheme };
      for (const [k, v] of Object.entries(extra)) if (v !== undefined) entry[k] = v;
      services.push(entry);
    });
  } else if (httpTargets.length) {
    manifest.partial = true;
    fingerprintSkipped = true;
  }
  manifest.services = services;

  // phase 3 — node_exporter
  if (open.some((o) => o.port === 9100) && left() > 500) {
    try {
      manifest.node_exporter = await nodeExporterProbe(
        ip, Math.max(300, Math.min(HTTP_TIMEOUT_MS, left())));
    } catch { manifest.node_exporter = null; }
  }

  // OS inference last: it reads the fingerprints, not just the open ports. If the
  // budget cut that phase, the port set alone is not enough — an Ubuntu host running
  // xrdp looks exactly like a Windows box until the banner comes back — so the answer
  // is unknown rather than a guess the caller cannot tell apart from a real finding.
  const hint = fingerprintSkipped
    ? { os_hint: 'unknown',
        os_hint_reason: 'fingerprint phase skipped (time budget); port evidence alone is inconclusive' }
    : osHint(new Set(open.map((o) => o.port)), services, manifest.node_exporter);
  manifest.os_hint = hint.os_hint;
  manifest.os_hint_reason = hint.os_hint_reason;

  // Suggestions come from the capability catalog, not from a second list kept here:
  // what the caller is offered and what POST /api/user_targets would build are now the
  // same code path, so a suggestion the API refuses cannot happen.
  manifest.suggested_capabilities = suggestFor({
    host: ip, open, services, nodeExporter: manifest.node_exporter, osHint: manifest.os_hint,
  });
  manifest.took_ms = Date.now() - started;
  return manifest;
}

