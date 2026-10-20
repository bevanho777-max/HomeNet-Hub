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

/** Seconds since local (Beijing) midnight, and that midnight as unix seconds. */
export function localDay(nowSec = Date.now() / 1000) {
  const since = Math.floor((nowSec + TZ_OFFSET_SEC) % 86400);
  return { since, midnight: Math.floor(nowSec) - since };
}

/** Reset-aware sum of increments of one counter series since `midnight`. */
export function counterIncrease(values, midnight) {
  // values: [[ts, "v"], ...] sorted by ts
  let base = null;
  let inc = 0;
  let prev = null;
  for (const [ts, v] of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    if (ts <= midnight) { base = x; continue; }
    if (prev === null) prev = base === null ? 0 : base;
    inc += x >= prev ? x - prev : x;   // a drop = restart: the new process counted x from 0
    prev = x;
  }
  return inc;
}

async function promIncrease(promUrl, selectors, nowSec) {
  const { since, midnight } = localDay(nowSec);
  // An hour before midnight so the baseline sample is in the window even if Prometheus
  // missed a few scrapes around 00:00. No sample in that hour = the series is new today
  // (a server that started after midnight), and it rightly starts from 0.
  const range = since + 3600;
  let total = 0;
  for (const sel of selectors) {
    const u = `${promUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(`${sel}[${range}s]`)}&time=${nowSec}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(PROM_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`prometheus HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== 'success') throw new Error(`prometheus: ${j.error || 'error'}`);
    for (const s of j.data?.result || []) total += counterIncrease(s.values || [], midnight);
  }
  return Math.round(total);
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
    counterInfo[n.id] = { requests: !!(c.requests && c.requests.length), tokens: !!(c.tokens && c.tokens.length) };
    if (!src.prometheus) continue;
    for (const [kind, key] of [['requests', 'reqs'], ['tokens', 'tokens']]) {
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
