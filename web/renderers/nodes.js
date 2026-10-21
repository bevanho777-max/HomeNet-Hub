// nodes renderer (v2.20) — 推理节点 / Inference Nodes: one full-width card, one column per
// inference machine, replacing the separate Inference · NN and Speed · NN half-cards.
//
// Each column is assembled from three sources, all of which already exist on the hub:
//   probe  (http target)      → status, latency, the model ID the node itself reports
//   speed  (prometheus target)→ prefill / decode with measurement age (normalize.js freshness)
//   meta   (inference_nodes)  → today's requests / tokens for this node, and the litellm
//                               instance port(s) that actually route to it
//
// Status is one vocabulary for every node: Online / No service / Down. A node whose probe
// target says `always_on: false` (m110 is switched off a lot) is grey when unreachable, never
// red; every other node going unreachable is a fault. Columns never reorder or disappear —
// a dead node keeps its slot so the other two do not jump.
import { card, esc } from './common.js';
import { cv, t } from '../i18n.js';

function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  n = Number(n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function hm(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const p2 = (x) => ('0' + x).slice(-2);
  const s = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? s : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${s}`;
}

// 'online' | 'idle' | 'down'
export function nodeState(probeTarget, probeSnap) {
  if (probeSnap && probeSnap.online !== false) return 'online';
  return probeTarget?.always_on === false ? 'idle' : 'down';
}

const STATE_CLASS = { online: 'lv-ok', idle: 'node-idle-text', down: 'lv-danger' };

function statusText(state, probeTarget) {
  if (state === 'online') return t('node_online');
  if (state === 'down') return t('node_down');
  // always_on:false machines are usually just switched off — say both, since the hub
  // cannot tell "powered off" from "on but not serving".
  return probeTarget?.always_on === false ? t('node_off') : t('node_idle');
}

// v2.23: every cell is three lines -- label, value, and a small second line under the value
// (when it was measured, how much of it came through LiteLLM, the embedding share). The
// second line is always rendered, empty when there is nothing to say, so a cell without one
// is exactly as tall as its neighbours; the card's subgrid then lines the cells of all three
// node columns up row by row.
function cell(label, value, { cls = '', sub = '' } = {}) {
  return `<div class="item"><span class="label">${esc(label)}</span>`
    + `<span class="value ${cls}">${value}</span>`
    + `<span class="sub">${sub ? esc(sub) : '&nbsp;'}</span></div>`;
}

const fmt1 = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1));

// v2.25: the live state (read from the server itself every 2 s, pushed to the browser).
// While a request runs: prefill / decode as they happen. Afterwards: the newer of the live
// "last" reading and the Prometheus one, with the same freshness rule as before.
function liveSpeedCells(lv) {
  const decoding = lv.phase === 'decode';
  const preVal = lv.prefill_tps != null ? fmt1(lv.prefill_tps) : '—';
  const preSub = !decoding
    ? (lv.prefill_read ? t('node_prefill_read', Number(lv.prefill_read).toLocaleString('en-US')) : t('node_prefilling'))
    : (lv.prefill_tps != null ? t(lv.prefill_exact ? 'node_this_req' : 'node_estimate') : t('node_prefill_after'));
  const decVal = lv.decode_tps != null ? fmt1(lv.decode_tps) : '—';
  const decSub = decoding ? (lv.decoding > 1 ? t('node_parallel', lv.decoding) : t('node_live')) : t('node_wait_decode');
  return cell(t('node_prefill'), preVal, { cls: lv.prefill_tps != null ? 'lv-cool' : '', sub: preSub })
    + cell(t('node_decode'), decVal, { cls: lv.decode_tps != null ? 'lv-cool' : '', sub: decSub });
}

// v2.26: a node with several concurrent streams (Strata "parallel", llama.cpp -np): Decode
// is the sum of the streams' live rates, labelled as a total, with the per-stream average
// under it; Prefill is the most recent prefill, with the streams prefilling now named.
function multiSpeedCells(lv) {
  const lp = lv.last_prefill;
  const preVal = lp ? fmt1(lp.tps) : '—';
  const preSub = lv.prefilling?.length
    ? t('node_prefilling_n', lv.prefilling.map((n) => `#${n}`).join(' '))
    : (lp ? t('measured_at', hm(lp.at / 1000)) : t('node_prefill_after'));
  const decVal = lv.decode_tps != null ? fmt1(lv.decode_tps) : '—';
  const decSub = lv.decode_tps != null ? t('node_total_avg', fmt1(lv.decode_avg))
    : (lv.decoding ? t('node_live') : t('node_wait_decode'));
  return cell(t('node_prefill'), preVal, { sub: preSub })
    + cell(t('node_decode'), decVal, { cls: lv.decode_tps != null ? 'lv-cool' : '', sub: decSub });
}

const nfmt = (x) => Number(x).toLocaleString('en-US');

// v2.26: the concurrency bar -- one cell per stream the server can run (fixed count, so the
// card does not jump as streams come and go): #n, phase, its own live speed, tokens decoded
// (with a thin bar when the request's max_tokens is known), the prompt while prefilling.
function streamCell(s) {
  const phase = t(s.state === 'decode' ? 'stream_decode' : s.state === 'prefill' ? 'stream_prefill' : 'stream_idle');
  let value = '—', sub = '', pct = null;
  if (s.state === 'decode') {
    value = fmt1(s.tps);
    sub = s.max ? t('stream_gen_of', nfmt(s.gen ?? 0), nfmt(s.max)) : t('stream_gen', nfmt(s.gen ?? 0));
    if (s.max) pct = Math.min(100, ((s.gen ?? 0) / s.max) * 100);
  } else if (s.state === 'prefill') {
    value = fmt1(s.tps);
    sub = s.prompt != null ? t('stream_prompt', nfmt(s.prompt)) + (s.read != null ? ` · ${t('stream_read', nfmt(s.read))}` : '') : '';
    if (s.prompt && s.read != null) pct = Math.min(100, (s.read / s.prompt) * 100);
  } else if (s.held != null) {
    sub = t('stream_cached', nfmt(s.held));
  }
  const bar = `<span class="sbar${pct == null ? ' none' : ''}"><i style="width:${pct == null ? 0 : pct.toFixed(1)}%"></i></span>`;
  return `<div class="item stream stream-${s.state}"><span class="label">#${s.n} · ${esc(phase)}</span>`
    + `<span class="value${s.state === 'idle' ? '' : ' lv-cool'}">${value}</span>`
    + `<span class="sub">${sub ? esc(sub) : '&nbsp;'}</span>${bar}</div>`;
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

function speedCells(speedSnap, col, speedTarget, lv = null) {
  if (lv?.reachable && lv.busy > 0) return (lv.max_streams > 1 ? multiSpeedCells : liveSpeedCells)(lv);
  // a request the live reader saw end, newer than the last Prometheus measurement
  const L = lv?.last;
  const promAt = Math.max(Number(speedSnap?.metrics?.prefill_speed?.at) || 0, Number(speedSnap?.metrics?.decode_speed?.at) || 0);
  if (L && L.at / 1000 >= promAt) {
    // a multi-stream node's Prefill is the most recent prefill of ANY stream (the last
    // request to end may have read a fully cached prompt, with no prefill of its own)
    const P = lv.max_streams > 1 && lv.last_prefill ? { v: lv.last_prefill.tps, at: lv.last_prefill.at / 1000, expired: lv.last_prefill.expired }
      : { v: L.prefill, at: L.at / 1000, expired: L.expired };
    const at = L.at / 1000;
    const pre = !P.expired ? cell(t('node_prefill'), fmt1(P.v), { sub: t('measured_at', hm(P.at)) })
      : cell(t('node_prefill'), '—', { sub: t('node_sub_last', hm(P.at), fmt1(P.v)) });
    const dec = !L.expired ? cell(t('node_decode'), fmt1(L.decode), { sub: t('measured_at', hm(at)) })
      : cell(t('node_decode'), '—', { sub: t('node_sub_last', hm(at), fmt1(L.decode)) });
    return pre + dec;
  }
  const pp = speedSnap?.metrics?.prefill_speed, tg = speedSnap?.metrics?.decode_speed;
  const both = (sub) => cell(t('node_prefill'), '—', { sub }) + cell(t('node_decode'), '—', { sub });
  if (!col.speed) return both(cv(col, 'speed_note') || t('node_no_speed_src'));
  if (!speedSnap || speedSnap.online === false) return both(t('node_speed_unavailable'));
  const expired = pp?.expired && tg?.expired;
  const ats = [pp?.at, tg?.at].filter((a) => typeof a === 'number');
  const at = ats.length ? Math.max(...ats) : null;
  if (expired || (!pp && !tg)) {
    // Nothing fresh: the value is a dash and the second line says what the last reading
    // was and when -- each cell its own number.
    if (at == null) return both(t('measured_none', speedTarget?.freshness?.lookback));
    const last = (m) => t('node_sub_last', hm(at), m?.last != null ? m.last : '—');
    return cell(t('node_prefill'), '—', { sub: last(pp) }) + cell(t('node_decode'), '—', { sub: last(tg) });
  }
  const v = (m) => (m && !m.expired ? esc(m.display) : '—');
  const sub = at ? t('measured_at', hm(at)) : '';
  return cell(t('node_prefill'), v(pp), { sub }) + cell(t('node_decode'), v(tg), { sub });
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
    const { target: speedT, snap: speedS } = col.speed ? resolve(col.speed) : { target: null, snap: null };
    const state = nodeState(probeT, probeS);
    // v2.25 live state of this node (inference_live target named by the card's `live`)
    const lv = gc.live ? resolve(gc.live).snap?.extra?.live?.nodes?.[col.node] || null : null;
    const busy = state === 'online' && lv?.reachable && lv.busy > 0;
    const name = cv(col, 'name') || col.node;

    // which instance(s) route here, as discovered from litellm itself (not configured).
    // "litellm 4002" = the route the architecture intends; a live route to an instance
    // that is not meant to serve this node is struck through and marked "to be removed";
    // an intended route that is not live yet is greyed "not connected".
    const route = meta?.extra?.nodes?.[col.node];
    let port = '—';
    if (route && Array.isArray(route.routes)) {
      port = route.routes.length ? route.routes.map((r) => {
        const lbl = esc(t('node_litellm_port', r.port));
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
    const subOf = (ll, emb, embLl) => {
      const parts = [];
      if (mv(ll) != null) parts.push(t('node_sub_ll', compact(mv(ll))));
      const e = mv(emb) != null ? mv(emb) : mv(embLl);
      if (e != null) parts.push(t('node_sub_emb', compact(e)));
      return parts.join(' · ');
    };
    const reqSub = meta && !cnt.requests ? t('node_no_req_counter') : subOf('ll_reqs', 'emb_reqs', 'emb_ll_reqs');
    // busy: "推理中" in cyan the moment the server has a request in flight, before any speed
    const multi = Number(lv?.max_streams) > 1;
    const statusCell = busy
      ? (multi
        // "推理中 N/M": streams running / streams the server can run (read from it)
        // (may wrap between the word and N/M: "Generating 2/3" does not fit a phone's status column)
        ? cell(t('node_status'), esc(`${t('node_busy')} ${lv.running}/${lv.max_streams}`), { cls: 'lv-cool wrap', sub: lv.queued ? t('node_queued', lv.queued) : '' })
        : cell(t('node_status'), esc(t('node_busy')), { cls: 'lv-cool', sub: t('node_busy_n', lv.busy) + (lv.queued ? ` · ${t('node_queued', lv.queued)}` : '') }))
      : cell(t('node_status'), esc(statusText(state, probeT)), { cls: STATE_CLASS[state] });
    const cells = statusCell
      + cell(t('node_latency'), lat)
      + speedCells(speedS, col, speedT, state === 'online' ? lv : null)
      + cell(t('node_reqs'), compact(mv('reqs')), { sub: reqSub })
      + cell(t('node_tokens'), compact(mv('tokens')), { sub: subOf('ll_tokens', 'emb_tokens', 'emb_ll_tokens') });

    return `<div class="node-col node-${state}${busy ? ' node-busy' : ''}" data-col="${idx}">`
      + `<div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-port">· ${port}</span>${pub}</div>`
      + `<div class="node-model${modelCls}"${modelTitle}>${esc(model)}</div>`
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
