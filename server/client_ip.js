// Who the real client is, from the socket peer and the forwarding headers.
//
// Measured 2026-10-29: the only reverse proxy in front of this service is Lucky on
// 192.168.1.5. Lucky OVERWRITES X-Forwarded-For / X-Real-IP with its own peer, which is
//   - a LAN client's own address when it connects to Lucky directly (192.168.1.136, ...);
//   - 127.0.0.1 when the request came from the internet: Cloudflare -> cloudflared, which
//     runs on the Lucky box and reaches Lucky over loopback. The visitor's address then
//     survives only in CF-Connecting-IP, which Cloudflare sets itself;
//   - 192.168.1.5 for traffic that left through the outbound proxy on that box and came back.
//
// Rules, in order:
//   1. Forwarding headers count only when the socket peer is a trusted proxy. Anything that
//      reaches the port directly gets its socket address, whatever headers it sends.
//   2. Walk X-Forwarded-For (else X-Real-IP) from the right, skipping trusted proxies; the
//      first other address is the client.
//   3. A loopback hop is cloudflared on the proxy box: the client is CF-Connecting-IP. Without
//      that header the client is unknown ('') -- fail closed, never "loopback, so local".
//   4. Every hop is a trusted proxy: the proxy itself is the best we know.

const DEFAULT_TRUSTED = '192.168.1.5';

/** Plain address: trimmed, IPv4-mapped IPv6 unwrapped, no brackets. '' if empty. */
export function normIp(s) {
  if (typeof s !== 'string') return '';
  let v = s.trim().replace(/^\[|\]$/g, '');
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) v = mapped[1];
  return v;
}

const isLoopback = (ip) => ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
const looksLikeIp = (ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) || (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':'));

/** Trusted proxy addresses: TRUSTED_PROXIES (comma-separated), default Lucky. */
export function trustedProxies(raw = process.env.TRUSTED_PROXIES) {
  const list = (raw && raw.trim() ? raw : DEFAULT_TRUSTED).split(',').map(normIp).filter(Boolean);
  return new Set(list);
}

const header = (h, name) => {
  const v = h?.[name];
  return Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '';
};

/**
 * @param {string|undefined} peer           req.socket.remoteAddress
 * @param {Record<string, string|string[]|undefined>} headers  raw request headers (lower-case keys)
 * @param {Set<string>} [trusted]
 * @returns {{ip: string, via: 'direct'|'proxy'|'cloudflare'|'proxy-only'|'unknown'}}
 */
export function resolveClientIp(peer, headers, trusted = TRUSTED) {
  const p = normIp(peer);
  if (!trusted.has(p)) return { ip: p, via: 'direct' };
  let hops = header(headers, 'x-forwarded-for').split(',').map(normIp).filter(Boolean);
  if (!hops.length) hops = [normIp(header(headers, 'x-real-ip'))].filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (isLoopback(hop)) {
      const cf = normIp(header(headers, 'cf-connecting-ip'));
      return looksLikeIp(cf) ? { ip: cf, via: 'cloudflare' } : { ip: '', via: 'unknown' };
    }
    if (trusted.has(hop)) continue;
    return { ip: hop, via: 'proxy' };
  }
  return { ip: p, via: 'proxy-only' };
}

const TRUSTED = trustedProxies();

/** For Fastify: the trusted proxy list, so X-Forwarded-Proto/Host are only believed from them. */
export const TRUST_PROXY_LIST = [...TRUSTED];

/** Real client address of a Fastify request ('' when it cannot be known). */
export const clientIpOf = (req) => resolveClientIp(req.socket?.remoteAddress, req.headers).ip;
