// Fastify entrypoint (§5.1) — config-driven dashboard backend.
// Serves /api/* + the static config-driven frontend. Config is hot-reloaded
// (chokidar) and drives the collector scheduler. SQLite holds the timeseries.
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from './config/watch.js';
import { publicConfig } from './config/loader.js';
import { VERSION } from './version.js';
import { CredStore, validateCredential, CRED_TYPES } from './store/cred_store.js';
import { openVault } from './vault.js';
import {
  createAuth, setupAdminPassword, LoginLimiter, parseCookies, serializeCookie, clearCookie,
  checkOrigin, COOKIE_NAME,
} from './auth.js';
import { checkPrivateClient, forwardedClientAddr } from './net_guard.js';
import { AdminStore } from './store/admin_store.js';
import { Snapshot } from './store/snapshot.js';
import { Tsdb, RANGE_SEC } from './store/sqlite.js';
import { Scheduler } from './collectors/index.js';
import { collectSql, clearQueryCache } from './collectors/sql.js';
import { demoTokenRows } from './collectors/demo.js';
import { pivotTokens, TOKEN_RANGE_DAYS } from './token_detail.js';
import { discoverTarget } from './collectors/discovery.js';
import { UserStore } from './store/user_store.js';
import { EffectiveStore } from './config/effective.js';
import { materialize, originOf } from './capabilities/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3100);

// ── wiring ──────────────────────────────────────────────────────────
// Slice 2: runtime-added targets/cards live in the same db file and are merged onto
// the file config by EffectiveStore below.
// P2: it also holds the `demo_dismissed` flag, and the config loader reads that flag on
// EVERY load — which is why the store is built before ConfigStore rather than after it.
const userStore = new UserStore(join(DATA_DIR, 'homenet.db'));
const config = new ConfigStore({ isDemoDismissed: () => userStore.isDemoDismissed() });
config.start(); // fatal if initial config is invalid

const snapshot = new Snapshot();
const tsdb = new Tsdb(join(DATA_DIR, 'homenet.db'));

// Everything downstream (scheduler, publicConfig, frontend) reads `effective.get()`,
// not the raw file config. With an empty user store buildEffective returns the file
// object itself, so the two are the same reference and the etag is untouched.
// Slice 2e: credentials live in the same file, encrypted. The vault is opened once at
// startup against VAULT_KEY; with no key it stays locked and every write path refuses,
// which is the whole point — a locked vault must not silently fall back to plaintext.
const credStore = new CredStore(join(DATA_DIR, 'homenet.db'));
const vault = openVault(process.env.VAULT_KEY, credStore);
// Admin gate. Read once at startup like the vault key, and like the vault it is
// fail-closed: no ADMIN_PASSWORD means the management endpoints answer 401, never that
// they open up. The dashboard itself stays public unless REQUIRE_LOGIN_TO_VIEW says
// otherwise, so an existing install keeps behaving exactly as it did.
// Slice 2h: the admin password now lives in the database, hashed. ADMIN_PASSWORD only
// bootstraps that row on an install that has none — see auth.js for the priority order
// and the delete-the-row escape hatch.
const adminStore = new AdminStore(join(DATA_DIR, 'homenet.db'));
// `let`, not `const`: the first-run setup endpoint creates the admin_auth row at
// RUNTIME, and this binding is how the whole process learns about it without a restart.
// Every handler below reads through this name rather than capturing the object, so
// re-creating it here takes effect on the next request.
let auth = createAuth(adminStore, process.env.ADMIN_PASSWORD);
// One first-run setup at a time. The database's ON CONFLICT DO NOTHING is what actually
// decides the winner (see auth.js); this flag just stops a second concurrent caller from
// paying for a scrypt derivation before losing.
let setupInFlight = false;
// One limiter for BOTH the login form and the change-password form. They gate the same
// secret, so giving them separate budgets would simply hand an attacker twice the
// attempts by alternating between the two endpoints.
const loginLimiter = new LoginLimiter();
// Setup gets its OWN limiter rather than sharing the login one. The two bound different
// things: the login limiter prices GUESSES at a secret, and must not be walked toward a
// lockout by someone mistyping the confirm box on a brand-new install. This one prices
// scrypt derivations on an endpoint that is reachable before any password exists — so it
// counts every attempt, not just failures. It is also the only limiter whose lockout can
// never strand anyone: once setup succeeds the endpoint is 409 forever anyway.
const setupLimiter = new LoginLimiter();
const REQUIRE_LOGIN_TO_VIEW = /^(1|true|yes|on)$/i.test(String(process.env.REQUIRE_LOGIN_TO_VIEW || '').trim());
// The scheduler is built after the vault so the ssh collector can reach it through ctx.
const scheduler = new Scheduler({ snapshot, tsdb, env: process.env, vault, credStore });
console.log(`[vault] ${vault.locked ? `locked — ${vault.reason}` : 'unlocked'}`
  + ` (${credStore.count()} credential(s) stored)`);
