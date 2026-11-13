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
//     v2.46: unless it is one of the instance's FALLBACKS -- GET <instance>/router/settings,
//     current_values.fallbacks ([{ "<model>": ["<fallback model>", ...] }], in the order LiteLLM
//     tries them): a node reached by the n-th fallback model of a model the instance serves
//     its own node with is that instance's "fallback n" (4001: m133 first, then m26). Read
//     from LiteLLM every poll, so a new order shows by itself. (An instance whose settings
//     cannot be read falls back to its configured `fallback: [node, ...]`, in that order.)
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
// a scrape that broke) (v2.49: no hole at a restart any more -- see coverOf).
// Today's figure = the counter + the LiteLLM requests (that produced tokens) in the minutes
// it did not cover, so a gap never shows as missing usage.
//
// v2.46 ONE computation (nodeFigures) for a node's figure over ANY window -- the card's today (live,
// every minute), each finished day (server/node_usage.js, 00:10, stored in node_day and used by the
// Token Usage card, the detail charts and the summary line alike). Per kind:
//   value = counter increase (raw) + LiteLLM in the minutes the counter did not cover (gap)
//         + LiteLLM requests lost at a server restart (lost): a request that started before the
//           counter's last scrape and finished after it, before the restart -- the server counted it,
//           the restart took the count away before Prometheus read it (m133 2026-11-08 19:34, 32,956
//           tokens). The rows come one per request (node_requests.sql) with start and end.
// A counter that reads lower than LiteLLM, or that Prometheus does not scrape, is FLAGGED but still
// gives its figure -- before v2.46 the card stopped writing (its line froze, m133 11-08 at 421,689)
// while the Token Usage card switched that node-day to LiteLLM's total, which counted a request that
// ran across midnight on both days.
// v2.49 (m25 2026-11-13: "Counter error" on and off from 06:57 to past noon, for ONE request the
// 06:54 restart took away): the lost-at-restart rule takes every request that ended between the
// last scrape and the restart, the low check only compares requests the counter has had the chance
// to count, the figure is never below what LiteLLM delivered while the counter covered, and the card
// never shows "Counter error" again -- the figure always, a small yellow ≈ beside it where it is
// really uncertain (kinds[k].mark: reason and source in the title). See nodeFigures.
import { collectSqlRowsInts } from './sql.js';
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

/** v2.46 the instance's router fallbacks: { "<model>": ["<fallback model>", ...] } (LiteLLM's order) */
async function routerFallbacks(url, key) {
  const r = await fetch(String(url).replace(/\/+$/, '') + '/router/settings', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const e of Array.isArray(j?.current_values?.fallbacks) ? j.current_values.fallbacks : []) {
    for (const [model, list] of Object.entries(e && typeof e === 'object' ? e : {})) {
      if (Array.isArray(list)) out[model] = [...(out[model] || []), ...list.map(String)];
    }
  }
  return out;
}

/**
 * v2.46 node id -> its position (1, 2, ...) among an instance's fallbacks: the fallback models of
 * every model the instance routes to one of the nodes it `serves`, each mapped to the node its
 * api_base belongs to. The first position a node takes wins.
 */
