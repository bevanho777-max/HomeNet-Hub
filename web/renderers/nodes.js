// nodes renderer (v2.20) — 推理节点 / Inference Nodes: one full-width card, one column per
// inference machine, replacing the separate Inference · NN and Speed · NN half-cards.
//
// Each column is assembled from three sources, all of which already exist on the hub:
//   probe  (http target)      → status, latency, the model ID the node itself reports
//   live   (inference_live)   → prefill / decode: v2.46 the big figure is the request running now,
//                               「上次」/ Last beside it the newest FINISHED request's, as the server
//                               recorded it (server/collectors/live.js) -- the detail chart's last point
//   meta   (inference_nodes)  → today's requests / tokens for this node, and the litellm
//                               instance port(s) that actually route to it
//
// Status is one vocabulary for every node: Online / No service / Down. A node whose probe
// target says `always_on: false` (m110 is switched off a lot) is grey when unreachable, never
// red; every other node going unreachable is a fault. Columns never reorder or disappear —
// a dead node keeps its slot so the other two do not jump.
//
// v2.29: the column's title says which engine the hub found on the node (server/engine.js);
// a counter that did not cover the whole day says, in the title, how much of the figure came
// from LiteLLM and for which hours. v2.49: the figure is always shown (never "Counter error"
// in its place); a small yellow ≈ before it where the server marks it really uncertain.
import { card, esc } from './common.js';
import { cv, t } from '../i18n.js';
import { si3 } from '../fmt.js';

// v2.27: K / M / G with three significant digits, like every count on the board
const compact = si3;