// Never the password, never anything derived from it — only whether one is configured.
console.log(`[auth] admin ${auth.configured ? `configured (${auth.source})` : `DISABLED — ${auth.reason}`}`
  + ` (admin endpoints ${auth.configured ? 'require login' : 'all answer 401'};`
  + ` dashboard ${REQUIRE_LOGIN_TO_VIEW ? 'requires login' : 'public'})`);
if (auth.source === 'env-bootstrap') {
  console.log('[auth] bootstrapped the admin_auth row from ADMIN_PASSWORD;'
    + ' from now on the database is authoritative and editing that env var changes nothing.');
}
const effective = new EffectiveStore({ userStore });
effective.rebuild(config.get());

// One place where a new effective config takes effect, whatever produced it: a YAML
// hot-reload, or a user-data write. Previously this body lived inline in the config
// 'change' handler and a user write would have had to duplicate it.
function applyEffective(next, why) {
  clearQueryCache();
  scheduler.apply(next);
  console.log(`[effective] applied etag=${next.etag} (${why})`);
}

applyEffective(effective.get(), 'boot');

config.on('change', (next) => {
  const r = effective.rebuild(next);
  // A refused rebuild means the FILE edit is fine but the user rows no longer fit it
  // (a deleted metric, a renamed target). effective keeps the previous good document,
  // so the panel stays up on the last thing that validated.
  if (r.ok && !r.changed) return;
  applyEffective(effective.get(), r.ok ? 'config reload' : 'config reload (user rows refused)');
});

/** Rebuild + apply after a user-data write. Returns the rebuild result. */
function refreshUserData(why) {
  const r = effective.rebuild(config.get());
  if (r.ok && r.changed) applyEffective(effective.get(), why);
  return r;
}
// keep running on a bad edit — previous good config stays live (§2)
config.on('invalid', (e) => console.warn(`[config] rejected reload, keeping previous (${e.errors.length} error(s))`));

// B22: fold aged-out raw samples into the 5-minute tier, then sweep the aggregate
// tier's own retention. Raw rows are now dropped only by the rollup, inside the same
// transaction that writes their bucket, so cleanup() no longer touches that table.
// Ticks every minute: in steady state there is at most one 5-minute bucket to move
// (the watermark cannot outrun the clock), and while draining the initial backfill
// rollup() yields the event loop between chunks so collection keeps its cadence.
function rollupTick() {
  tsdb.rollup()
    .then((r) => {
      if (r.buckets) {
        console.log(`[tsdb:rollup] +${r.buckets} bucket(s), -${r.removed} raw row(s)`
          + `${r.done ? '' : ' (backfill continuing)'}`);
      }
    })
    .catch((e) => console.error(`[tsdb:rollup] ${e?.message || e}`));
}
rollupTick();
setInterval(rollupTick, 60 * 1000);

// aggregate-tier retention sweep
tsdb.cleanup();
setInterval(() => tsdb.cleanup(), 3600 * 1000);

// resolve the token target (for /api/token_detail) via the layout token card,
// falling back to the first sql target. Works for both sql and demo sources.
function tokenTarget() {
  const cfg = effective.get();
  const card = (cfg.layout?.grid || []).find((c) => c.type === 'token');
  if (card?.target) {
    const t = (cfg.targets.targets || []).find((x) => x.id === card.target);
    if (t) return t;
  }
  return (cfg.targets.targets || []).find((t) => t.source?.type === 'sql') || null;
}

// ── server ──────────────────────────────────────────────────────────
// trustProxy: this service sits behind Lucky, which terminates TLS and forwards plain
// HTTP to :3100. Without it every request looks like it came from the proxy over http —
// which would put a Secure cookie on nothing and collapse the login rate limit onto one
// IP. With it, req.protocol reflects X-Forwarded-Proto and req.ip the real client.
// The header is only as trustworthy as who can reach the port directly, which is why
// the login limiter also bounds attempts per socket peer (see auth.js).
const app = Fastify({
  trustProxy: true,
  logger: { level: process.env.LOG_LEVEL || 'warn' },
});

