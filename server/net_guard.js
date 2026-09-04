// Shared network-target guard (§5.4 spirit) — SECURITY CRITICAL.
//
// One place decides whether a caller-supplied host is allowed to be contacted at all.
// exec.js has carried its own copy of this rule since the ping collector landed; this
// module is the extraction, used by the discovery collector. exec.js is deliberately
// left untouched in this slice (it is security-critical and this slice is meant to be
// purely additive) — switching it to this import is a one-line follow-up.
//
// Beyond exec.js's RFC1918 rule this adds two things the discovery path needs:
//   - link-local 169.254.0.0/16 is refused explicitly. That range carries the cloud
//     metadata endpoint (169.254.169.254); a discovery endpoint that will happily GET
//     whatever it finds must not be pointable at it.
//   - the address is canonicalised and the canonical form is what callers connect to.
//     "010.0.0.1" passes a naive \d{1,3} regex and Number() reads it as 10, but the
//     C resolver behind net.connect reads the leading zero as octal — the check and
//     the connection would disagree about which host was approved.

const PRIVATE_REASON = 'host must be a private IPv4 address (RFC1918 or loopback)';

/**
 * @param {unknown} host
 * @returns {{ok:true, ip:string} | {ok:false, reason:string}}
 */
export function checkPrivateIp(host) {
  if (typeof host !== 'string' || !host) return { ok: false, reason: 'host is required' };
  const s = host.trim();
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return { ok: false, reason: `not an IPv4 literal: ${clip(s)}` };
  const oct = m.slice(1, 5);
  // A leading zero means the octet is ambiguous (decimal here, octal to inet_aton).
  // Refuse rather than guess which one the OS will pick.
  if (oct.some((o) => o.length > 1 && o[0] === '0')) {
    return { ok: false, reason: `ambiguous octet (leading zero): ${clip(s)}` };
  }
  const n = oct.map(Number);
  if (n.some((x) => x > 255)) return { ok: false, reason: `octet out of range: ${clip(s)}` };
  const [a, b] = n;
  const ip = n.join('.');
  if (a === 169 && b === 254) {
    return { ok: false, reason: `link-local range is refused (169.254.0.0/16): ${ip}` };
  }
  const priv = a === 10
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || a === 127;
  if (!priv) return { ok: false, reason: `${PRIVATE_REASON}: ${ip}` };
  return { ok: true, ip };
}

const clip = (s) => String(s).slice(0, 64);

// ── inbound client addresses (slice P1: first-run setup) ────────────
// Everything above answers "may WE connect to this host". The two helpers below
// answer the opposite question — "did this request come from the LAN" — which the
// first-run setup endpoint uses to refuse a public caller. Same private-range rule,
// two differences that only inbound addresses have.

/**
 * Classify an INBOUND peer address. Wraps checkPrivateIp with the two forms a real
 * socket produces and an outbound target never does:
 *   - "::1", IPv6 loopback, which is what a browser on the host itself gets;
 *   - "::ffff:192.168.1.5", the IPv4-mapped IPv6 form a dual-stack listener reports.
 * A genuine (non-mapped) IPv6 address is refused: this project's private-range rule is
 * written for IPv4, and guessing at ULA/link-local equivalences in a security gate is
 * how you end up with a gate that is wrong in a direction nobody notices.
 * @param {unknown} addr
 * @returns {{ok:true, ip:string} | {ok:false, reason:string}}
 */
export function checkPrivateClient(addr) {
  if (typeof addr !== 'string' || !addr.trim()) return { ok: false, reason: 'no client address' };
  let s = addr.trim();
  if (s === '::1') return { ok: true, ip: '::1' };
  // ::ffff:a.b.c.d — unwrap to the IPv4 the rule is written for.
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) s = mapped[1];
  if (s.includes(':')) return { ok: false, reason: `IPv6 client addresses are not accepted: ${clip(s)}` };
  return checkPrivateIp(s);
}

/**
 * Pick the address to make a trust decision about, from a request's forwarding chain.
 *
 * NOT the same thing as Fastify's `req.ip`. With `trustProxy: true` Fastify believes the
 * WHOLE X-Forwarded-For chain and hands back its LEFTMOST entry — which is the entry the
 * ORIGINAL CALLER supplied. That is the right default for logging and for spreading a
 * rate limit across real clients, and it is exactly wrong here: anyone on the internet
 * could send `X-Forwarded-For: 10.0.0.1`, have the reverse proxy append their real
 * address after it, and be read as a LAN client.
 *
 * The RIGHTMOST entry is the one the nearest proxy wrote itself, so it is the last hop
 * the caller could not forge. With one reverse proxy in front — this project's
 * deployment — that entry is the real client. With no header at all the socket peer is
 * already the real client.
 *
 * This is deliberately strict rather than clever: a longer chain of proxies would make
 * the rightmost entry the outermost proxy instead of the client, which fails CLOSED
 * (a public caller is not admitted; a LAN caller behind an unusual chain may be refused
 * and has to fall back to editing .env).
 *
 * @param {string|string[]|undefined} xff  the X-Forwarded-For header, raw
 * @param {string|undefined} peer          req.socket.remoteAddress
 * @returns {string} the address to judge, or '' when there is nothing to judge
 */
export function forwardedClientAddr(xff, peer) {
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return typeof peer === 'string' ? peer : '';
}