function hm(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const p2 = (x) => ('0' + x).slice(-2);
  const s = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? s : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${s}`;
}

// node state rules: ./node_state.js (v2.44, shared with the hub's /api/node-states)
import { nodeBusy, nodeState, strataAlive, testingPorts } from './node_state.js';
export { nodeState, strataAlive, testingPorts };

const STATE_CLASS = { online: 'lv-ok', idle: 'node-idle-text', testing: 'lv-cool', cut: 'lv-warn', down: 'lv-danger' };

function statusText(state, probeTarget) {
  if (state === 'online') return t('node_online');
  if (state === 'cut') return t('node_cut');
  if (state === 'down') return t('node_down');
  // always_on:false machines are usually just switched off — say both, since the hub
  // cannot tell "powered off" from "on but not serving".
  return probeTarget?.always_on === false ? t('node_off') : t('node_idle');
}
// v2.27 the status's short form, for a column too narrow for it (abbreviation table)
const statusShort = (state, probeTarget) => (state === 'idle' && probeTarget?.always_on === false ? t('abbr_off') : null);

// v2.28 the status's second line while no request runs: how many streams the server runs
// (read from it), why a grey node is grey, why a red one is red
function statusSub(state, probeSnap, lv) {
  if (state === 'online') {
    if (!lv?.reachable) return { sub: t('node_sub_nolive'), subShort: t('abbr_nolive') };
    const M = Number(lv.max_streams) || 1;
    return M > 1 ? { sub: t('node_sub_max', M), subShort: t('abbr_sub_max', M), subShort2: t('abbr2_sub_max', M) } : { sub: t('node_sub_single'), subShort: t('abbr_sub_single') };
  }
  if (state === 'idle') return { sub: t('node_sub_ondemand'), subShort: t('abbr_ondemand') };
  if (state === 'cut') return { sub: t('node_sub_cut'), subShort: t('abbr_cut') };
  if (state === 'testing') return { sub: t('node_sub_testing'), subShort: t('abbr_sub_testing') };
  return { sub: probeSnap?.error === 'timeout' ? t('node_sub_timeout') : t('node_sub_unreachable') };
}

// Every cell is three lines -- label, value, and a small second line under the value (when
// it was measured, how much of it came through LiteLLM, the embedding share, how many
// streams the server runs, how often it is probed); the card's subgrid lines the cells of
// all three node columns up row by row. v2.28: a cell is only as tall as its lines, so every
// cell has a second line in every state (a dash where there is nothing to say) -- a row of
// node cells is always three lines, with no blank under any value.
// The standard cell (nothing wraps); every line is .fit (fit.js shrinks it, then swaps in
// `short` / `subShort`, then cuts it). `value` is HTML (callers escape).
// labels whose short form is fixed (abbreviation table): Prefill t/s -> Prefill, Decode t/s -> Decode
const LABEL_SHORT = { node_prefill: 'abbr_prefill', node_decode: 'abbr_decode', node_latency: 'abbr_latency' };
const labelShortOf = (label) => { for (const [k, a] of Object.entries(LABEL_SHORT)) if (label === t(k)) return t(a); return null; };
// v2.29: `subShort2` = a still shorter second line ("10-23 11:40" for "10-23 11:40 · 44.3": the
// number goes to the title); `title` / `itemCls` on the cell itself. v2.31: `short2` likewise
// for the value ("推理 1/2" -> "推理": the 1000px two-column board cut even the short form).
// v2.46 `last`: { text, forms: [shorter, ...] } -- a small figure on the value line, right of the
// value (the Prefill / Decode cells' 「上次 xx」); fit.js shrinks it, then takes its shorter forms.
function cell(label, value, { cls = '', sub = '', short = null, short2 = null, subShort = null, subShort2 = null, labelShort = labelShortOf(label), title = '', itemCls = '', last = null } = {}) {
  const ds = (x, n = '') => (x != null && x !== '' ? ` data-short${n}="${esc(x)}"` : '');
  const lf = last ? [...new Set((last.forms || []).filter((f) => f && f !== last.text))] : [];
  return `<div class="item${itemCls ? ` ${itemCls}` : ''}${last ? ' has-last' : ''}"${title ? ` title="${esc(title)}"` : ''}><span class="label fit"${ds(labelShort)}>${esc(label)}</span>`
    + `<span class="value fit${cls ? ` ${cls}` : ''}"${ds(short)}${short2 && short2 !== short ? ds(short2, '2') : ''}>${value}</span>`
    + (last ? `<span class="vlast fit"${ds(lf[0])}${ds(lf[1], '2')}${ds(lf[2], '3')}>${esc(last.text)}</span>` : '')
    + (sub ? `<span class="sub fit"${ds(subShort)}${subShort2 && subShort2 !== subShort ? ds(subShort2, '2') : ''}>${esc(sub)}</span>` : '') + '</div>';
}

const fmt1 = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1));

// v2.46 Prefill / Decode, one rule for every node. The big figure is live only: the request
// running now (Prefill: this request's own -- llama.cpp measures it from the server's counters,
// Strata reports it once the request decodes; Decode: the rate right now), else "—". Beside it,
// small, 「上次 xx」/ Last xx: the newest FINISHED request's figure as the server recorded it (live.js
// done_prefill / done_decode, kept across restarts) -- the very point the detail chart ends on --
// shown whether or not a request is running and however long ago it was. The second line: while a
// request runs, what the big figure is (本次 / 实时 / 预填中 ...); otherwise when the 「上次」 request ended.
// (v2.25-v2.45 waited for a request to END before showing a Prefill: m25, never idle, showed "—".)
function lastOf(rec, what) {
  const v = rec ? fmt1(rec.tps) : '—';
  const r = rec ? String(Math.round(rec.tps)) : '—';
  return {
    text: t('node_last_val', v),
    // shorter (fit.js takes up to three): the whole number, then the short label, then the number
    // alone -- 10,000 and up as 23.5K (the title has it all)
    forms: [t('node_last_val', r), t('abbr_last_val', r), rec && rec.tps >= 9999.5 ? compact(rec.tps) : r],
    title: rec ? t('node_last_title', what, v, hm(rec.at / 1000), rec.exact !== false) : t('node_last_title_none', what),
  };
}
const whenOf = (rec) => (rec ? hm(rec.at / 1000) : t('node_no_rec'));

function speedCells(col, lv, live) {
  const preL = lastOf(lv?.done_prefill, 'Prefill'), decL = lastOf(lv?.done_decode, 'Decode');
  const mk = (label, value, { cls = '', sub, subShort = null }, L) => cell(label, value, { cls, sub, subShort, last: L, title: L.title });
  if (!lv) {
    const note = cv(col, 'speed_note') || t('node_no_speed_src');
    return mk(t('node_prefill'), '—', { sub: note }, preL) + mk(t('node_decode'), '—', { sub: note }, decL);
  }
  // idle, switched off, unreachable: no live figure, the last finished request beside the dash
  if (!live || !(lv.busy > 0)) {
    return mk(t('node_prefill'), '—', { sub: whenOf(lv.done_prefill) }, preL)
      + mk(t('node_decode'), '—', { sub: whenOf(lv.done_decode) }, decL);
  }
  const decoding = lv.phase === 'decode' || (lv.decoding || 0) > 0;
  let pre, preSub, preShort = null;
  if (Number(lv.max_streams) > 1) {
    // several streams: the newest prefill among the ones running, the streams prefilling named
    pre = lv.prefill_now;
    const list = lv.prefilling?.length ? lv.prefilling.map((n) => `#${n}`).join(' ') : '';
    preSub = list ? t('node_prefilling_n', list) : (pre != null ? t('node_this_req') : t('node_prefill_after'));
    preShort = list ? t('abbr_prefilling_n', list) : null;
  } else {
    pre = lv.prefill_tps;
    preSub = !decoding
      ? (lv.prefill_read ? t('node_prefill_read', Number(lv.prefill_read).toLocaleString('en-US')) : t('node_prefilling'))
      : (pre != null ? t(lv.prefill_exact ? 'node_this_req' : 'node_estimate') : t('node_prefill_after'));
  }
  const dec = lv.decode_tps;
  const decSub = dec != null
    ? ((lv.decoding || 0) >= 2 ? (Number(lv.max_streams) > 1 ? t('node_total_avg', fmt1(lv.decode_avg)) : t('node_parallel', lv.decoding)) : t('node_live'))
    : (decoding ? t('node_live') : t('node_wait_decode'));
  return mk(t('node_prefill'), pre != null ? fmt1(pre) : '—', { cls: pre != null ? 'lv-cool' : '', sub: preSub, subShort: preShort }, preL)
    + mk(t('node_decode'), dec != null ? fmt1(dec) : '—', { cls: dec != null ? 'lv-cool' : '', sub: decSub }, decL);
}