// ── admin gate ──────────────────────────────────────────────────────
// Secure follows the request's own protocol rather than a build-time guess: through
// Lucky that is https and the cookie is marked Secure; a direct http://192.168.x.x:3100
// hit from the LAN still gets a working (non-Secure) cookie instead of one the browser
// accepts and never sends back. httpOnly and SameSite=Strict are unconditional.
const isSecureReq = (req) => req.protocol === 'https';

const sessionOf = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);

/** Every management endpoint hangs off this. Unconfigured admin => 401, always. */
async function requireAdmin(req, reply) {
  if (!auth.configured) {
    return reply.code(401).send({ error: 'admin not configured', reason: auth.reason });
  }
  const v = sessionOf(req);
  if (!v.ok) return reply.code(401).send({ error: 'authentication required', reason: v.reason });
}

/**
 * Is this request coming from the local network?
 *
 * Only the first-run setup endpoint asks. It deliberately does NOT use `req.ip`:
 * `trustProxy: true` makes that the LEFTMOST X-Forwarded-For entry, which is whatever
 * the original caller typed. See forwardedClientAddr in net_guard.js for why the
 * rightmost entry is the one that cannot be forged.
 *
 * Both halves must be private: the forwarding chain's last unforgeable hop AND the
 * actual socket peer. Behind a reverse proxy the peer is the proxy (private), and the
 * chain supplies the client; on a direct LAN hit the two are the same address. A public
 * caller fails the first, and a request that somehow reaches the port from outside the
 * LAN fails the second.
 */
function clientIsPrivate(req) {
  const peer = req.socket?.remoteAddress;
  const p = checkPrivateClient(peer);
  if (!p.ok) return { ok: false, reason: p.reason };
  const c = checkPrivateClient(forwardedClientAddr(req.headers?.['x-forwarded-for'], peer));
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, ip: c.ip };
}

/**
 * First-run setup is available only when NOTHING can already manage this install:
 * no admin_auth row and no ADMIN_PASSWORD that would create one. `auth.configured`
 * covers both — the env var bootstraps the row at startup, so an install with the env
 * var set is already configured by the time any request arrives.
 */
const setupAvailable = (req) => !auth.configured && clientIsPrivate(req).ok;

/** Belt to SameSite=Strict's braces, on state-changing requests only. */
async function requireSameOrigin(req, reply) {
  const o = checkOrigin(req);
  if (!o.ok) return reply.code(403).send({ error: 'forbidden', reason: o.reason });
}

/** Optional whole-site privacy. Default off: the board stays public, as before. */
async function requireView(req, reply) {
  if (!REQUIRE_LOGIN_TO_VIEW) return;
  return requireAdmin(req, reply);
}

const ADMIN = { preHandler: requireAdmin };
const ADMIN_WRITE = { preHandler: [requireAdmin, requireSameOrigin] };
const VIEW = { preHandler: requireView };

// B17: gzip. /api/history is ~3.4 MB at range=24h and this shape of JSON (repeated
// numeric samples) compresses ~10x. The reverse proxy in front of us is Lucky on the
// side-router and does not compress, so the encoding is negotiated here instead.
// Registered before any route so its onSend hook covers /api/* and the static files.
await app.register(fastifyCompress, {
  global: true,
  threshold: 1024,                    // below this the CPU is not worth the bytes
  encodings: ['gzip', 'deflate'],     // no brotli: slower, and gzip already gives ~10x
});

app.get('/healthz', async () => ({
  ok: true, service: 'homenet-hub', version: VERSION, ts: Date.now(),
  config: config.health(), effective: effective.health(),
  // Status only: whether a key is configured and, if not, why. Never the key, never a
  // secret, never a ciphertext.
  vault: { ...vault.status(), credentials: credStore.count() },
  // Whether an admin password exists and whether the board is private. Booleans only.
  admin: { ...auth.status(), require_login_to_view: REQUIRE_LOGIN_TO_VIEW },
}));

