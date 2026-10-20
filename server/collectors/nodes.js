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
import { collectSqlRows } from './sql.js';

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

/**
 * Exact counter increase over [startSec, endSec] (v2.24: any window, not only "today").
 * Baseline per series (`@` pins the evaluation instant to the window start):
 *   a sample in the hour before the start -> that value (the server ran through it);
 *   seen in the week before but not in that hour -> 0: the server was down at the start
 *     (m110 is switched off overnight), so everything it counts now started after it came
 *     back -- a days-old value is not a baseline for a restarted process;
 *   never seen in the week before -> null: a brand-new series (counterIncrease).
 * Raw samples inside the window: a range vector ending at the window end.
 */
export async function promIncreaseRange(promUrl, selectors, startSec, endSec) {
  const span = Math.floor(endSec) - Math.floor(startSec);
  if (span <= 0) return 0;
  let total = 0;
  for (const sel of selectors) {
    const at = async (q) => new Map((await promQuery(promUrl, q, endSec)).map((s) => [seriesKey(s.metric), Number(s.value?.[1])]));
    const fresh = await at(`last_over_time(${sel}[1h] @ ${Math.floor(startSec)})`);
    const seen = await at(`last_over_time(${sel}[7d] @ ${Math.floor(startSec)})`);
    for (const s of await promQuery(promUrl, `${sel}[${span}s] @ ${Math.floor(endSec)}`, endSec)) {
      const k = seriesKey(s.metric);
      const b = Number.isFinite(fresh.get(k)) ? fresh.get(k) : (seen.has(k) ? 0 : null);
      total += counterIncrease(s.values || [], b);
    }
  }
  return Math.round(total);
}

async function promIncrease(promUrl, selectors, nowSec) {
  return promIncreaseRange(promUrl, selectors, localDay(nowSec).midnight, nowSec);
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

export async function collectNodes(target, env) {
  const src = target.source || {};
  const nodes = (target.nodes || []).map((n) => ({
    ...n, chat: new Set(n.endpoints || []), emb: new Set(n.embed_endpoints || []),
  }));
  const metrics = {};
  const put = (k, v) => { metrics[k] = { value: v, level: null, display: String(v) }; };
  const nowSec = Math.floor(Date.now() / 1000);

  // ── totals from the servers' own counters ──
  const counterInfo = {};
  for (const n of nodes) {
    const c = n.counters || {};
    counterInfo[n.id] = {
      requests: !!(c.requests && c.requests.length), tokens: !!(c.tokens && c.tokens.length),
      embed_requests: !!(c.embed_requests && c.embed_requests.length), embed_tokens: !!(c.embed_tokens && c.embed_tokens.length),
    };
    if (!src.prometheus) continue;
    for (const [kind, key] of [['requests', 'reqs'], ['tokens', 'tokens'], ['net', 'net'], ['embed_requests', 'emb_reqs'], ['embed_tokens', 'emb_tokens']]) {
      if (!c[kind] || !c[kind].length) continue;
      try { put(`${n.id}_${key}`, await promIncrease(src.prometheus, c[kind], nowSec)); }
      catch (e) { counterInfo[n.id][`${kind}_error`] = String(e?.message || e); }
    }
  }

  // ── via LiteLLM ──
  const rows = await collectSqlRows(src, env, src.query_file);
  const acc = Object.fromEntries(nodes.map((n) => [n.id, { reqs: 0, tokens: 0, emb_reqs: 0, emb_tokens: 0 }]));
  const un = { reqs: 0, tokens: 0 };
  for (const r of rows) {
    const at = r.api_base ? hostPort(r.api_base.replace(/\/v1.*$/, '')) : null;
    const reqs = num(r.requests), tokens = num(r.tokens);
    const n = at && nodes.find((x) => x.chat.has(at) || x.emb.has(at));
    if (!n) { un.reqs += reqs; un.tokens += tokens; continue; }
    if (n.emb.has(at)) { acc[n.id].emb_reqs += reqs; acc[n.id].emb_tokens += tokens; }
    else { acc[n.id].reqs += reqs; acc[n.id].tokens += tokens; }
  }
  for (const n of nodes) {
    const a = acc[n.id];
    put(`${n.id}_ll_reqs`, a.reqs); put(`${n.id}_ll_tokens`, a.tokens);
    if (n.emb.size) { put(`${n.id}_emb_ll_reqs`, a.emb_reqs); put(`${n.id}_emb_ll_tokens`, a.emb_tokens); }
  }
  put('unassigned_ll_reqs', un.reqs); put('unassigned_ll_tokens', un.tokens);

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
