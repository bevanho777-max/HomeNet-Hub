// ssh collector (slice 2f) — credentialed Linux metrics. SECURITY CRITICAL.
//
// This is the first collector that carries a secret onto the network, so three rules
// shape it and none of them are negotiable:
//
//  1. The remote command is a constant in this file. Nothing from config, from a user
//     target or from an API body reaches the shell — a target row names a host and a
//     credential, never a command.
//  2. A target stores `credential_id`, never a secret. The plaintext exists only inside
//     collect(), from the vault.decrypt() call to the moment ssh2 has consumed it.
//  3. Host keys are trust-on-first-use, and a CHANGED key is a hard refusal. We are
//     about to send a password; whoever answers on that address gets it. A prompt-free
//     "warning" would mean handing the credential to the impostor first and complaining
//     afterwards, which is worse than useless.
//
// The output shape matches the push agent's payload (cpu.pct / mem.used_gb / net.rx_bps
// / uptime_s), for the same reason the prometheus collector does: a host reached over
// SSH renders through the same map, templates and machine card as one running the agent.
import { Client } from 'ssh2';
import { createHash } from 'node:crypto';
import { checkPrivateIp } from '../net_guard.js';

// One round trip, five files, fixed text. The separator is a constant too.
const SEP = '__HNH_SEP__';
const REMOTE_CMD = [
  'cat /proc/stat', 'cat /proc/meminfo', 'df -kP /', 'cat /proc/net/dev', 'cat /proc/uptime',
].join(` ; echo ${SEP} ; `);

const MAX_OUTPUT = 512 * 1024;      // /proc/net/dev on a busy host is still a few KB
const GB = 1024 ** 3;
const KB_PER_GB = 1024 ** 2;

// Rate state per (host, port, credential): CPU and network are counters and only mean
// something as a delta. Keyed with the credential because a different credential may be
// a different account on a different machine behind the same address.
const prev = new Map();

/** OpenSSH's fingerprint format, so an operator can compare it with ssh-keyscan. */
const fingerprintOf = (keyBuf) =>
  'SHA256:' + createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');

/**
 * @param {{host:string, port?:number, credential_id:string, timeout?:string}} source
 * @param {{vault, credStore, timeoutMs?:number}} deps
 */