// ── first-run admin setup ───────────────────────────────────────────
// The one endpoint that can create an admin password without already having one. Every
// other management route is fail-closed against exactly this, so the conditions are
// narrow on purpose and each is checked again here rather than trusted from the caller:
//
//   1. NOT ALREADY CONFIGURED. Checked before the work and enforced again by the
//      database's ON CONFLICT DO NOTHING. Once configured it is 409 forever — there is
//      no reset path through HTTP, by design. Recovery stays `DELETE FROM admin_auth;`
//      plus a restart, which requires access to the host.
//   2. FROM THE LOCAL NETWORK. Someone who finds a fresh install exposed to the
//      internet must not be able to claim it before its owner does. A LAN requirement
//      is not perfect (a hostile device on the LAN beats you to it) but it removes the
//      entire internet from the race.
//   3. RATE LIMITED, counting every attempt — this is the only endpoint that runs
//      scrypt for an unauthenticated caller.
//   4. SAME-ORIGIN, like every other state-changing route.
//
// The password reaches exactly one place, setupAdminPassword(), and is dropped there.
// No branch below puts it, its length, or anything derived from it in a response or a
// log line.
app.post('/api/admin/setup', async (req, reply) => {
  const o = checkOrigin(req);
  if (!o.ok) return reply.code(403).send({ error: 'forbidden', reason: o.reason });

  // Answered before the network check so an already-configured install gives the same
  // 409 to everyone, rather than leaking "you are on the wrong network" to a caller who
  // could not have used the endpoint regardless.
  if (auth.configured) {
    return reply.code(409).send({ error: 'already configured', reason: 'admin is already configured' });
  }

  const net = clientIsPrivate(req);
  if (!net.ok) {
    app.log.warn(`[auth:DENY] first-run setup refused from non-private client (${net.reason})`);
    return reply.code(403).send({
      error: 'forbidden',
      reason: 'first-run setup must be done from the local network',
    });
  }

  const clientKey = net.ip;
  const peerKey = req.socket?.remoteAddress || 'unknown';
  const gate = setupLimiter.check(clientKey, peerKey);
  if (!gate.ok) {
    reply.header('Retry-After', String(gate.retryAfterS));
    return reply.code(429).send({ error: 'too many attempts', retry_after_s: gate.retryAfterS });
  }
  // Counted up front, on every attempt: the cost being bounded here is the scrypt
  // derivation below, which a rejected attempt pays for just the same as a good one.
  setupLimiter.fail(clientKey, peerKey);

  if (setupInFlight) {
    return reply.code(409).send({ error: 'busy', reason: 'a setup is already in progress' });
  }
  setupInFlight = true;
  try {
    const r = await setupAdminPassword(adminStore, req.body?.password, req.body?.confirm);
    if (!r.ok) {
      if (r.code === 'already_configured') {
        return reply.code(409).send({ error: 'already configured', reason: r.reason });
      }
      return reply.code(400).send({ error: r.code, reason: r.reason });
    }
    // Re-create the gate so it picks up the row that now exists. Re-reading rather than
    // patching state by hand: whatever is in the database is what every later request
    // will be judged against, including the signing secret this session is about to be
    // signed with.
    auth = createAuth(adminStore, process.env.ADMIN_PASSWORD);
    if (!auth.configured) {
      // Should be unreachable — the row was just written. Fail closed rather than
      // pretend, so nobody ends up holding a "success" with no way back in.
      return reply.code(500).send({ error: 'setup failed', reason: 'admin row could not be read back' });
    }
    const sess = auth.issue();
    reply.header('set-cookie', serializeCookie(sess.value,
      { secure: isSecureReq(req), maxAgeS: sess.maxAgeS }));
    app.log.warn(`[auth] admin configured via first-run setup from ${clientKey}`);
    console.log('[auth] admin configured via first-run setup;'
      + ' the database is authoritative from here and ADMIN_PASSWORD changes nothing.');
    return { ok: true, authenticated: true, expires_at: sess.expiresAt };
  } finally {
    setupInFlight = false;
  }
});

