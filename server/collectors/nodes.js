// inference_nodes collector — the data behind the 推理节点 / Inference Nodes card that is
// not a plain probe or speed query.
//
//   • TOTAL usage today (Beijing day), from the inference servers' own cumulative counters
//     in Prometheus (v2.22). Requests that hit a machine directly, without LiteLLM, are
//     counted too — that is the point: the LiteLLM database never sees them.
//       Exact, not increase(): the raw samples since local midnight are fetched and summed
//       sample to sample. A drop means the server restarted and its counter began again at
//       0, so the new value is added in full — a restart neither loses usage nor goes
//       negative. The last sample before midnight is the baseline; a series that did not
//       exist before midnight starts from 0. (increase() would extrapolate to the window
//       edges and return fractions.)
//   • of which VIA LiteLLM, from LiteLLM_SpendLogs (queries/node_usage.sql): one row per
//     request with the backend's api_base, matched on host:port to the node's `endpoints`
//     (chat) or `embed_endpoints` (embedding).
//   • which litellm instance(s) route to the node: GET <instance>/model/info, matched on
//     api_base host:port. Each instance may declare the nodes it is MEANT to serve
//     (`serves`); a live route to any other node is reported as stale ("to be removed").
//
// Metrics (numbers; written to the timeseries, charted by the node modal). A metric whose
// source does not exist for that node (llama.cpp has no request counter) is left out:
//   <node>_reqs  <node>_tokens            total, from Prometheus counters
//   <node>_emb_reqs  <node>_emb_tokens    embedding total (counters.embed_*), if declared
//   <node>_ll_reqs  <node>_ll_tokens      via LiteLLM (chat endpoints)
//   <node>_emb_ll_reqs  <node>_emb_ll_tokens   via LiteLLM (embed endpoints), if any
//   unassigned_ll_reqs  unassigned_ll_tokens   LiteLLM rows that reached no known node
// extra.nodes[<node>] = { routes: [{port, intended, public}], ports, public, counters: {...} }
//
// v2.29 a counter only counts while it is collected. For each counter the samples since
// midnight give its COVERAGE: from midnight when the series ran through it, else from the
// server's start (llama-log-exporter.py publishes it -- the mirror's process start, a unit's
// invocation start -- so a server restarted at 04:35 whose first scrape is at 21:00 still
// counts from 04:35), else from its first sample; it ends at the last sample (a dead series,
// a scrape that broke) and has a hole where the counter dropped across a missing stretch.
// Today's figure = the counter + the LiteLLM requests (that produced tokens) in the minutes
// it did not cover, so a gap never shows as missing usage. A counter is reported as broken
// (counters.kinds[k].error, the card says "Counter error") when it could not be read, when
// the node's engine is up but Prometheus does not scrape it, or when it counts less than
// LiteLLM delivered to the node while it was covering (the last 2 minutes left out: a
// request LiteLLM has logged may not be in the latest scrape yet).
import { collectSqlRows } from './sql.js';
import { nodeCounters } from '../engine.js';

const ROUTES_TIMEOUT_MS = 5000;
const PROM_TIMEOUT_MS = 8000;
const TZ_OFFSET_SEC = 8 * 3600;   // Asia/Shanghai, no DST

function hostPort(u) {
  try {
    const x = new URL(u);
    return `${x.hostname}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`;
  } catch { return null; }
}

