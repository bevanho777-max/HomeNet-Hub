// Admin authentication — password gate for the management endpoints.
// SECURITY CRITICAL, and deliberately fail-closed everywhere.
//
// The contract this file exists to keep:
//   - NO password source at all means every admin endpoint answers 401. It never means
//     "open". An unconfigured install is locked, not permissive — the opposite choice
//     would turn a forgotten env var into a public write API;
//   - the password is compared against a stored scrypt hash and never written, logged,
//     echoed or returned. Nothing derived from it leaves the process;
//   - a session is a SIGNED cookie, not a server-side table. The signing key is a
//     random secret in the database (see store/admin_store.js for why it is NOT derived
//     from the password hash), so a restart or a rebuild does not log anyone out, while
//     changing the password rotates the secret and invalidates every outstanding
//     session in one step;
//   - one byte of tampering anywhere in the cookie fails verification.
//
// Where the password lives, in priority order:
//   1. the `admin_auth` row in data/homenet.db — authoritative once it exists;
//   2. ADMIN_PASSWORD, used ONLY to bootstrap that row on an install that has none.
//      After bootstrap the env var is inert: it does not override, and editing it does
//      not change the password;
//   3. neither → locked, every management endpoint 401.
//
// Escape hatch: `DELETE FROM admin_auth;` and restart — the next boot re-bootstraps
// from ADMIN_PASSWORD. That is the documented recovery for a forgotten password, and
// it is why the env var is still read after bootstrap.
//
// Why scrypt rather than the sha256 comparison this file used before: the digest is now
// at rest in a database file that travels in backups. A bare sha256 of a password is
// trivially attacked offline; scrypt with a per-install random salt prices that attack.
// The verification is ASYNC (node's threadpool) because ~60-100ms of key derivation on
// the event loop, once per login attempt, is a denial-of-service lever that the rate
// limiter alone should not have to carry.
import { scrypt, scryptSync, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { newSalt } from './store/admin_store.js';

export const COOKIE_NAME = 'hnh_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // 12h
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_LEN = 32;
export const MIN_PASSWORD = 8;
// A cap, because verification is now a real key derivation rather than a hash: an
// unbounded password would let one request buy an arbitrary amount of scrypt work.
// Applied identically on login, on bootstrap and on change, so a password that can be
// set is always a password that can be used.
export const MAX_PASSWORD = 256;

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

// ── password hashing ────────────────────────────────────────────────
/** Length + type gate, applied identically wherever a password is accepted. */
export function validatePassword(pw) {
  if (typeof pw !== 'string' || !pw) return { ok: false, reason: 'password is required' };
  if (pw.length < MIN_PASSWORD) return { ok: false, reason: `password must be at least ${MIN_PASSWORD} characters` };
  if (pw.length > MAX_PASSWORD) return { ok: false, reason: `password must be at most ${MAX_PASSWORD} characters` };
  return { ok: true };
}

/** Async so a login attempt costs threadpool time, not event-loop time. */
const hash = (password, salt) => new Promise((resolve, reject) => {
  scrypt(password, salt, HASH_LEN, SCRYPT, (e, dk) => (e ? reject(e) : resolve(dk)));
});

/** Bootstrap runs once at startup, where blocking is free and simpler than awaiting. */
const hashSync = (password, salt) => scryptSync(password, salt, HASH_LEN, SCRYPT);

// ── the gate ────────────────────────────────────────────────────────
/**
 * @param {{get:Function, bootstrap:Function, setPassword:Function}} store  AdminStore
 * @param {string|undefined} envPassword  process.env.ADMIN_PASSWORD, bootstrap only
 * @returns {{configured:boolean, reason:string|null, source:string|null, issue:Function,
 *           verify:Function, matches:Function, changePassword:Function, revoke:Function,
 *           status:Function}}
 */
export function createAuth(store, envPassword) {
  const disabled = (reason) => ({
    configured: false,
    reason,
    source: null,
    matches: async () => false,
    issue: () => { throw new Error('admin not configured'); },
    verify: () => ({ ok: false, reason: 'admin not configured' }),
    changePassword: async () => ({ ok: false, reason: 'admin not configured' }),
    revoke: () => false,
    status: () => ({ configured: false }),
  });

  let row = store.get();
  let source = 'db';

  if (!row) {
    // Bootstrap. An empty or whitespace-only value is "unset", not a password —
    // `ADMIN_PASSWORD=` in an env file must not become a login with the empty string.
    if (typeof envPassword !== 'string' || !envPassword.trim()) return disabled('not configured');
    const v = validatePassword(envPassword);
    // A rejected env password does NOT bootstrap: a too-short value must leave the
    // install locked rather than install a password nobody can then change to.
    if (!v.ok) return disabled(`ADMIN_PASSWORD rejected: ${v.reason}`);
    const salt = newSalt();
    store.bootstrap({ passwordHash: hashSync(envPassword, salt), salt });
    // Re-read rather than trusting the write: on the losing side of a race between two
    // boots, DO NOTHING left the other one's row in place and that is the row whose
    // signing secret matters.
    row = store.get();
    if (!row) return disabled('admin row could not be created');
    source = 'env-bootstrap';
  }

  // Mutable so changePassword can rotate them in place: every closure below reads
  // through these bindings, so a rotation takes effect for the next request with no
  // object to re-wire.
  let { passwordHash, salt, signingSecret } = row;

  // Revoked session ids (the cookie's nonce) -> the expiry we may forget them at.
  // A signed cookie needs no server-side table to be VERIFIED, but without one "log
  // out" would only mean "delete my copy": a cookie captured beforehand would stay
  // good for the rest of its 12 hours. The map holds one small entry per logout and
  // is pruned by expiry, so it cannot grow without bound. It is deliberately in-memory
  // only — a restart forgets it, which is the same exposure a restart already has
  // (the signing secret is persisted, not minted per boot).
  let revoked = new Map();
  // changePassword has an `await` between "is the current password right" and "write the
  // new one", so two concurrent calls can both pass the check and then both write. The
  // second write wins in the database AND in memory, which leaves the FIRST caller
  // holding a 200 and a cookie signed with a secret that no longer exists — a dead
  // session reported as a success. One in-flight change at a time removes the whole
  // class; a second concurrent attempt is told to retry rather than silently losing.
  let changing = false;

  const sign = (body) => b64u(createHmac('sha256', signingSecret).update(body).digest());

  const issue = (now = Date.now()) => {
    const exp = now + SESSION_TTL_MS;
    // The nonce makes two sessions issued in the same millisecond distinct; it is not
    // a secret and carries nothing about the password.
    const id = b64u(randomBytes(9));
    const body = `v1.${exp}.${id}`;
    return {
      value: `${body}.${sign(body)}`, id, expiresAt: exp,
      maxAgeS: Math.floor(SESSION_TTL_MS / 1000),
    };
  };

  return {
    configured: true,
    reason: null,
    /** 'db' or 'env-bootstrap'. For the startup log line only — never served. */
    source,

    /**
     * Constant-time password check against the stored hash.
     * Rejects an over-long candidate BEFORE deriving, so the cap is a real bound on the
     * work one request can buy rather than a validation nicety.
     */
    async matches(candidate) {
      if (typeof candidate !== 'string' || !candidate) return false;
      if (candidate.length > MAX_PASSWORD) return false;
      let got;
      try { got = await hash(candidate, salt); } catch { return false; }
      // Both sides are fixed-length scrypt output, so timingSafeEqual cannot throw on a
      // length mismatch and no length information is in play.
      return got.length === passwordHash.length && timingSafeEqual(got, passwordHash);
    },

    /** @returns {{value:string, expiresAt:number, maxAgeS:number}} */
    issue,

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

    /**
     * Change the password: verify the current one, re-hash the new one under a FRESH
     * salt, and rotate the signing secret in the same write.
     *
     * Rotating the secret is what makes every other session die — not a revocation
     * list, which could not cover sessions this process never saw (another replica, a
     * cookie captured off the wire). The caller gets a freshly issued session back so
     * the person doing the change is not logged out by their own action.
     *
     * Returns a reason, never a value: no branch of this function can put either
     * password into a response.
     *
     * @returns {{ok:true, session:object} | {ok:false, reason:string, code:string}}
     */
    async changePassword(current, next) {
      if (changing) return { ok: false, code: 'busy', reason: 'a password change is already in progress' };
      changing = true;
      try {
        return await this._changePassword(current, next);
      } finally {
        changing = false;
      }
    },

    async _changePassword(current, next) {
      if (!(await this.matches(typeof current === 'string' ? current : ''))) {
        return { ok: false, code: 'invalid_current', reason: 'current password is incorrect' };
      }
      const v = validatePassword(next);
      if (!v.ok) return { ok: false, code: 'invalid_new', reason: v.reason };
      // A no-op change would still rotate the secret and kick every other session, which
      // is a surprising amount of damage for a mistyped form.
      if (next === current) {
        return { ok: false, code: 'unchanged', reason: 'new password must differ from the current one' };
      }
      const nextSalt = newSalt();
      const nextHash = await hash(next, nextSalt);
      const nextSecret = store.setPassword({ passwordHash: nextHash, salt: nextSalt });
      passwordHash = nextHash;
      salt = nextSalt;
      signingSecret = nextSecret;
      // Every id in here was signed with the old secret and can no longer verify, so the
      // map is dead weight rather than protection.
      revoked = new Map();
      return { ok: true, session: issue() };
    },

    status: () => ({ configured: true }),
  };
}

// ── first run ───────────────────────────────────────────────────────
/**
 * Create the admin_auth row from a password chosen in the UI, on an install that has
 * none. This is the THIRD and last way that row can come into existence, and it is
 * deliberately the same write as the other two: scrypt over a fresh random salt, then
 * `store.bootstrap`, which is INSERT ... ON CONFLICT DO NOTHING.
 *
 * That conflict clause is the real race-breaker, not the caller's in-process flag. Two
 * requests (or two processes sharing the database file) can both pass a "not configured
 * yet" check and both arrive here; exactly one INSERT reports `changes === 1`, and the
 * other is told the install is already configured. The flag upstream only saves the
 * loser from paying for a scrypt derivation first.
 *
 * Deriving asynchronously — unlike the startup bootstrap, which may block because
 * nothing else is running yet — because this one is reachable by an HTTP request, and
 * ~100ms of key derivation on the event loop per request is a lever worth not handing out.
 *
 * The password is read, hashed, and dropped. No branch of this function returns it,
 * logs it, or puts anything derived from it into the result.
 *
 * @param {{bootstrap:Function}} store  AdminStore
 * @param {unknown} password
 * @param {unknown} confirm
 * @returns {Promise<{ok:true} | {ok:false, code:string, reason:string}>}
 */
export async function setupAdminPassword(store, password, confirm) {
  const v = validatePassword(password);
  if (!v.ok) return { ok: false, code: 'invalid_password', reason: v.reason };
  // Compared here as well as in the browser, because the browser's copy of this rule is
  // a convenience and this one is the rule.
  if (typeof confirm !== 'string' || password !== confirm) {
    return { ok: false, code: 'mismatch', reason: 'the two passwords do not match' };
  }
  const salt = newSalt();
  const passwordHash = await hash(password, salt);
  if (!store.bootstrap({ passwordHash, salt })) {
    return { ok: false, code: 'already_configured', reason: 'admin is already configured' };
  }
  return { ok: true };
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