// ── admin login ─────────────────────────────────────────────────────
// The password never leaves this handler: it is compared in constant time and dropped.
// Nothing about it — not its value, not its length, not a hash — reaches the response,
// the log line, or an error. A failed attempt says only "invalid password".
app.post('/api/login', async (req, reply) => {
  if (!auth.configured) {
    return reply.code(401).send({ error: 'admin not configured', reason: auth.reason });
  }
  const o = checkOrigin(req);
  if (!o.ok) return reply.code(403).send({ error: 'forbidden', reason: o.reason });

  // req.ip is the real client under trustProxy; the socket peer is the second tier,
  // which is what bounds someone rotating X-Forwarded-For (see auth.js).
  const clientKey = req.ip || 'unknown';
  const peerKey = req.socket?.remoteAddress || 'unknown';

  const gate = loginLimiter.check(clientKey, peerKey);
  if (!gate.ok) {
    reply.header('Retry-After', String(gate.retryAfterS));
    return reply.code(429).send({ error: 'too many attempts', retry_after_s: gate.retryAfterS });
  }

  const password = req.body?.password;
  if (!(await auth.matches(typeof password === 'string' ? password : ''))) {
    const after = loginLimiter.fail(clientKey, peerKey);
    // The IP, never the attempt's content.
    app.log.warn(`[auth:DENY] failed admin login from ${clientKey}`);
    if (!after.ok) reply.header('Retry-After', String(after.retryAfterS));
    return reply.code(401).send({
      error: 'invalid password',
      ...(after.ok ? {} : { retry_after_s: after.retryAfterS }),
    });
  }

  loginLimiter.succeed(clientKey);
  const s = auth.issue();
  reply.header('set-cookie', serializeCookie(s.value, { secure: isSecureReq(req), maxAgeS: s.maxAgeS }));
  return { ok: true, authenticated: true, expires_at: s.expiresAt };
});

// Idempotent, and deliberately not behind requireAdmin: clearing a cookie you may no
// longer have a valid session for must still work.
app.post('/api/logout', async (req, reply) => {
  const o = checkOrigin(req);
  if (!o.ok) return reply.code(403).send({ error: 'forbidden', reason: o.reason });
  // Revoke, don't just unset. Clearing the cookie only disposes of the copy the caller
  // is holding; a session cookie captured before the logout would otherwise stay valid
  // for the rest of its 12 hours, which is not what anyone means by "log out".
  auth.revoke(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  reply.header('set-cookie', clearCookie({ secure: isSecureReq(req) }));
  return { ok: true, authenticated: false };
});

// ── change the admin password ───────────────────────────────────────
// ADMIN_WRITE (session + same-origin) is the floor, not the whole gate: this endpoint
// also takes the current password, which makes it a second place someone can guess at
// that secret. It therefore shares the LOGIN limiter — separate budgets would let an
// attacker alternate endpoints for twice the attempts against one password.
//
// Neither password appears in the response, the log line, or an error. The failure
// codes are about WHICH rule was broken, never about what was submitted.
app.post('/api/admin/password', ADMIN_WRITE, async (req, reply) => {
  const clientKey = req.ip || 'unknown';
  const peerKey = req.socket?.remoteAddress || 'unknown';

  const gate = loginLimiter.check(clientKey, peerKey);
  if (!gate.ok) {
    reply.header('Retry-After', String(gate.retryAfterS));
    return reply.code(429).send({ error: 'too many attempts', retry_after_s: gate.retryAfterS });
  }

  const r = await auth.changePassword(req.body?.current_password, req.body?.new_password);
  if (!r.ok) {
    // Only a wrong CURRENT password is an authentication failure worth counting. A new
    // password that is too short is the caller's own typo about their own account and
    // must not walk them into a lockout.
    if (r.code === 'invalid_current') {
      const after = loginLimiter.fail(clientKey, peerKey);
      app.log.warn(`[auth:DENY] failed password change from ${clientKey}`);
      if (!after.ok) reply.header('Retry-After', String(after.retryAfterS));
      return reply.code(401).send({
        error: 'invalid current password',
        ...(after.ok ? {} : { retry_after_s: after.retryAfterS }),
      });
    }
    // 'busy' is a concurrency collision, not bad input — 409 so a client can retry.
    if (r.code === 'busy') return reply.code(409).send({ error: r.code, reason: r.reason });
    return reply.code(400).send({ error: r.code, reason: r.reason });
  }

  loginLimiter.succeed(clientKey);
  // The change rotated the signing secret, so the cookie this caller arrived with is
  // already dead. Hand back a new one in the same response: the person who changed the
  // password is the one session that must survive their own change.
  reply.header('set-cookie', serializeCookie(r.session.value,
    { secure: isSecureReq(req), maxAgeS: r.session.maxAgeS }));
  app.log.warn(`[auth] admin password changed from ${clientKey}; all other sessions invalidated`);
  return { ok: true, authenticated: true, expires_at: r.session.expiresAt,
    other_sessions_invalidated: true };
});

// Booleans only — no expiry, no username, nothing that describes the credential. The
// frontend needs exactly two facts: may I show the admin controls, and is there an
// admin password at all (so it can say "not configured" instead of offering a login
// box that can never succeed).
app.get('/api/session', async (req) => ({
  authenticated: auth.configured ? sessionOf(req).ok : false,
  configured: auth.configured,
  // Whether the first-run wizard is offerable to THIS caller: unconfigured AND on the
  // LAN. A public caller on an unconfigured install sees false and is shown the login
  // box's "not configured" message, same as before this endpoint existed.
  setup_available: setupAvailable(req),
}));

// ── clear the shipped demo board ────────────────────────────────────
// A fresh `docker compose up` boots on config.example/, so the first thing anyone sees
// is somebody else's machines. This is the one button that makes that stop, for good.
//
// It writes a flag rather than deleting anything: config.example/ ships in the image and
// is not ours to remove, and config/ may be a read-only mount. The loader then keeps
// falling back for metric templates and theme — without those there is nothing to render
// a user's own card WITH — but empties the example board itself.
//
// Idempotent: the value is a constant, so calling it twice is calling it once. It is a
// management action (ADMIN_WRITE = session + same-origin) because it changes what every
// visitor to this install sees, not just the caller's own browser.
app.post('/api/demo/dismiss', ADMIN_WRITE, async () => {
  const already = userStore.isDemoDismissed();
  userStore.dismissDemo();
  // chokidar cannot see a database write, so nothing would reload on its own: ask for
  // the reload explicitly. It goes through the same validation gate as a YAML edit, and
  // the 'change' listener above rebuilds the effective config and reschedules the
  // collectors — the demo targets stop being polled as well as stop being drawn.
  config.reload('demo dismissed');
  if (already) return { ok: true, dismissed: true, changed: false };
  console.log('[demo] demo board dismissed; config.example targets/layout will no longer be served');
  return { ok: true, dismissed: true, changed: true };
});

app.get('/api/config', VIEW, async (req, reply) => {
  const pub = publicConfig(effective.get());
  reply.header('ETag', pub.etag);
  reply.header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === pub.etag) return reply.code(304).send();
  return pub;
});