const nfmt = (x) => Number(x).toLocaleString('en-US');

// v2.26: the concurrency bar -- one cell per stream the server can run (fixed count, so the
// card does not jump as streams come and go): #n, phase, its own live speed, tokens decoded
// (with a thin bar when the request's max_tokens is known), the prompt while prefilling.
function streamCell(s) {
  const phase = t(s.state === 'decode' ? 'stream_decode' : s.state === 'prefill' ? 'stream_prefill' : 'stream_idle');
  let value = '—', sub = '', short = null, short2 = null, pct = null;
  if (s.state === 'decode') {
    value = fmt1(s.tps);
    // tokens generated (of max_tokens, when the request set one) and, where there is room,
    // the stream's prompt; shorter forms for a narrow cell: the counts in K, then the prompt
    // dropped (12,345 / 32,768 · prompt 9,362 -> 12.3K / 32.8K · prompt 9.36K -> 12.3K / 32.8K)
    const gen = (f) => (s.max ? t('stream_gen_of', f(s.gen ?? 0), f(s.max)) : t('stream_gen', f(s.gen ?? 0)));
    const withPrompt = (f) => gen(f) + (s.prompt != null ? ` · ${t('stream_prompt', f(s.prompt))}` : '');
    sub = withPrompt(nfmt);
    short = withPrompt(compact);
    // (with max_tokens the bar under the cell already shows how far along it is)
    short2 = t('abbr_stream_gen', compact(s.gen ?? 0));
    if (s.max) pct = Math.min(100, ((s.gen ?? 0) / s.max) * 100);
  } else if (s.state === 'prefill') {
    value = fmt1(s.tps);
    sub = s.prompt != null ? t('stream_prompt', nfmt(s.prompt)) + (s.read != null ? ` · ${t('stream_read', nfmt(s.read))}` : '') : '';
    short = s.prompt != null ? compact(s.prompt) + (s.read != null ? ` · ${t('abbr_stream_read', compact(s.read))}` : '') : null;
    if (s.prompt && s.read != null) pct = Math.min(100, (s.read / s.prompt) * 100);
  } else if (s.held != null) {
    sub = t('stream_cached', nfmt(s.held));
    short = t('stream_cached', compact(s.held));
    short2 = t('abbr_stream_cached', compact(s.held));
  } else sub = t('stream_no_cache');
  // v2.28: never without a second line (the bar's cells are three lines in every state)
  if (!sub) sub = t('stream_prompt', '—');
  const bar = `<span class="sbar${pct == null ? ' none' : ''}"><i style="width:${pct == null ? 0 : pct.toFixed(1)}%"></i></span>`;
  const ds = (short && short !== sub ? ` data-short="${esc(short)}"` : '') + (short2 && short2 !== short ? ` data-short2="${esc(short2)}"` : '');
  const phaseShort = s.state === 'decode' ? t('abbr_stream_decode') : s.state === 'prefill' ? t('abbr_stream_prefill') : null;
  const ls = phaseShort && phaseShort !== phase ? ` data-short="#${s.n} · ${esc(phaseShort)}"` : '';
  return `<div class="item stream stream-${s.state}"><span class="label fit"${ls}>#${s.n} · ${esc(phase)}</span>`
    + `<span class="value fit${s.state === 'idle' ? '' : ' lv-cool'}">${value}</span>`
    + (sub ? `<span class="sub fit"${ds}>${esc(sub)}</span>` : '') + `${bar}</div>`;
}