export async function collectSsh(source, deps) {
  const { vault, credStore } = deps || {};
  const timeoutMs = deps?.timeoutMs || 6000;
  if (!vault || !credStore) throw new Error('ssh collector is not wired to the vault');

  const guard = checkPrivateIp(source?.host);
  if (!guard.ok) throw new Error(`illegal ssh target: ${guard.reason}`);
  const host = guard.ip;
  const port = Number(source?.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ssh port ${source?.port}`);

  const credId = source?.credential_id;
  if (!credId) throw new Error('ssh source has no credential_id');
  if (vault.locked) throw new Error(`vault locked (${vault.reason})`);
  const cred = credStore.get(credId);
  if (!cred) throw new Error(`credential ${credId} no longer exists`);

  let secret;
  try {
    secret = vault.decrypt(credStore.secretOf(credId));
  } catch {
    // Deliberately opaque: a decrypt failure must not echo anything about the material.
    throw new Error(`credential ${credId} could not be decrypted (wrong VAULT_KEY?)`);
  }

  const auth = cred.type === 'ssh_key'
    ? { privateKey: secret }
    : { password: secret };

  const hostport = `${host}:${port}`;
  let out;
  try {
    out = await runRemote({ host, port, username: cred.username, auth, timeoutMs, credStore, hostport });
  } finally {
    // Cannot zero a JS string; what we can do is drop every reference immediately so it
    // is collectable and never reaches a closure, a log line or an error.
    secret = null;
    auth.password = auth.privateKey = null;
  }
  return parseReport(out, `${hostport}#${credId}`);
}

function runRemote({ host, port, username, auth, timeoutMs, credStore, hostport }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* already closing */ }
      err ? reject(err) : resolve(val);
    };
    // Own deadline: ssh2's readyTimeout covers the handshake but not a hung exec.
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    const finish = (err, val) => { clearTimeout(timer); done(err, val); };

    conn.on('error', (e) => finish(new Error(scrub(e?.message || String(e)))));
    conn.on('ready', () => {
      conn.exec(REMOTE_CMD, (err, stream) => {
        if (err) return finish(new Error(scrub(err.message)));
        let buf = '', stderr = '';
        stream.on('data', (d) => { if (buf.length < MAX_OUTPUT) buf += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { if (stderr.length < 2048) stderr += d.toString('utf8'); });
        stream.on('close', (code) => {
          if (!buf.trim()) return finish(new Error(`remote command produced nothing${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
          finish(null, buf);
        });
      });
    });

    conn.connect({
      host, port, username, ...auth,
      readyTimeout: timeoutMs,
      // Return false and ssh2 aborts the handshake BEFORE authenticating, so a changed
      // key means the credential is never sent.
      hostVerifier: (key) => {
        const fp = fingerprintOf(key);
        let verdict;
        try { verdict = credStore.checkHostKey(hostport, fp); } catch { verdict = 'error'; }
        if (verdict === 'mismatch') {
          finish(new Error(`host key changed for ${hostport} — refusing to send credentials`
            + ' (run: DELETE the remembered key only if you know why it changed)'));
          return false;
        }
        if (verdict === 'error') { finish(new Error('could not check host key')); return false; }
        if (verdict === 'new') console.log(`[ssh] learned host key for ${hostport} ${fp}`);
        return true;
      },
    });
  });
}

// Last line of defence: ssh2's messages never contain the password today, but this
// function is the only thing between a library error and a log file.
const SECRETISH = /(password|passphrase|privateKey)\s*[:=]\s*\S+/gi;
const scrub = (msg) => String(msg).replace(SECRETISH, '$1: <redacted>');

// ── parsing ─────────────────────────────────────────────────────────
export function parseReport(text, stateKey) {
  const [stat, meminfo, df, netdev, uptime] = String(text).split(SEP);
  const now = Date.now();
  const last = prev.get(stateKey);
  const out = { status: 'online' };

  // cpu: same arithmetic as the push agent (idle = idle + iowait, total = every field),
  // so a host reached over SSH and the same host running the agent agree.
  let cpuIdle = null, cpuTotal = null;
  const cpuLine = (stat || '').split('\n').find((l) => l.startsWith('cpu '));
  if (cpuLine) {
    const n = cpuLine.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
    if (n.length >= 5) {
      cpuIdle = n[3] + n[4];
      cpuTotal = n.reduce((a, b) => a + b, 0);
    }
  }
  let cpuPct = null;
  if (cpuIdle != null && last?.cpuTotal != null) {
    const dT = cpuTotal - last.cpuTotal, dI = cpuIdle - last.cpuIdle;
    // A rebooted host resets the counters; a negative delta is that, not a busy spike.
    if (dT > 0 && dI >= 0) cpuPct = Math.max(0, Math.min(100, (1 - dI / dT) * 100));
  }
  out.cpu = { pct: cpuPct };

  // mem: MemTotal / MemAvailable, in kB
  const kv = {};
  for (const line of (meminfo || '').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]);
  }
  out.mem = (kv.MemTotal > 0 && kv.MemAvailable != null)
    ? { pct: ((kv.MemTotal - kv.MemAvailable) / kv.MemTotal) * 100,
        used_gb: (kv.MemTotal - kv.MemAvailable) / KB_PER_GB, total_gb: kv.MemTotal / KB_PER_GB }
    : { pct: null, used_gb: null, total_gb: null };

  // disk: df's OWN Used column, not size-minus-available. The gap between them is the
  // root-reserved blocks (~5% of an ext4 root); using Used keeps this card equal to
  // `df -h` and to what the push agent reports for the same machine.
  const dfLine = (df || '').trim().split('\n')[1];
  if (dfLine) {
    const f = dfLine.trim().split(/\s+/);
    const total = Number(f[1]), used = Number(f[2]);
    out.disk = (Number.isFinite(total) && total > 0 && Number.isFinite(used))
      ? { pct: (used / total) * 100, used_gb: used / KB_PER_GB, total_gb: total / KB_PER_GB }
      : { pct: null, used_gb: null, total_gb: null };
  } else {
    out.disk = { pct: null, used_gb: null, total_gb: null };
  }

  // net: /proc/net/dev, loopback excluded, counters -> bytes/sec
  let rx = null, tx = null;
  for (const line of (netdev || '').split('\n')) {
    const m = line.match(/^\s*([\w.@-]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const c = m[2].trim().split(/\s+/).map(Number);
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[8])) continue;
    rx = (rx || 0) + c[0];
    tx = (tx || 0) + c[8];
  }
  let rxBps = null, txBps = null;
  if (rx != null && last?.rx != null) {
    const dt = (now - last.ts) / 1000;
    if (dt > 0) {
      if (rx - last.rx >= 0) rxBps = (rx - last.rx) / dt;
      if (tx - last.tx >= 0) txBps = (tx - last.tx) / dt;
    }
  }
  out.net = { rx_bps: rxBps, tx_bps: txBps };

  const up = Number((uptime || '').trim().split(/\s+/)[0]);
  if (Number.isFinite(up) && up > 0) out.uptime_s = Math.floor(up);

  prev.set(stateKey, { ts: now, cpuIdle, cpuTotal, rx, tx });
  return out;
}

/** Test seam. */
export function resetSshState(key) { if (key) prev.delete(key); else prev.clear(); }
export const SSH_REMOTE_CMD = REMOTE_CMD;