app.get('/api/snapshot', VIEW, async () => {
  const cfg = effective.get();
  const ids = (cfg.targets.targets || []).filter((t) => t.enabled !== false).map((t) => t.id);
  return snapshot.toJSON(ids);
});

app.get('/api/history', VIEW, async (req) => {
  const { target, metric, range = '6h' } = req.query || {};
  const since = Math.floor(Date.now() / 1000) - (RANGE_SEC[range] || RANGE_SEC['6h']);
  if (!target) return { target: null, range, series: {} };
  if (metric) return { target, metric, range, points: tsdb.history(target, metric, since) };
  return { target, range, series: tsdb.historyTarget(target, since) };
});

app.get('/api/token_detail', VIEW, async (req, reply) => {
  const range = (req.query?.range) || '24h';
  const days = TOKEN_RANGE_DAYS[range] || 1;
  const tt = tokenTarget();
  if (!tt) return reply.code(404).send({ error: 'no sql token target configured' });
  const tokenCard = (effective.get().layout?.grid || []).find((c) => c.type === 'token');
  try {
    const rows = tt.source?.type === 'demo'
      ? demoTokenRows(tt.classify, days)
      : await collectSql(tt.source, process.env, days);
    return { range, ...pivotTokens(rows, { classify: tt.classify, totalLabel: tokenCard?.labels?.total }) };
  } catch (e) {
    reply.code(502);
    return { range, error: String(e?.message || e), columns: [], spark: [], table: [], series: { days: [], classes: [], matrix: {} } };
  }
});

// ── read-only discovery (slice 1) ───────────────────────────────────
// Answers "what could I monitor at this IP?" — probes only, no writes: nothing here
// touches the scheduler, the config or the tsdb. Two guards keep it from being turned
// into an internal port scanner: at most DISCOVER_MAX_INFLIGHT runs at once, and a
// repeat of the same IP inside DISCOVER_TTL_MS is served the previous manifest rather
// than re-probing. The host itself is validated inside discoverTarget (net_guard).
const DISCOVER_MAX_INFLIGHT = 3;
const DISCOVER_TTL_MS = 5000;
let discoverInflight = 0;
const discoverCache = new Map();   // ip -> { at, manifest }

