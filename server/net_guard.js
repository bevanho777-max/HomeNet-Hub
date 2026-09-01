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
