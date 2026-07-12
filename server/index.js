// Fastify entrypoint (§5.1) — config-driven dashboard backend.
// Serves /api/* + the static config-driven frontend. Config is hot-reloaded
// (chokidar) and drives the collector scheduler. SQLite holds the timeseries.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from './config/watch.js';
import { Snapshot } from './store/snapshot.js';
import { Tsdb, RANGE_SEC } from './store/sqlite.js';
import { Scheduler } from './collectors/index.js';
import { collectSql, clearQueryCache } from './collectors/sql.js';
import { demoTokenRows } from './collectors/demo.js';
import { pivotTokens, TOKEN_RANGE_DAYS } from './token_detail.js';

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
const scheduler = new Scheduler({ snapshot, tsdb, env: process.env });
scheduler.apply(config.get());

config.on('change', (next) => {
  clearQueryCache();
  scheduler.apply(next);
});
// keep running on a bad edit — previous good config stays live (§2)
config.on('invalid', (e) => console.warn(`[config] rejected reload, keeping previous (${e.errors.length} error(s))`));

// timeseries retention sweep
tsdb.cleanup();
setInterval(() => tsdb.cleanup(), 3600 * 1000);

// resolve the token target (for /api/token_detail) via the layout token card,
// falling back to the first sql target. Works for both sql and demo sources.
function tokenTarget() {
  const cfg = config.get();
  const card = (cfg.layout?.grid || []).find((c) => c.type === 'token');
  if (card?.target) {
    const t = (cfg.targets.targets || []).find((x) => x.id === card.target);
    if (t) return t;
  }
  return (cfg.targets.targets || []).find((t) => t.source?.type === 'sql') || null;
}

// ── server ──────────────────────────────────────────────────────────
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' } });

app.get('/healthz', async () => ({ ok: true, service: 'homenet-hub', ts: Date.now(), config: config.health() }));

app.get('/api/config', async (req, reply) => {
  const pub = config.getPublic();
  reply.header('ETag', pub.etag);
  reply.header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === pub.etag) return reply.code(304).send();
  return pub;
});

app.get('/api/snapshot', async () => {
  const cfg = config.get();
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
  const tokenCard = (config.get().layout?.grid || []).find((c) => c.type === 'token');
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
    console.log(`[homenet-hub] config etag=${config.get().etag} sqlite=${join(DATA_DIR, 'homenet.db')}`);
  })
  .catch((err) => { console.error(err); process.exit(1); });