app.get('/api/discover', ADMIN, async (req, reply) => {
  const host = req.query?.host;
  const cached = discoverCache.get(String(host || '').trim());
  if (cached && Date.now() - cached.at < DISCOVER_TTL_MS) {
    reply.header('X-Discovery-Cache', 'hit');
    return cached.manifest;
  }
  if (discoverInflight >= DISCOVER_MAX_INFLIGHT) {
    reply.code(429);
    return { error: 'too many discoveries in flight', limit: DISCOVER_MAX_INFLIGHT, host: host ?? null };
  }
  discoverInflight++;
  try {
    const manifest = await discoverTarget(host);
    // Key the cache on the canonical IP the guard returned, not on the raw query.
    discoverCache.set(manifest.host, { at: Date.now(), manifest });
    if (discoverCache.size > 256) {
      for (const [k, v] of discoverCache) if (Date.now() - v.at > DISCOVER_TTL_MS) discoverCache.delete(k);
    }
    return manifest;
  } catch (e) {
    if (e?.code === 'EHOSTNOTALLOWED') {
      reply.code(400);
      return { error: 'host rejected', reason: String(e.message), host: host ?? null };
    }
    reply.code(502);
    return { error: 'discovery failed', reason: String(e?.message || e), host: host ?? null };
  } finally {
    discoverInflight--;
  }
});

// ── credentials (slice 2e) ──────────────────────────────────────────
// A write-only door. `secret` goes in and is encrypted before it touches the database;
// nothing in this file ever sends one back out, in any shape — not plaintext, not
// ciphertext, not in an error message. The listing query does not even SELECT the
// column. To use a credential later, a collector decrypts it in memory at connect time.
const vaultLocked = (reply) => {
  reply.code(503);
  return { error: 'vault not configured', reason: vault.reason, hint: 'set VAULT_KEY and restart' };
};

app.post('/api/credentials', ADMIN_WRITE, async (req, reply) => {
  if (vault.locked) return vaultLocked(reply);
  const v = validateCredential(req.body);
  // Note what is NOT here: req.body is never spread into the response, so a rejected
  // request cannot bounce the secret back to the caller (or into an access log).
  if (!v.ok) { reply.code(400); return { error: 'rejected', reason: v.reason }; }
  try {
    const enc = vault.encrypt(v.secret);
    const row = credStore.insert({ name: v.name, type: v.type, username: v.username }, enc);
    return { id: row.id, name: row.name, type: row.type, username: row.username };
  } catch (e) {
    if (String(e?.message || '').includes('UNIQUE')) {
      reply.code(409);
      return { error: 'a credential with that name already exists', name: v.name };
    }
    reply.code(500);
    // Generic on purpose: a crypto or driver error must not carry fragments of input.
    return { error: 'could not store credential' };
  }
});

app.get('/api/credentials', ADMIN, async () => ({
  vault: vault.status(),
  types: CRED_TYPES,
  credentials: credStore.list(),
}));

app.delete('/api/credentials/:id', ADMIN_WRITE, async (req, reply) => {
  const id = req.params.id;
  if (!credStore.get(id)) { reply.code(404); return { error: 'no such credential', id }; }
  // Refuse while something still points at it. Slice 2f is what will create those
  // references; the check ships now so the first target that uses one cannot be
  // orphaned by a delete that happened to land first.
  const users = userStore.getUserConfig().targets
    .filter((t) => t.credential_id === id || t.source?.credential_id === id)
    .map((t) => t.id);
  if (users.length) {
    reply.code(409);
    return { error: 'credential is in use', id, used_by: users };
  }
  const out = credStore.remove(id);
  return { ok: true, ...out, id };
});

