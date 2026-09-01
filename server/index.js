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
const config = new ConfigStore();
config.start(); // fatal if initial config is invalid

const snapshot = new Snapshot();
const tsdb = new Tsdb(join(DATA_DIR, 'homenet.db'));

// Slice 2: runtime-added targets/cards live in the same db file and are merged onto
// the file config here. Everything downstream (scheduler, publicConfig, frontend)
// reads `effective.get()`, not the raw file config — that is the ONLY read-point
// change this slice makes. With an empty user store buildEffective returns the file
// object itself, so the two are the same reference and the etag is untouched.
const userStore = new UserStore(join(DATA_DIR, 'homenet.db'));
// Slice 2e: credentials live in the same file, encrypted. The vault is opened once at
// startup against VAULT_KEY; with no key it stays locked and every write path refuses,
// which is the whole point — a locked vault must not silently fall back to plaintext.
const credStore = new CredStore(join(DATA_DIR, 'homenet.db'));
const vault = openVault(process.env.VAULT_KEY, credStore);
// The scheduler is built after the vault so the ssh collector can reach it through ctx.
const scheduler = new Scheduler({ snapshot, tsdb, env: process.env, vault, credStore });
console.log(`[vault] ${vault.locked ? `locked — ${vault.reason}` : 'unlocked'}`
  + ` (${credStore.count()} credential(s) stored)`);
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
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' } });

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
}));

app.get('/api/config', async (req, reply) => {
  const pub = publicConfig(effective.get());
  reply.header('ETag', pub.etag);
  reply.header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === pub.etag) return reply.code(304).send();
  return pub;
});

app.get('/api/snapshot', async () => {
  const cfg = effective.get();
  const ids = (cfg.targets.targets || []).filter((t) => t.enabled !== false).map((t) => t.id);
  return snapshot.toJSON(ids);
});

app.get('/api/history', async (req) => {
  const { target, metric, range = '6h' } = req.query || {};
  const since = Math.floor(Date.now() / 1000) - (RANGE_SEC[range] || RANGE_SEC['6h']);
  if (!target) return { target: null, range, series: {} };
  if (metric) return { target, metric, range, points: tsdb.history(target, metric, since) };
  return { target, range, series: tsdb.historyTarget(target, since) };
});

app.get('/api/token_detail', async (req, reply) => {
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

app.get('/api/discover', async (req, reply) => {
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

app.post('/api/credentials', async (req, reply) => {
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

app.get('/api/credentials', async () => ({
  vault: vault.status(),
  types: CRED_TYPES,
  credentials: credStore.list(),
}));

app.delete('/api/credentials/:id', async (req, reply) => {
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
app.post('/api/user_targets', async (req, reply) => {
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

app.get('/api/user_targets', async () => {
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

app.delete('/api/user_targets/:id', async (req, reply) => {
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
