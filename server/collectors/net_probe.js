// tcp + tls collectors (§5.2, slice 2c) — the two probes behind the port_check and
// tls_cert capabilities.
//
// Both are deliberately in one file: they are the same shape of thing (open a socket
// to a private host, report what came back, never throw for a peer that simply is not
// there) and they share the host guard.
//
// Defence in depth: the host was already validated when the capability was
// materialised, but it is validated again on every poll. A target row is data at rest
// — an operator hand-editing the database, or a future import path, must not be able
// to turn a stored target into an outbound probe of anything it likes.
import net from 'node:net';
import tls from 'node:tls';
import { checkPrivateIp } from '../net_guard.js';

const DEFAULT_TIMEOUT_MS = 3000;

function guardedTarget(source, what) {
  const guard = checkPrivateIp(source?.host);
  if (!guard.ok) throw new Error(`illegal ${what} target: ${guard.reason}`);
  const port = Number(source?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`illegal ${what} target: invalid port ${source?.port}`);
  }
  return { ip: guard.ip, port };
}

/**
 * TCP connect probe. A refused or timed-out connection is a RESULT, not an error:
 * "the port is closed" is exactly what this target exists to report, and throwing
 * would make the scheduler mark the card offline with a stale last-known value
 * instead of showing status:offline. Only an illegal target throws.
 * @returns {Promise<{status:'online'|'offline', latency_ms:number|null}>}
 */
export function collectTcp(source, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { ip, port } = guardedTarget(source, 'tcp');
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ status: open ? 'online' : 'offline', latency_ms: open ? Date.now() - started : null });
    };
    const sock = net.connect({ host: ip, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * TLS certificate probe. rejectUnauthorized:false on purpose — a self-signed
 * certificate's expiry is exactly what is worth watching on a LAN, and verifying
 * would report nothing at all for most of them. No servername either: SNI must not
 * carry an IP literal.
 *
 * A failed handshake DOES throw: unlike a closed TCP port, "no certificate" is not a
 * reading of the thing this target measures, and reporting expiry_days:null as a
 * healthy sample would quietly zero the card.
 * @returns {Promise<{status, expiry_days, valid_to, subject_cn, self_signed, latency_ms}>}
 */
export function collectTls(source, timeoutMs = 4000) {
  const { ip, port } = guardedTarget(source, 'tls');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const fail = (msg) => { if (!done) { done = true; try { sock.destroy(); } catch { /* noop */ } reject(new Error(msg)); } };
    const ok = (v) => { if (!done) { done = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); } };
    let sock;
    try {
      sock = tls.connect({ host: ip, port, rejectUnauthorized: false });
    } catch (e) { return reject(new Error(`tls connect failed: ${e.message}`)); }
    sock.setTimeout(timeoutMs, () => fail('timeout'));
    sock.once('error', (e) => fail(String(e?.message || e)));
    sock.once('secureConnect', () => {
      let cert;
      try { cert = sock.getPeerCertificate(); } catch (e) { return fail(`no certificate: ${e.message}`); }
      if (!cert || !cert.valid_to) return fail('peer presented no certificate');
      const exp = Date.parse(cert.valid_to);
      if (!Number.isFinite(exp)) return fail(`unparsable notAfter: ${cert.valid_to}`);
      ok({
        status: 'online',
        expiry_days: Math.floor((exp - Date.now()) / 86400000),
        valid_to: new Date(exp).toISOString(),
        subject_cn: typeof cert.subject?.CN === 'string' ? cert.subject.CN.slice(0, 120) : null,
        self_signed: cert.issuer && cert.subject
          ? JSON.stringify(cert.issuer) === JSON.stringify(cert.subject) : null,
        latency_ms: Date.now() - started,
      });
    });
  });
}
