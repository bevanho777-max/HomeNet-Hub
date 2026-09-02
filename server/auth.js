// Admin authentication — password gate for the management endpoints.
// SECURITY CRITICAL, and deliberately fail-closed everywhere.
//
// The contract this file exists to keep:
//   - NO `ADMIN_PASSWORD` means every admin endpoint answers 401. It never means
//     "open". An unconfigured install is locked, not permissive — the opposite choice
//     would turn a forgotten env var into a public write API;
//   - the password is read from the environment, compared in constant time, and never
//     written, logged, echoed or returned. Nothing derived from it leaves the process
//     except an HMAC tag that cannot be inverted;
//   - a session is a SIGNED cookie, not a server-side table: the signing key is derived
//     from the password itself, so changing the password invalidates every outstanding
//     session for free, with no revocation list to keep;
//   - one byte of tampering anywhere in the cookie fails verification.
//
// Why the session key is scrypt(ADMIN_PASSWORD, fixed salt) rather than a random key
// minted at boot: a random key would log every admin out on every restart and on every
// container rebuild, which on this deployment is often. The salt is a constant because
// its usual job — stopping precomputation against a STORED hash — does not apply: this
// derivation's output is never stored or transmitted, only used as an HMAC key. What
// the derivation buys is that a weak password is expensive to grind against a captured
// cookie, and that is what scrypt's cost parameter is for.
import { scryptSync, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'hnh_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // 12h
const KEY_SALT = Buffer.from('homenet-hub admin session v1');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 8;

// ── rate limiting ───────────────────────────────────────────────────
// Two tiers, because with a reverse proxy in front the two answer different questions.
//   client tier: keyed on the real client IP (X-Forwarded-For via trustProxy). This is
//     the one that stops someone guessing at one browser.
//   peer tier:   keyed on the actual socket peer. Everything arriving through Lucky
//     shares one peer, so this is what bounds an attacker who rotates X-Forwarded-For
//     — trustProxy means we believe that header, and a header we believe is a header
//     that can be forged by anything that can reach the port directly.
const CLIENT_MAX = 5;                 // failures per window before backoff starts
const CLIENT_WINDOW_MS = 60 * 1000;
const CLIENT_MAX_LOCK_MS = 15 * 60 * 1000;
const PEER_MAX = 30;                  // failures per window from one socket peer
const PEER_WINDOW_MS = 60 * 1000;
const BUCKET_CAP = 4096;              // hard bound on the tracking map

export class LoginLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.buckets = new Map();         // key -> { fails, first, until }
  }

  _bucket(key, windowMs) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || (t - b.first > windowMs && t >= (b.until || 0))) {
      b = { fails: 0, first: t, until: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** @returns {{ok:true} | {ok:false, retryAfterS:number}} */
  check(clientKey, peerKey) {
    const t = this.now();
    this._prune();
    for (const [key, windowMs] of [[`c:${clientKey}`, CLIENT_WINDOW_MS], [`p:${peerKey}`, PEER_WINDOW_MS]]) {
      const b = this.buckets.get(key);
      if (b?.until > t) return { ok: false, retryAfterS: Math.ceil((b.until - t) / 1000) };
    }
    return { ok: true };
  }

  /** Record a failure and, past the threshold, lock the key with exponential backoff. */
  fail(clientKey, peerKey) {
    const t = this.now();
    const c = this._bucket(`c:${clientKey}`, CLIENT_WINDOW_MS);
    c.fails++;
    if (c.fails > CLIENT_MAX) {
      // 6th failure -> 1 min, 7th -> 2, 8th -> 4 … capped. The window is not reset
      // until the lock expires, so hammering does not walk the counter backwards.
      const over = c.fails - CLIENT_MAX;
      c.until = t + Math.min(CLIENT_WINDOW_MS * 2 ** (over - 1), CLIENT_MAX_LOCK_MS);
    }
    const p = this._bucket(`p:${peerKey}`, PEER_WINDOW_MS);
    p.fails++;
    if (p.fails > PEER_MAX) p.until = t + PEER_WINDOW_MS;
    return this.check(clientKey, peerKey);
  }

  /** A correct password clears that client's failures (but not the peer tier's). */
  succeed(clientKey) { this.buckets.delete(`c:${clientKey}`); }

  _prune() {
    if (this.buckets.size <= BUCKET_CAP) return;
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.until <= t && t - b.first > Math.max(CLIENT_WINDOW_MS, PEER_WINDOW_MS)) this.buckets.delete(k);
    }
    // Still full of live entries: drop the oldest rather than grow without bound.
    if (this.buckets.size > BUCKET_CAP) {
      const excess = this.buckets.size - BUCKET_CAP;
      let i = 0;
      for (const k of this.buckets.keys()) { if (i++ >= excess) break; this.buckets.delete(k); }
    }
  }
}

// ── cookie plumbing ─────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Parse a Cookie header. Returns {} for anything malformed rather than throwing. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Serialise the session cookie. `secure` follows the REQUEST's protocol, not a guess:
 * behind Lucky the request arrives as HTTPS (X-Forwarded-Proto) and gets Secure; a
 * direct http:// hit from the LAN does not, because a Secure cookie on a plain
 * connection is one the browser will accept and then never send back — which reads as
 * "login silently does nothing".
 */