function streamsBar(lv, online) {
  const M = Number(lv?.max_streams) || 1;
  if (M < 2) return '';
  const streams = online && Array.isArray(lv.streams) && lv.streams.length === M ? lv.streams
    : Array.from({ length: M }, (_, i) => ({ n: i + 1, state: 'idle', held: null }));
  // columns per row when the bar cannot share the cell grid's columns: a divisor of M, so
  // every row is full
  const mc = M <= 4 ? M : [4, 3, 5, 2].find((c) => M % c === 0) || M;
  return `<div class="node-streams" data-m="${M}" style="--m:${M};--mc:${mc}">${streams.map(streamCell).join('')}</div>`;
}

// v2.29 the engine found on the node, for the column's title
function engineTitle(e) {
  if (!e) return '';
  const parts = [];
  if (e.engine) {
    parts.push(t('engine_line', e.name, `${e.host}:${e.port}`, e.mirror));
    if (e.slots) parts.push(t('engine_slots', e.slots));
    if (e.since) parts.push(t('engine_since', hm(e.since / 1000)));
  } else parts.push(t('engine_unknown'));
  parts.push(t('engine_cands', (e.candidates || []).join(' / ')));
  if (e.checked) parts.push(t('engine_checked', hm(e.checked / 1000)));
  return parts.join(' · ') + (e.error ? `\n${t('engine_err', e.error)}` : '');
}