export function fallbackOrder(deps, fallbacks, serves, nodes) {
  const nodeAt = (at) => nodes.find((n) => n.chat.has(at) || n.emb.has(at))?.id || null;
  const out = new Map();
  for (const d of deps || []) {
    if (!serves.includes(nodeAt(d.at))) continue;
    (fallbacks?.[d.name] || []).forEach((m, i) => {
      const id = nodeAt((deps || []).find((x) => x.name === m)?.at);
      if (id && !serves.includes(id) && !out.has(id)) out.set(id, i + 1);
    });
  }
  return out;
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

const TAIL_SEC = 120;      // a series whose last sample is this recent is still running
const SKEW_SEC = 2;        // LiteLLM's endTime vs the scrape's timestamp (both on 24; the server finished first)

/**
 * a counter's covered stretch of [from, end] from its raw samples (see the header), its newest sample
 * (`last`), and every drop -- a server restart, or a counter reset -- with the sample before it (p),
 * the first after it (q) and the value there (x: what the new process had counted by q).
 * v2.49: a drop no longer cuts a hole in the cover. What the old process counted after p is put back
 * from LiteLLM's rows by nodeFigures (`lost`); what the new process counted is in x. Filling the hole
 * from LiteLLM by start minute (v2.29-v2.48) counted a request served by the new process before q twice.
 */
function coverOf(values, base, from, end) {
  const restarts = [];
  let prevT = from, prevX = base, last = null;
  for (const [t, v] of values) {
    const tt = Number(t), x = Number(v);
    if (!Number.isFinite(x)) continue;
    if (prevX != null && x < prevX) restarts.push({ p: prevT, q: tt, x });
    prevT = tt; prevX = x; last = tt;
  }
  return { cover: last != null ? [[from, end - prevT <= TAIL_SEC ? end : prevT]] : [], restarts, last };
}

const promLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * v2.49 when the old process stopped counting, for each restart: the first scrape after p that
 * FAILED (Prometheus' `up` = 0 -- nothing answered then, so the old process was gone), else q.
 * Restarts of several series of one counter at the same scrape (prompt / cached / predicted tokens)
 * are one restart; their x add up.
 */
async function restartCuts(promUrl, list) {
  const merged = [];
  for (const r of list.sort((a, b) => a.p - b.p)) {
    const m = merged.find((x) => x.instance === r.instance && x.job === r.job && Math.abs(x.p - r.p) <= 2 && Math.abs(x.q - r.q) <= 2);
    if (m) m.x += r.x; else merged.push({ ...r });
  }
  for (const r of merged) {
    r.cut = r.q;
    if (!r.instance) continue;
    try {
      const sel = `up{instance="${promLabel(r.instance)}"${r.job ? `,job="${promLabel(r.job)}"` : ''}}`;
      const span = Math.max(1, Math.ceil(r.q - r.p));
      for (const s of await promQuery(promUrl, `${sel}[${span}s] @ ${Math.floor(r.q)}`, Math.floor(r.q))) {
        const f = (s.values || []).find(([t, v]) => Number(t) > r.p && Number(t) < r.q && Number(v) === 0);
        if (f) r.cut = Math.min(r.cut, Number(f[0]));
      }
    } catch { /* unknown: q, and the bound in nodeFigures keeps it from counting twice */ }
  }
  return merged;
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
  if (span <= 0) return { value: 0, cover: [], drops: [], restarts: [], last: null };
  let total = 0, starts = null, last = null;
  const cover = [], restarts = [];
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
      const c = coverOf(vals, b, from, s1);
      cover.push(...c.cover);
      // (the newest sample of any series: a series that ended earlier -- an exporter replaced the
      //  same day -- no longer counts, so it says nothing about how fresh the counter is)
      if (c.last != null) last = last == null ? c.last : Math.max(last, c.last);
      for (const r of c.restarts) restarts.push({ ...r, instance: s.metric?.instance || null, job: s.metric?.job || null });
    }
  }
  const rs = restarts.length ? await restartCuts(promUrl, restarts) : [];
  return { value: Math.round(total), cover: mergeCover(cover), drops: mergeCover(rs.map((r) => [r.p, r.q])), restarts: rs, last };
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

export const KIND_KEYS = [['requests', 'reqs'], ['tokens', 'tokens'], ['net', 'net'], ['embed_requests', 'emb_reqs'], ['embed_tokens', 'emb_tokens']];

/** the inference_nodes target's nodes, with their counter selectors and endpoint sets */
export function nodesOf(target) {
  return (target?.nodes || []).map((n) => ({ ...n, counters: nodeCounters(n), chat: new Set(n.endpoints || []), emb: new Set(n.embed_endpoints || []) }));
}

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
/** v2.46 LiteLLM's per-request rows (node_requests.sql) -> { st, en, minute, node, type, ok, tokens, net } */
export function llRequests(raw, nodes) {
  const out = [];
  for (const r of raw || []) {
    const at = r.api_base ? hostPort(String(r.api_base).replace(/\/v1.*$/, '')) : null;
    const n = at && nodes.find((x) => x.chat.has(at) || x.emb.has(at));
    const st = Number(r.st), en = Number(r.en);
    if (!Number.isFinite(st)) continue;
    const prompt = num(r.prompt), completion = num(r.completion), cached = num(r.cached);
    out.push({
      st, en: Number.isFinite(en) ? en : st, minute: Math.floor(st / 60) * 60,
      node: n ? n.id : null, type: n ? (n.emb.has(at) ? 'embed' : 'chat') : null,
      ok: num(r.ok) > 0, tokens: prompt + completion, net: Math.max(prompt - cached, 0) + completion,
    });
  }
  return out;
}

/** LiteLLM's rows for [start, end) by start time, plus the hour before (a restart early in the window) */
export async function llRequestsWindow(src, env, nodes, start, end) {
  // (its own key: `query_file` stays the old per-minute query, which a rollback to v2.45 still reads)
  const raw = await collectSqlRowsInts(src, env, src.requests_query_file || 'queries/node_requests.sql', [Math.max(0, Math.floor(start) - 3600), Math.ceil(end)]);
  return llRequests(raw, nodes);
}

const FIELD = (key) => (key.endsWith('reqs') ? () => 1 : key.endsWith('net') ? (r) => r.net : (r) => r.tokens);

/**
 * v2.46 THE figures of node `n` over [start, end) -- see the header. `rows`: llRequests() covering
 * the window. Returns { metrics: { <key>: value }, kinds: { <key>: detail }, ll } where key is
 * reqs / tokens / net / emb_reqs / emb_tokens and ll the LiteLLM shares (chat / embed, by start time).
 *
 * v2.49 per kind, the figure is
 *     max(counter + lost, LiteLLM while covered) + LiteLLM while not covered (gap)
 *   counter  the exact increase of the server's counters, a restart / reset stitched (counterIncrease:
 *            the last value read before it + everything the new process counted);
 *   lost     what the old process counted after its last scrape and took with it: LiteLLM's requests
 *            that ENDED after that scrape (p) and before the old process stopped (cut, the first
 *            failed scrape after p), whenever they started -- v2.46-v2.48 only took the ones that had
 *            started before p, and missed m25's 2026-11-13 06:54:33 request (started 06:54:26, after
 *            the 06:54:25 scrape; the libc upgrade's restart came at 06:54:38). With no failed scrape
 *            to tell when the old process stopped: what LiteLLM delivered in (p, q] beyond what the
 *            new process had counted by q -- never a request twice;
 *   LiteLLM while covered: its requests that ended by the counter's newest sample (the server counts
 *            a request when it finishes, so the counter has had the chance to see exactly these) --
 *            v2.46-v2.48 compared every request that STARTED over 2 minutes ago, so a long request
 *            that had just finished, not scraped yet, read as "the counter is low".
 * A kind whose counter cannot be read keeps a figure too, live (`memo`): the last one read plus what
 * LiteLLM delivered since. Nothing replaces the figure any more. `mark` says when it is really
 * uncertain -- the counter below LiteLLM ('low'), not collected for over TAIL_SEC while the node is up
 * ('stale': LiteLLM fills, a direct request waits for the counter), unreadable ('read') -- and the card
 * puts a small yellow ≈ beside the figure, the reason and the source in its title.
 * (`error` stays for an unreadable counter only: a finished day computed then is not exact.)
 */
export async function nodeFigures(prom, n, start, end, rows, { inst = null, health = null, healthErr = null, nodeUp = false, nowSec = end, memo = null } = {}) {
  const c = n.counters || {};
  const mine = (rows || []).filter((r) => r.node === n.id && r.ok && r.st >= start && r.st < end);
  const ll = { tokens: 0, reqs: 0, emb_tokens: 0, emb_reqs: 0 };
  for (const r of mine) {
    if (r.type === 'embed') { ll.emb_tokens += r.tokens; ll.emb_reqs += 1; } else { ll.tokens += r.tokens; ll.reqs += 1; }
  }
  const metrics = {}, kinds = {};
  for (const [kind, key] of KIND_KEYS) {
    if (!c[kind] || !c[kind].length) continue;
    const k = kinds[key] = { raw: null, gap: 0, lost: 0, cover: [], drops: [], restarts: [], last: null, ll_cover: 0, error: null, mark: null, source: sourceOf(kind, c[kind], inst) };
    const type = kind.startsWith('embed') ? 'embed' : 'chat';
    const f = FIELD(key);
    const mk = `${n.id}|${key}`;
    let w;
    try { w = await promCounterWindow(prom, c[kind], start, end); }
    catch (e) {
      const detail = String(e?.message || e).slice(0, 160);
      k.error = { code: 'read', detail };
      if (memo) {
        // the last figure read today, plus LiteLLM's requests it could not have had yet: covered ones
        // that ended after its newest sample, uncovered ones logged after it was computed
        const pv = memo.get(mk);
        const mineT = mine.filter((r) => r.type === type);
        if (pv && pv.start === start) {
          let add = 0;
          for (const r of mineT) if (covered(pv.cover, r.minute) ? r.en > (pv.last ?? pv.at) - SKEW_SEC : r.en > pv.at) add += f(r);
          metrics[key] = pv.value + add;
          k.mark = { code: 'read', detail, since: pv.at, source: 'last+ll' };
        } else {
          metrics[key] = mineT.reduce((a, r) => a + f(r), 0);
          k.mark = { code: 'read', detail, since: null, source: 'll' };
        }
      }
      continue;
    }
    k.raw = w.value; k.cover = w.cover; k.drops = w.drops; k.last = w.last;
    const seen = w.last == null ? -Infinity : w.last - SKEW_SEC;
    for (const r of mine) {
      if (r.type !== type) continue;
      if (!covered(w.cover, r.minute)) { k.gap += f(r); continue; }
      if (r.en <= seen) k.ll_cover += f(r);
    }
    // restarts inside the window (see above): rows that ended in (p, cut] -- or, the cut unknown,
    // LiteLLM's (p, q] beyond the new process' first value
    for (const d of w.restarts) {
      if (!(d.p >= start && d.p < end)) continue;
      let before = 0, all = 0;
      for (const r of mine) {
        if (r.type !== type || !covered(w.cover, r.minute) || !(r.en > d.p && r.en <= d.q)) continue;
        all += f(r);
        if (r.en <= d.cut) before += f(r);
      }
      const lost = Math.max(0, d.cut < d.q ? Math.max(before, all - d.x) : all - d.x);
      k.lost += lost;
      k.restarts.push({ p: d.p, q: d.q, cut: d.cut, lost });
    }
    const ctr = k.raw + k.lost;
    const low = kind !== 'net' && ctr < k.ll_cover;
    metrics[key] = (low ? k.ll_cover : ctr) + k.gap;
    const h = k.source && health ? health.get(k.source) : null;
    if (low) k.mark = { code: 'low', value: ctr, ll: k.ll_cover, source: 'll' };
    else if (nodeUp && nowSec - (w.last ?? start) > TAIL_SEC) {
      k.mark = { code: 'stale', since: w.last, instance: k.source, source: 'ctr+ll',
        why: health ? (!h ? 'missing' : h.health !== 'up' ? 'down' : null) : (healthErr ? 'read' : null), detail: h?.error || healthErr || null };
    }
    memo?.set(mk, { start, value: metrics[key], last: w.last, at: end, cover: w.cover });
  }
  return { metrics, kinds, ll };
}

/**
 * @param ctx.engine  v2.29 EngineDetector: where each node's engine is (for the counters'
 *                    scrape health); nodes without `engine:` are checked by their selectors
 */
// v2.49 each node / kind's last figure read today: an unreadable counter keeps showing it (+ LiteLLM since)
const LIVE_MEMO = new Map();

export async function collectNodes(target, env, { engine = null } = {}) {
  const src = target.source || {};
  const nodes = nodesOf(target);
  const metrics = {};
  const put = (k, v) => { metrics[k] = { value: v, level: null, display: String(v) }; };
  const nowSec = Math.floor(Date.now() / 1000);
  const { midnight } = localDay(nowSec);

  // ── via LiteLLM: one row per request since midnight (v2.46) ──
  const rows = await llRequestsWindow(src, env, nodes, midnight, nowSec + 60);
  const un = { reqs: 0, tokens: 0 };
  for (const r of rows) if (!r.node && r.st >= midnight) { un.reqs += 1; un.tokens += r.tokens; }
  put('unassigned_ll_reqs', un.reqs); put('unassigned_ll_tokens', un.tokens);

  // ── totals: nodeFigures, the same computation a finished day gets ──
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
    const inst = engine?.has(n.id) ? engine.instances(n.id) : null;
    // the engine answers on some port: then a counter Prometheus does not scrape is a fault
    // (a node that is off -- m110 -- is not)
    const eInfo = engine?.has(n.id) ? engine.info(n.id) : null;
    const nodeUp = !!(eInfo && eInfo.engine && !eInfo.error);
    const fig = src.prometheus ? await nodeFigures(src.prometheus, n, midnight, nowSec, rows, { inst, health, healthErr, nodeUp, nowSec, memo: LIVE_MEMO })
      : { metrics: {}, kinds: {}, ll: { tokens: 0, reqs: 0, emb_tokens: 0, emb_reqs: 0 } };
    put(`${n.id}_ll_reqs`, fig.ll.reqs); put(`${n.id}_ll_tokens`, fig.ll.tokens);
    if (n.emb.size) { put(`${n.id}_emb_ll_reqs`, fig.ll.emb_reqs); put(`${n.id}_emb_ll_tokens`, fig.ll.emb_tokens); }
    for (const [kind, key] of KIND_KEYS) {
      const k = fig.kinds[key];
      if (!k) continue;
      info.kinds[key] = k;
      if (k.error) info[`${kind}_error`] = k.error.code;     // (v2.49: an unreadable counter only)
      if (k.mark) info[`${kind}_mark`] = k.mark.code;
      if (typeof fig.metrics[key] === 'number') put(`${n.id}_${key}`, fig.metrics[key]);
    }
  }

  // ── routes ── one failing instance must not blank the others: its routes are simply
  // unknown, and a node whose every instance failed reports routes: null ("—").
  const key = env[src.key_env || 'LITELLM_MASTER_KEY'];
  const inst = Array.isArray(src.instances) ? src.instances : [];
  const results = await Promise.all(inst.map(async (i) => {
    if (!key) return { i, err: 'no key' };
    let deps;
    try { deps = await modelInfo(i.url, key); } catch (e) { return { i, err: String(e?.message || e) }; }
    // v2.46 the fallback order, as LiteLLM has it (an instance without `serves` has none to speak of)
    let fb = null, fbErr = null;
    if (Array.isArray(i.serves)) {
      try { fb = fallbackOrder(deps, await routerFallbacks(i.url, key), i.serves, nodes); } catch (e) { fbErr = String(e?.message || e).slice(0, 120); }
    }
    if (!fb && Array.isArray(i.fallback)) fb = new Map(i.fallback.map((id, k) => [id, k + 1]));
    return { i, deps, fb: fb || new Map(), fbErr };
  }));
  const anyOk = results.some((r) => r.deps);
  const out = {};
  for (const n of nodes) {
    const routes = [];
    for (const r of results) {
      const serves = Array.isArray(r.i.serves) ? r.i.serves : null;
      // v2.40 a fallback: a node this instance falls back to when its own node is gone (4001 -> m133, then
      // m26, while m25's resident Strata is off). v2.46: which nodes, and in what order, is read from the
      // instance's router_settings.fallbacks (fallbackOrder). A live fallback route is intended, shown as
      // "fallback n", and never carries the instance's public name.
      const fbn = r.fb?.get(n.id) || null;
      const fallback = !!fbn && !(serves && serves.includes(n.id));
      const intended = serves ? serves.includes(n.id) || fallback : true;
      const live = r.deps ? r.deps.some((d) => d.at && (n.chat.has(d.at) || n.emb.has(d.at))) : false;
      // live + intended = the route; live + not intended = left over, to be removed;
      // intended but not live = planned, not connected yet.
      if (live || (intended && serves && !fallback)) {
        routes.push({ port: r.i.port, intended, live, ...(fallback ? { fallback: true, fallback_n: fbn } : {}), public: r.i.public && !fallback ? String(r.i.public) : null });
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
      route_errors: results.filter((r) => r.err || r.fbErr).map((r) => ({ port: r.i.port, error: r.err || `router/settings: ${r.fbErr}` })),
    },
  };
}