export function serializeCookie(value, { secure, maxAgeS }) {
  const bits = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeS}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export const clearCookie = ({ secure }) => serializeCookie('', { secure, maxAgeS: 0 });

// ── the gate ────────────────────────────────────────────────────────
/**
 * @param {string|undefined} password  process.env.ADMIN_PASSWORD
 * @returns {{configured:boolean, reason:string|null, issue:Function, verify:Function,
 *           matches:Function, status:Function}}
 */
export function createAuth(password) {
  const disabled = (reason) => ({
    configured: false,
    reason,
    matches: () => false,
    issue: () => { throw new Error('admin not configured'); },
    verify: () => ({ ok: false, reason: 'admin not configured' }),
    revoke: () => false,
    status: () => ({ configured: false }),
  });

  // An empty or whitespace-only value is "unset", not a password — `ADMIN_PASSWORD=`
  // in an env file must not become a login with the empty string.
  if (typeof password !== 'string' || !password.trim()) return disabled('not configured');
  if (password.length < MIN_PASSWORD) {
    return disabled(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);
  }

  const key = scryptSync(password, KEY_SALT, 32, SCRYPT);
  // Revoked session ids (the cookie's nonce) -> the expiry we may forget them at.
  // A signed cookie needs no server-side table to be VERIFIED, but without one "log
  // out" would only mean "delete my copy": a cookie captured beforehand would stay
  // good for the rest of its 12 hours. The map holds one small entry per logout and
  // is pruned by expiry, so it cannot grow without bound. It is deliberately in-memory
  // only — a restart forgets it, which is the same exposure a restart already has
  // (the signing key is derived from the password, not minted per boot).
  const revoked = new Map();
  // Compared as fixed-length digests: timingSafeEqual throws on a length mismatch, and
  // the raw lengths would themselves leak the password's length through that error.
  const expected = createHash('sha256').update(password, 'utf8').digest();

  const sign = (body) => b64u(createHmac('sha256', key).update(body).digest());

  return {
    configured: true,
    reason: null,

    /** Constant-time password check. */
    matches(candidate) {
      if (typeof candidate !== 'string' || !candidate) return false;
      const got = createHash('sha256').update(candidate, 'utf8').digest();
      return timingSafeEqual(got, expected);
    },

    /** @returns {{value:string, expiresAt:number, maxAgeS:number}} */
    issue(now = Date.now()) {
      const exp = now + SESSION_TTL_MS;
      // The nonce makes two sessions issued in the same millisecond distinct; it is not
      // a secret and carries nothing about the password.
      const id = b64u(randomBytes(9));
      const body = `v1.${exp}.${id}`;
      return {
        value: `${body}.${sign(body)}`, id, expiresAt: exp,
        maxAgeS: Math.floor(SESSION_TTL_MS / 1000),
      };
    },

    /** @returns {{ok:true, expiresAt:number} | {ok:false, reason:string}} */
    verify(token, now = Date.now()) {
      if (typeof token !== 'string' || !token) return { ok: false, reason: 'no session' };
      const i = token.lastIndexOf('.');
      if (i < 1) return { ok: false, reason: 'malformed session' };
      const body = token.slice(0, i);
      const sig = token.slice(i + 1);
      if (!body.startsWith('v1.')) return { ok: false, reason: 'unrecognised session' };
      const want = Buffer.from(sign(body), 'utf8');
      const got = Buffer.from(sig, 'utf8');
      // Length first: timingSafeEqual throws on unequal lengths, and a thrown error
      // here would be an exception path an attacker can trigger at will.
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return { ok: false, reason: 'bad signature' };
      }
      const [, expStr, id] = body.split('.');
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || exp <= now) return { ok: false, reason: 'session expired' };
      if (revoked.has(id)) return { ok: false, reason: 'session revoked' };
      return { ok: true, expiresAt: exp, id };
    },

    /** Make one session unusable for the rest of its life. Idempotent; ignores junk. */
    revoke(token, now = Date.now()) {
      const v = this.verify(token, now);
      if (!v.ok) return false;
      revoked.set(v.id, v.expiresAt);
      for (const [k, exp] of revoked) if (exp <= now) revoked.delete(k);
      return true;
    },

    status: () => ({ configured: true }),
  };
}

/**
 * Same-origin check for state-changing requests, working WITH SameSite=Strict rather
 * than instead of it.
 *
 * A missing Origin is allowed on purpose: browsers attach one to every cross-site
 * request that could carry a cookie, so its absence means a non-browser client (curl,
 * a script, a health check) — which has no ambient cookie to abuse in the first place.
 * Refusing those would break every legitimate command-line call while stopping nothing.
 */
export function checkOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return { ok: true };
  let host;
  try { host = new URL(origin).host; } catch { return { ok: false, reason: 'malformed Origin' }; }
  // req.hostname resolves X-Forwarded-Host under trustProxy; the raw Host header is the
  // fallback for a direct hit. Either matching is enough.
  const expected = [req.hostname, req.headers?.host].filter(Boolean);
  if (expected.some((h) => h === host)) return { ok: true };
  return { ok: false, reason: 'cross-origin request refused' };
}