// v2.49 why a figure carries the ≈ (server/collectors/nodes.js nodeFigures `mark`), and what it is made of
function ctrMarkTitle(m) {
  const at = m.since ? hm(m.since) : '—';
  let reason;
  if (m.code === 'low') reason = t('ctr_reason_low', nfmt(m.value), nfmt(m.ll));
  else if (m.code === 'stale') {
    reason = m.why === 'down' ? t('ctr_reason_stale_down', m.instance || '?', at, m.detail)
      : m.why === 'missing' ? t('ctr_reason_stale_missing', m.instance || '?', at) : t('ctr_reason_stale', at);
  } else reason = t('ctr_reason_read', m.detail || '?');
  const src = m.source === 'ctr+ll' ? t('ctr_src_ctr_ll', at) : m.source === 'last+ll' ? t('ctr_src_last_ll', at) : t('ctr_src_ll');
  return t('ctr_mark_title', reason, src);
}

// v2.49 the restarts a figure was stitched across (the newest three; the rest counted)
function restartLines(list, key) {
  const rs = list || [];
  const shown = rs.slice(-3).map((r) => t('ctr_restart_title', hm(r.p), r.lost ? (key.endsWith('reqs') ? nfmt(r.lost) : nfmt(Math.round(r.lost))) : null));
  return rs.length > 3 ? [t('ctr_restart_more', rs.length - 3), ...shown] : shown;
}