// ── user targets (slice 2b) ─────────────────────────────────────────
// Materialise a discovered capability into a persisted {target, card}.
//
// The client sends { host, capability, name? } and NOTHING else that reaches the
// database. `source` is built by the catalog from constants — accepting one from the
// caller would make this endpoint "run this command on a timer for me", since a
// target's source is exactly what the scheduler executes. The host goes through
// net_guard and the port through discovery's bounded set, both inside materialize().
app.post('/api/user_targets', ADMIN_WRITE, async (req, reply) => {
  const { host, capability, name, credential_id: credentialId } = req.body || {};
  // A credential-backed capability is checked against the vault BEFORE anything is
  // built: the id must name a credential that exists, and the vault must be open — a
  // target referencing an unopenable secret would poll forever and fail every time.
  if (credentialId != null) {
    if (vault.locked) return vaultLocked(reply);
    if (!credStore.get(String(credentialId))) {
      reply.code(400);
      return { error: 'rejected', reason: `no such credential: ${String(credentialId).slice(0, 40)}`, applied: false };
    }
  }
  const built = materialize({ host, capability, name, credentialId });
  if (!built.ok) {
    if (built.needsCredential && vault.locked) return vaultLocked(reply);
    reply.code(400);
    return {
      error: built.pending ? 'not materializable yet' : 'rejected',
      reason: built.reason, applied: false,
      ...(built.needsCredential ? { needs_credential: true } : {}),
    };
  }
  const { id, target, card } = built;
  try {
    const cur = userStore.getUserConfig();
    // The id is deterministic, so "already added" is a plain lookup — no separate
    // dedupe key, and re-adding cannot silently duplicate a card.
    if (cur.targets.some((t) => t.id === id)) {
      reply.code(409);
      return { error: 'capability already added on this host', id, applied: false };
    }
    const proposed = { targets: [...cur.targets, target], cards: [...cur.cards, card] };
    const pre = effective.preflight(config.get(), proposed);
    if (!pre.ok) { reply.code(400); return { error: 'rejected', errors: pre.errors, applied: false }; }

    userStore.upsertTarget(id, target);
    userStore.upsertCard(`${id}_card`, card);
    const r = refreshUserData(`add ${capability} on ${built.target._origin.host}`);
    return { ok: r.ok, applied: r.ok, id, etag: effective.get().etag, ...(r.ok ? {} : { errors: r.errors }) };
  } catch (e) {
    reply.code(400);
    return { error: 'write failed', reason: String(e?.message || e), applied: false };
  }
});

app.get('/api/user_targets', VIEW, async () => {
  const { targets } = userStore.getUserConfig();
  return {
    targets: targets.map((t) => ({
      id: t.id,
      name: t.name || t.id,
      enabled: t.enabled !== false,
      ...(originOf(t) || { host: null, capability: null, added_at: null }),
    })),
  };
});

app.delete('/api/user_targets/:id', ADMIN_WRITE, async (req, reply) => {
  try {
    const out = userStore.deleteTarget(req.params.id);
    if (!out.removed) { reply.code(404); return { error: 'no such user target', id: req.params.id }; }
    const r = refreshUserData(`delete ${req.params.id}`);
    return { ok: true, ...out, etag: effective.get().etag, rebuild_ok: r.ok };
  } catch (e) {
    reply.code(400);
    return { error: 'delete failed', reason: String(e?.message || e) };
  }
});

app.post('/api/push/:targetId', async (req, reply) => {
  const id = req.params.targetId;
  const target = scheduler.getPushTarget(id);
  if (!target) return reply.code(404).send({ error: `unknown push target: ${id}` });
  const v = scheduler.validatePush(target, req.headers['x-push-token']);
  if (!v.ok) {
    app.log.warn(`[push:DENY] ${id}: ${v.reason}`);
    return reply.code(401).send({ error: 'unauthorized', reason: v.reason });
  }
  // §7.1 400 层:JSON 结构 / 体积 / 必填字段 / id 一致性
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ ok: false, error: 'body must be a JSON object' });
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 8192) {
    return reply.code(400).send({ ok: false, error: 'payload exceeds 8192 bytes' });
  }
  for (const f of ['v', 'id', 'ts', 'os', 'gpus']) {
    if (body[f] === undefined) {
      return reply.code(400).send({ ok: false, error: `missing required field: ${f}` });
    }
  }
  if (body.id !== id) {
    return reply.code(400).send({ ok: false, error: `id mismatch: body.id=${body.id} != :targetId=${id}` });
  }
  scheduler.handlePush(target, body);
  return { ok: true, target: id, ts: Date.now() };
});

// static frontend (config-driven; rendered client-side)
// §B5 cache-busting: serve static with `no-cache` so the browser revalidates
// every asset (incl. the whole ES-module import graph) via ETag — after a deploy
// changed files return 200 fresh, unchanged return 304. No hard-refresh needed.
await app.register(fastifyStatic, {
  root: WEB_DIR,
  index: ['index.html'],
  cacheControl: false, // we set our own header below; ETag/Last-Modified stay on
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
});

// ── lifecycle ───────────────────────────────────────────────────────
async function shutdown(sig) {
  app.log.warn(`[shutdown] ${sig}`);
  scheduler.stop();
  await config.stop();
  tsdb.close();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => {
    console.log(`[homenet-hub] listening on ${addr}`);
    console.log(`[homenet-hub] config etag=${effective.get().etag} sqlite=${join(DATA_DIR, 'homenet.db')}`);
  })
  .catch((err) => { console.error(err); process.exit(1); });
