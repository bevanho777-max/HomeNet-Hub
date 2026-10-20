// inference_nodes collector (v2.20) — the data behind the 推理节点 / Inference Nodes card
// that is not a plain probe or a Prometheus query:
//
//   • today's usage per node. One query (queries/node_usage.sql) returns today's rows per
//     model; each node claims rows with its own regexes (`chat`, optional `embed`), first
//     matching node wins, the rest is `unassigned`. Same day and same rows as the Token
//     Usage card, so  Σ nodes + unassigned == that card's "Today".
//   • which litellm instance(s) actually route to the node. GET <instance>/model/info with
//     the master key and match every deployment's api_base host:port against the node's
//     `endpoints`. The card shows what IS routed, not what a config file says should be —
//     an instance port written into YAML goes stale the moment someone moves a model.
//
// Metrics (numbers, so they reach the timeseries and the node modal can chart them):
//   <node>_reqs  <node>_tokens  [<node>_emb_reqs  <node>_emb_tokens]
//   unassigned_reqs  unassigned_tokens  total_reqs  total_tokens
// extra.nodes[<node>] = { ports: [4000, ...] | null, public: bool, models: [...] }
import { collectSqlRows } from './sql.js';

const ROUTES_TIMEOUT_MS = 5000;

function rx(src) {
  if (!src) return null;
  try { return new RegExp(src, 'i'); } catch { return null; }
}

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

export async function collectNodes(target, env) {
  const src = target.source || {};
  const nodes = (target.nodes || []).map((n) => ({
    ...n, chatRx: rx(n.chat), embRx: rx(n.embed), endpoints: new Set(n.endpoints || []),
  }));

  // ── usage ──
  const rows = await collectSqlRows(src, env, src.query_file);
  const metrics = {};
  const put = (k, v) => { metrics[k] = { value: v, level: null, display: String(v) }; };
  const acc = Object.fromEntries(nodes.map((n) => [n.id, { reqs: 0, tokens: 0, emb_reqs: 0, emb_tokens: 0 }]));
  const un = { reqs: 0, tokens: 0, models: [] };
  let totReqs = 0, totTokens = 0, day = null;
  for (const r of rows) {
    const model = String(r.model || '');
    const reqs = num(r.requests), tokens = num(r.tokens);
    totReqs += reqs; totTokens += tokens;
    day = day || (r.day ? String(r.day).slice(0, 10) : null);
    let hit = false;
    for (const n of nodes) {
      // embed first: an embedding deployment name can contain digits that a chat regex
      // like "27b" would never match, but be explicit rather than rely on that.
      if (n.embRx && model && n.embRx.test(model)) { acc[n.id].emb_reqs += reqs; acc[n.id].emb_tokens += tokens; hit = true; break; }
      if (n.chatRx && model && n.chatRx.test(model)) { acc[n.id].reqs += reqs; acc[n.id].tokens += tokens; hit = true; break; }
    }
    if (!hit) { un.reqs += reqs; un.tokens += tokens; un.models.push(model || '(none)'); }
  }
  for (const n of nodes) {
    const a = acc[n.id];
    put(`${n.id}_reqs`, a.reqs); put(`${n.id}_tokens`, a.tokens);
    if (n.embRx) { put(`${n.id}_emb_reqs`, a.emb_reqs); put(`${n.id}_emb_tokens`, a.emb_tokens); }
  }
  put('unassigned_reqs', un.reqs); put('unassigned_tokens', un.tokens);
  put('total_reqs', totReqs); put('total_tokens', totTokens);

  // ── routes ── one failing instance must not blank the others: its ports are simply
  // unknown, and a node whose every instance failed reports ports: null ("—"), never [].
  const key = env[src.key_env || 'LITELLM_MASTER_KEY'];
  const inst = Array.isArray(src.instances) ? src.instances : [];
  const results = await Promise.all(inst.map(async (i) => {
    if (!key) return { i, err: 'no key' };
    try { return { i, deps: await modelInfo(i.url, key) }; } catch (e) { return { i, err: String(e?.message || e) }; }
  }));
  const anyOk = results.some((r) => r.deps);
  const out = {};
  for (const n of nodes) {
    const ports = [];
    const models = new Set();
    let pub = false;
    for (const r of results) {
      if (!r.deps) continue;
      const mine = r.deps.filter((d) => d.at && n.endpoints.has(d.at));
      if (mine.length) {
        ports.push(r.i.port);
        if (r.i.public) pub = true;
        mine.forEach((d) => models.add(d.name));
      }
    }
    out[n.id] = { ports: anyOk ? ports.sort((a, b) => a - b) : null, public: pub, models: [...models].sort() };
  }
  return {
    metrics,
    extra: {
      nodes: out,
      day,
      unassigned_models: un.models,
      route_errors: results.filter((r) => r.err).map((r) => ({ port: r.i.port, error: r.err })),
    },
  };
}