// the stretches of today a counter did NOT cover, "00:00–04:35, 13:10–13:40"
function gapRanges(cover, dayStart, nowSec) {
  const out = [];
  let at = dayStart;
  for (const [a, b] of cover || []) {
    if (a - at > 60) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (nowSec - at > 120) out.push([at, nowSec]);
  return out.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ');
}

/**
 * @param gc       layout card ({ type: nodes, target: <inference_nodes id>, nodes: [...] })
 * @param resolve  id → { target, snap }
 */
export function renderNodes(gc, resolve) {
  const meta = resolve(gc.target).snap;
  // v2.26: does any node here run several streams? Then every column's cell grid gets the
  // stream row (empty where there is no bar), so the row gaps -- and with them the cells'
  // tops and bottoms -- match across the columns. With none, the grid is as before.
  const liveOf = (node) => (gc.live ? resolve(gc.live).snap?.extra?.live?.nodes?.[node] || null : null);
  const anyMulti = (gc.nodes || []).some((c) => Number(liveOf(c.node)?.max_streams) > 1);
  const cols = (gc.nodes || []).map((col, idx) => {
    const { target: probeT, snap: probeS } = resolve(col.probe);
    const mach = resolve(col.node)?.snap || null;          // v2.39: the machine of the same id (its agent)
    const state = nodeState(probeT, probeS, mach);
    // v2.25 live state of this node (inference_live target named by the card's `live`)
    const lv = gc.live ? resolve(gc.live).snap?.extra?.live?.nodes?.[col.node] || null : null;
    const busy = nodeBusy(state, lv);
    const name = cv(col, 'name') || col.node;

    // which instance(s) route here, as discovered from litellm itself (not configured).
    // "litellm 4002" = the route the architecture intends; a live route to an instance
    // that is not meant to serve this node is struck through and marked "to be removed";
    // an intended route that is not live yet is greyed "not connected".
    // v2.46 a fallback route says which fallback it is, in the order the instance's own
    // router_settings.fallbacks gives (server/collectors/nodes.js): "litellm 4000 · 4001 备援1" --
    // after another route its "litellm" is left out, the port and the order are what matter.
    const route = meta?.extra?.nodes?.[col.node];
    let port = '—';
    if (route && Array.isArray(route.routes)) {
      port = route.routes.length ? route.routes.map((r, k) => {
        const lbl = esc(t('node_litellm_port', r.port));
        // v2.40 a fallback route (4001 -> m133, then m26, while m25's resident instance is off)
        if (r.live && r.fallback) {
          const n = Number(r.fallback_n) || null;
          const text = `${k > 0 ? esc(String(r.port)) : lbl} ${esc(n ? t('node_route_fb_n', n) : t('node_route_fb'))}`;
          return `<span class="node-route node-route-fb" title="${esc(n ? t('node_route_fb_n_title', r.port, n) : t('node_route_fb_title', r.port))}">${text}</span>`;
        }
        if (r.live && r.intended) return `<span class="node-route">${lbl}</span>`;
        if (r.live) return `<span class="node-route-stale"><s>${lbl}</s> ${esc(t('node_route_stale'))}</span>`;
        return `<span class="node-route-pending">${lbl} ${esc(t('node_route_pending'))}</span>`;
      }).join('<span class="node-route-sep">·</span>') : esc(t('node_unrouted'));
    }
    const pub = route?.public ? `<span class="node-pub">${esc(t('node_public_via', route.public))}</span>` : '';

    // model: live from the node's own endpoint; greyed last-seen name when it is down
    const mm = probeS?.metrics?.model;
    const model = mm?.display && mm.display !== '—' ? mm.display : '—';
    const modelCls = state === 'online' ? '' : ' is-last';
    const modelTitle = state === 'online' ? '' : ` title="${esc(t('node_model_last'))}"`;

    const lat = state === 'online' ? esc(probeS?.metrics?.latency?.display || '—') : '—';
    // Today's usage. The big numbers are the machine's TOTAL from its own counters
    // (requests that never touched LiteLLM included); the second line is the LiteLLM share
    // and, on a node that also serves embeddings, the embedding server's own count.
    const mv = (k) => meta?.metrics?.[`${col.node}_${k}`]?.value;
    const cnt = meta?.extra?.nodes?.[col.node]?.counters || {};
    // v2.27: each second line with its short form ("经 LLM 52.2M · 嵌入 1.2M" -> "LLM 52.2M · 嵌 1.2M")
    const subOf = (ll, emb, embLl) => {
      const parts = [], short = [];
      if (mv(ll) != null) { parts.push(t('node_sub_ll', compact(mv(ll)))); short.push(t('abbr_ll', compact(mv(ll)))); }
      const e = mv(emb) != null ? mv(emb) : mv(embLl);
      if (e != null) { parts.push(t('node_sub_emb', compact(e))); short.push(t('abbr_emb', compact(e))); }
      // (v2.28: no counter read yet -- still a second line, so the row stays three lines)
      if (!parts.length) return { sub: t('node_sub_ll', '—'), subShort: t('abbr_ll', '—') };
      return { sub: parts.join(' · '), subShort: short.join(' · ') };
    };
    const reqSub = meta && !cnt.requests ? { sub: t('node_no_req_counter'), subShort: t('abbr_no_counter') } : subOf('ll_reqs', 'emb_reqs', 'emb_ll_reqs');
    // v2.49 the figure always -- the ledger's, the most credible one there is (v2.29-v2.48 put "Counter
    // error" in its place); where the server marks it really uncertain, a small yellow ≈ before it, the
    // reason and the source in the title. The title also says which restarts it was stitched across and
    // how much of it came from LiteLLM because the counter missed part of the day (and when).
    const usage = (key, label, labelShort, sub) => {
      const k = cnt.kinds?.[key];
      const v = mv(key);
      const nowSec = Date.now() / 1000, day0 = Number(meta?.extra?.day_start) || 0;
      const lines = [];
      if (k?.mark) lines.push(ctrMarkTitle(k.mark));
      if (k?.restarts?.length) lines.push(...restartLines(k.restarts, key));
      if (k && k.gap > 0 && day0) lines.push(t('ctr_gap_title', compact(k.gap), gapRanges(k.cover, day0, nowSec)));
      const mark = k?.mark && v != null ? '<span class="ctr-mark">≈</span>' : '';
      return cell(label, mark + esc(v == null ? '—' : compact(v)), { ...sub, labelShort, title: lines.join('\n') });
    };
    // busy: "推理中" in cyan the moment the server has a request in flight, before any speed
    const multi = Number(lv?.max_streams) > 1;
    const statusCell = busy
      ? (multi
        // "推理中 N/M": streams running / streams the server can run (read from it); in a
        // column too narrow for it, "推理 N/M" / "Gen N/M" (abbreviation table), then just
        // "推理" / "Gen" -- the concurrency bar under the column shows each stream anyway
        ? cell(t('node_status'), esc(`${t('node_busy')} ${lv.running}/${lv.max_streams}`), { cls: 'lv-cool', short: `${t('abbr_busy')} ${lv.running}/${lv.max_streams}`, short2: t('abbr_busy'), sub: lv.queued ? t('node_queued', lv.queued) : t('node_no_queue') })
        : cell(t('node_status'), esc(t('node_busy')), { cls: 'lv-cool', short: t('abbr_busy'), sub: t('node_busy_n', lv.busy) + (lv.queued ? ` · ${t('node_queued', lv.queued)}` : '') }))
      : state === 'testing'
        // v2.40 "测试中 · 18082": which port the test instance listens on; its unit(s) in the title
        ? cell(t('node_status'), esc(`${t('node_testing')} · ${testingPorts(mach)[0]}`), { cls: STATE_CLASS.testing,
          short: `${t('abbr_testing')} ${testingPorts(mach)[0]}`, short2: t('abbr_testing'), ...statusSub(state, probeS, lv),
          title: t('node_testing_title', col.node, mach?.extra?.strata?.resident_unit || '', (mach?.extra?.strata?.listen || []).map((x) => `127.0.0.1:${x.port} (${x.unit || '?'})`).join(', ')) })
        : cell(t('node_status'), esc(statusText(state, probeT)), { cls: STATE_CLASS[state], short: statusShort(state, probeT), ...statusSub(state, probeS, lv),
          ...(state === 'cut' ? { title: t('node_cut_title', col.node, Number(mach?.extra?.strata?.procs) || 0, probeS?.error || '') } : {}) });
    // v2.28 latency's second line: how often the hub probes the node (the target's interval)
    const iv = probeT?.interval;
    // (v2.30: and in the narrowest column only the interval, the rest in the title)
    const latSub = iv ? { sub: t('node_sub_probe', iv), subShort: t('abbr_probe', iv), subShort2: iv } : { sub: t('node_sub_probe_any') };
    const cells = statusCell
      + cell(t('node_latency'), lat, latSub)
      + speedCells(col, lv, state === 'online' && !!lv?.reachable)
      + usage('reqs', t('node_reqs'), t('abbr_node_reqs'), reqSub)
      + usage('tokens', t('node_tokens'), t('abbr_node_tokens'), subOf('ll_tokens', 'emb_tokens', 'emb_ll_tokens'));

    const eng = engineTitle(lv?.engine);
    return `<div class="node-col node-${state}${busy ? ' node-busy' : ''}" data-col="${idx}"${eng ? ` title="${esc(eng)}"` : ''}>`
      + `<div class="node-head"${eng ? ` title="${esc(eng)}"` : ''}><span class="node-name">${esc(name)}</span><span class="node-port fit" data-min="10">· ${port}</span>${pub}</div>`
      + `<div class="node-model fit${modelCls}"${modelTitle || ` title="${esc(model)}"`}>${esc(model)}</div>`
      + `<div class="kv node-kv${anyMulti ? ' has-streams' : ''}">${cells}${multi ? streamsBar(lv, state === 'online' && lv.reachable) : (anyMulti ? '<div class="node-streams" data-m="0"></div>' : '')}</div>`
      + '</div>';
  });
  return {
    ...card({
      key: gc.key || `nodes:${gc.target}`,
      title: cv(gc, 'title') || t('node_card_title'),
      body: `<div class="nodes-grid">${cols.join('')}</div>`,
      accent: gc.accent || '',
      kind: 'nodes',
      clickable: gc.clickable === 'detail',
      detail: { ranges: gc.detail_ranges || null, gc },
    }),
    wide: true,
  };
}