async function modelInfo(url, key) {
  const r = await fetch(String(url).replace(/\/+$/, '') + '/model/info', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((d) => ({ name: d.model_name, at: hostPort(d.litellm_params?.api_base) }));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export { hostPort, TZ_OFFSET_SEC };

/** Seconds since local (Beijing) midnight, and that midnight as unix seconds. */
export function localDay(nowSec = Date.now() / 1000) {
  const since = Math.floor((nowSec + TZ_OFFSET_SEC) % 86400);
  return { since, midnight: Math.floor(nowSec) - since };
}

/**
 * Reset-aware sum of increments of one counter series since midnight.
 * values: [[ts, "v"], ...] after midnight, sorted.  base: the series' last value at or
 * before midnight (looked back up to 7 days), or null when the series never existed
 * before midnight.
 *   base known  -> every step from it counts; a drop means the server restarted and the
 *                  new value counted from 0. (A server that was down at midnight gets base 0
 *                  from promIncrease, so its first sample after boot counts in full.)
 *   base null   -> a brand-new series (a new scrape target, e.g. an exporter added mid-day):
 *                  nothing tells how much of its first value predates midnight, so the
 *                  first sample is the baseline. That can undercount by whatever happened
 *                  before the first scrape; counting a whole lifetime as "today" would be
 *                  far worse.
 */
export function counterIncrease(values, base) {
  let inc = 0;
  let prev = base;
  for (const [, v] of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    if (prev === null) { prev = x; continue; }
    inc += x >= prev ? x - prev : x;   // a drop = restart: the new process counted x from 0
    prev = x;
  }
  return inc;
}

export const seriesKey = (metric) => JSON.stringify(Object.entries(metric || {}).sort());

export async function promQuery(promUrl, q, time) {
  const u = `${promUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(q)}&time=${time}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(PROM_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`prometheus HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(`prometheus: ${j.error || 'error'}`);
  return j.data?.result || [];
}

const GAP_SEC = 300;       // samples further apart than this are a missing stretch
const TAIL_SEC = 120;      // a series whose last sample is this recent is still running

/** a counter's covered stretch(es) of [from, end] from its raw samples (see the header) */
function coverOf(values, base, from, end) {
  const out = [];
  let a = from, prevT = from, prevX = base;
  for (const [t, v] of values) {
    const tt = Number(t), x = Number(v);
    if (!Number.isFinite(x)) continue;
    // a drop across a missing stretch: the server restarted somewhere in it, and what it
    // counted between the last sample and the restart is lost
    if (prevX != null && x < prevX && tt - prevT > GAP_SEC) { if (prevT > a) out.push([a, prevT]); a = tt; }
    prevT = tt; prevX = x;
  }
  if (values.length) out.push([a, end - prevT <= TAIL_SEC ? end : prevT]);
  return out;
}

export function mergeCover(list) {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 60) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/** a LiteLLM minute bucket is covered when it starts inside a covered stretch */
export const covered = (cover, minute) => cover.some(([a, b]) => minute >= a && minute < b);

const startKey = (m) => `${m?.instance || ''}|${m?.unit || ''}`;

/** when each exporter-published server started, as seen in the window: instance|unit -> sec */
async function serverStarts(promUrl, s0, s1) {
  const out = new Map();
  for (const m of ['homenet_llama_process_start_seconds', 'homenet_llama_invocation_start_seconds']) {
    try {
      for (const r of await promQuery(promUrl, `min_over_time(${m}[${s1 - s0}s] @ ${s1})`, s1)) {
        const v = Number(r.value?.[1]);
        if (v > 0) out.set(startKey(r.metric), v);
      }
    } catch { /* no exporter, or Prometheus too old for @: first-sample baselines only */ }
  }
  return out;
}

/**
 * Exact counter increase over [startSec, endSec] (v2.24: any window, not only "today"), and
 * (v2.29) the stretches of it the counter covered. Baseline per series (`@` pins the
 * evaluation instant to the window start):
 *   a sample in the hour before the start -> that value (the server ran through it);
 *   seen in the week before but not in that hour -> 0: the server was down at the start
 *     (m110 is switched off overnight), so everything it counts now started after it came
 *     back -- a days-old value is not a baseline for a restarted process;
 *   never seen in the week before -> a brand-new series (counterIncrease): 0 when its server
 *     is known to have started inside the window (it counted from 0 then), else null.
 * Raw samples inside the window: a range vector ending at the window end.
 */
export async function promCounterWindow(promUrl, selectors, startSec, endSec) {
  const s0 = Math.floor(startSec), s1 = Math.floor(endSec), span = s1 - s0;
  if (span <= 0) return { value: 0, cover: [] };
  let total = 0, starts = null;
  const cover = [];
  for (const sel of selectors) {
    const at = async (q) => new Map((await promQuery(promUrl, q, s1)).map((s) => [seriesKey(s.metric), Number(s.value?.[1])]));
    const fresh = await at(`last_over_time(${sel}[1h] @ ${s0})`);
    const seen = await at(`last_over_time(${sel}[7d] @ ${s0})`);
    for (const s of await promQuery(promUrl, `${sel}[${span}s] @ ${s1}`, s1)) {
      const k = seriesKey(s.metric);
      const vals = s.values || [];
      let b = Number.isFinite(fresh.get(k)) ? fresh.get(k) : (seen.has(k) ? 0 : null);
      let from = s0;
      if (b === null) {
        if (!starts) starts = await serverStarts(promUrl, s0, s1);
        const st = starts.get(startKey(s.metric));
        if (st != null && st >= s0 - 5) { b = 0; from = Math.max(s0, Math.floor(st)); }
        else from = Number(vals[0]?.[0]) || s1;
      }
      total += counterIncrease(vals, b);
      cover.push(...coverOf(vals, b, from, s1));
    }
  }
  return { value: Math.round(total), cover: mergeCover(cover) };
}

export async function promIncreaseRange(promUrl, selectors, startSec, endSec) {
  return (await promCounterWindow(promUrl, selectors, startSec, endSec)).value;
}

/** Prometheus' active scrape targets: instance -> { job, health, error } */
async function promTargets(promUrl) {
  const r = await fetch(`${promUrl.replace(/\/+$/, '')}/api/v1/targets?state=active`, { signal: AbortSignal.timeout(PROM_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`prometheus HTTP ${r.status}`);
  const j = await r.json();
  const out = new Map();
  for (const t of j.data?.activeTargets || []) {
    const inst = t.labels?.instance;
    if (!inst) continue;
    const cur = out.get(inst);
    // the same address in two jobs (it should not be): an up one wins
    if (!cur || (cur.health !== 'up' && t.health === 'up')) out.set(inst, { job: t.labels?.job, health: t.health, error: t.lastError ? String(t.lastError).slice(0, 160) : null });
  }
  return out;
}

/**
 * When a counter started being collected: the earliest sample Prometheus still has for
 * every selector (the LATEST of the per-selector starts -- a sum is only complete once all
 * its parts exist). null when any selector has no data at all.
 */
export async function promFirstSample(promUrl, selectors, nowSec, lookback = '30d') {
  let start = null;
  for (const sel of selectors) {
    const r = await promQuery(promUrl, `min(min_over_time(timestamp(${sel})[${lookback}:5m]))`, nowSec);
    const v = Number(r[0]?.value?.[1]);
    if (!Number.isFinite(v)) return null;
    start = start === null ? v : Math.max(start, v);
  }
  return start === null ? null : Math.floor(start);
}

const KIND_KEYS = [['requests', 'reqs'], ['tokens', 'tokens'], ['net', 'net'], ['embed_requests', 'emb_reqs'], ['embed_tokens', 'emb_tokens']];
const LOW_SKIP_SEC = 120;          // see the header: the newest LiteLLM rows are not compared

/** the scrape address a counter kind depends on (null: not known) */
function sourceOf(kind, sels, inst) {
  if (inst && (kind === 'tokens' || kind === 'net')) return inst.engine;
  if (inst && kind === 'requests') return inst.job === 'strata' ? inst.engine : inst.logs;
  const m = String(sels?.[0] || '').match(/instance="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * @param ctx.engine  v2.29 EngineDetector: where each node's engine is (for the counters'
 *                    scrape health); nodes without `engine:` are checked by their selectors
 */
export async function collectNodes(target, env, { engine = null } = {}) {
  const src = target.source || {};
  const nodes = (target.nodes || []).map((n) => ({
    ...n, counters: nodeCounters(n), chat: new Set(n.endpoints || []), emb: new Set(n.embed_endpoints || []),
  }));
  const metrics = {};
  const put = (k, v) => { metrics[k] = { value: v, level: null, display: String(v) }; };
  const nowSec = Math.floor(Date.now() / 1000);
  const { midnight } = localDay(nowSec);

  // ── via LiteLLM (first: a counter's gaps are filled from it) ──
  // Only rows that produced tokens count for a node (v2.29); unassigned keeps every row, it
  // is there to show what reached no node at all.
  const rows = await collectSqlRows(src, env, src.query_file);
  const perMinute = rows.some((r) => r.minute != null);   // (a pre-v2.29 query: no gap filling)
  const acc = Object.fromEntries(nodes.map((n) => [n.id, { reqs: 0, tokens: 0, emb_reqs: 0, emb_tokens: 0, rows: { chat: [], embed: [] } }]));
  const un = { reqs: 0, tokens: 0 };
  for (const r of rows) {
    const at = r.api_base ? hostPort(r.api_base.replace(/\/v1.*$/, '')) : null;
    const reqs = num(r.requests), tokens = num(r.tokens);
    const n = at && nodes.find((x) => x.chat.has(at) || x.emb.has(at));
    if (!n) { un.reqs += reqs; un.tokens += tokens; continue; }
    const ok = r.ok != null ? num(r.ok) > 0 : tokens > 0;
    if (!ok) continue;
    const type = n.emb.has(at) ? 'embed' : 'chat';
    if (type === 'embed') { acc[n.id].emb_reqs += reqs; acc[n.id].emb_tokens += tokens; } else { acc[n.id].reqs += reqs; acc[n.id].tokens += tokens; }
    acc[n.id].rows[type].push({ minute: num(r.minute), reqs, tokens });
  }
  for (const n of nodes) {
    const a = acc[n.id];
    put(`${n.id}_ll_reqs`, a.reqs); put(`${n.id}_ll_tokens`, a.tokens);
    if (n.emb.size) { put(`${n.id}_emb_ll_reqs`, a.emb_reqs); put(`${n.id}_emb_ll_tokens`, a.emb_tokens); }
  }
  put('unassigned_ll_reqs', un.reqs); put('unassigned_ll_tokens', un.tokens);

  // ── totals from the servers' own counters ──
  let health = null, healthErr = null;
  if (src.prometheus) { try { health = await promTargets(src.prometheus); } catch (e) { healthErr = String(e?.message || e); } }
  const counterInfo = {};
  for (const n of nodes) {
    const c = n.counters || {};
    const info = counterInfo[n.id] = {
      requests: !!(c.requests && c.requests.length), tokens: !!(c.tokens && c.tokens.length),
      embed_requests: !!(c.embed_requests && c.embed_requests.length), embed_tokens: !!(c.embed_tokens && c.embed_tokens.length),
      kinds: {},
    };
    if (!src.prometheus) continue;
    const inst = engine?.has(n.id) ? engine.instances(n.id) : null;
    // the engine answers on some port: then a counter Prometheus does not scrape is a fault
    // (a node that is off -- m110 -- is not)
    const eInfo = engine?.has(n.id) ? engine.info(n.id) : null;
    const nodeUp = !!(eInfo && eInfo.engine && !eInfo.error);
    for (const [kind, key] of KIND_KEYS) {
      if (!c[kind] || !c[kind].length) continue;
      const k = info.kinds[key] = { raw: null, cover: [], gap: 0, ll_cover: 0, error: null, source: sourceOf(kind, c[kind], inst) };
      let w;
      try { w = await promCounterWindow(src.prometheus, c[kind], midnight, nowSec); }
      catch (e) { k.error = { code: 'read', detail: String(e?.message || e).slice(0, 160) }; info[`${kind}_error`] = k.error.detail; continue; }
      k.raw = w.value; k.cover = w.cover;
      // the LiteLLM rows of this measure, split by whether the counter covered their minute
      const type = kind.startsWith('embed') ? 'embed' : 'chat';
      const field = kind.endsWith('requests') ? 'reqs' : 'tokens';
      if (kind !== 'net' && perMinute) {
        for (const r of acc[n.id].rows[type]) {
          if (!covered(w.cover, r.minute)) k.gap += r[field];
          else if (r.minute < nowSec - LOW_SKIP_SEC) k.ll_cover += r[field];
        }
      }
      const h = k.source && health ? health.get(k.source) : null;
      if (k.source && nodeUp && health && !h) k.error = { code: 'missing', instance: k.source };
      else if (k.source && nodeUp && h && h.health !== 'up') k.error = { code: 'down', instance: k.source, detail: h.error };
      else if (k.source && nodeUp && healthErr) k.error = { code: 'read', detail: healthErr };
      else if (kind !== 'net' && k.raw < k.ll_cover) k.error = { code: 'low', value: k.raw, ll: k.ll_cover };
      if (k.error) { info[`${kind}_error`] = k.error.code; continue; }
      put(`${n.id}_${key}`, k.raw + k.gap);
    }
  }

  // ── routes ── one failing instance must not blank the others: its routes are simply
  // unknown, and a node whose every instance failed reports routes: null ("—").
  const key = env[src.key_env || 'LITELLM_MASTER_KEY'];
  const inst = Array.isArray(src.instances) ? src.instances : [];
  const results = await Promise.all(inst.map(async (i) => {
    if (!key) return { i, err: 'no key' };
    try { return { i, deps: await modelInfo(i.url, key) }; } catch (e) { return { i, err: String(e?.message || e) }; }
  }));
  const anyOk = results.some((r) => r.deps);
  const out = {};
  for (const n of nodes) {
    const routes = [];
    for (const r of results) {
      const serves = Array.isArray(r.i.serves) ? r.i.serves : null;
      const intended = serves ? serves.includes(n.id) : true;
      const live = r.deps ? r.deps.some((d) => d.at && (n.chat.has(d.at) || n.emb.has(d.at))) : false;
      // live + intended = the route; live + not intended = left over, to be removed;
      // intended but not live = planned, not connected yet.
      if (live || (intended && serves)) {
        routes.push({ port: r.i.port, intended, live, public: r.i.public ? String(r.i.public) : null });
      }
    }
    routes.sort((a, b) => a.port - b.port);
    out[n.id] = {
      routes: anyOk ? routes : null,
      ports: anyOk ? routes.filter((x) => x.live).map((x) => x.port) : null,
      public: routes.find((x) => x.live && x.intended && x.public)?.public || null,
      counters: counterInfo[n.id],
    };
  }
  return {
    metrics,
    extra: {
      nodes: out,
      day_start: localDay(nowSec).midnight,
      route_errors: results.filter((r) => r.err).map((r) => ({ port: r.i.port, error: r.err })),
    },
  };
}
