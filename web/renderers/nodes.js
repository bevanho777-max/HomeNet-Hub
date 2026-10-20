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

function cell(label, value, cls = '', small = false) {
  return `<div class="item"><span class="label">${esc(label)}</span>`
    + `<span class="value ${cls}"${small ? ' style="font-size:12px"' : ''}>${value}</span></div>`;
}

function speedCells(speedSnap, col, speedTarget) {
  const pp = speedSnap?.metrics?.prefill_speed, tg = speedSnap?.metrics?.decode_speed;
  if (!col.speed) {
    return { cells: cell(t('node_prefill'), '—') + cell(t('node_decode'), '—'),
      note: cv(col, 'speed_note') || t('node_no_speed_src') };
  }
  if (!speedSnap || speedSnap.online === false) {
    return { cells: cell(t('node_prefill'), '—') + cell(t('node_decode'), '—'), note: t('node_speed_unavailable') };
  }
  const expired = pp?.expired && tg?.expired;
  const ats = [pp?.at, tg?.at].filter((a) => typeof a === 'number');
  const at = ats.length ? Math.max(...ats) : null;
  if (expired || (!pp && !tg)) {
    const lastPp = pp?.last != null ? pp.last : '—', lastTg = tg?.last != null ? tg.last : '—';
    const note = at == null ? t('measured_none', speedTarget?.freshness?.lookback) : t('node_speed_last', hm(at), lastPp, lastTg);
    return { cells: cell(t('node_prefill'), '—') + cell(t('node_decode'), '—'), note };
  }
  const v = (m) => (m && !m.expired ? esc(m.display) : '—');
  return { cells: cell(t('node_prefill'), v(pp)) + cell(t('node_decode'), v(tg)), note: at ? t('measured_at', hm(at)) : '' };
}

/**
 * @param gc       layout card ({ type: nodes, target: <inference_nodes id>, nodes: [...] })
 * @param resolve  id → { target, snap }
 */
export function renderNodes(gc, resolve) {
  const meta = resolve(gc.target).snap;
  const cols = (gc.nodes || []).map((col, idx) => {
    const { target: probeT, snap: probeS } = resolve(col.probe);
    const { target: speedT, snap: speedS } = col.speed ? resolve(col.speed) : { target: null, snap: null };
    const state = nodeState(probeT, probeS);
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
    const sp = speedCells(speedS, col, speedT);
    // Today's usage. The big numbers are the machine's TOTAL from its own counters
    // (requests that never touched LiteLLM included); the grey line is the LiteLLM share.
    const mv = (k) => meta?.metrics?.[`${col.node}_${k}`]?.value;
    const cnt = meta?.extra?.nodes?.[col.node]?.counters || {};
    const usage = cell(t('node_reqs'), compact(mv('reqs'))) + cell(t('node_tokens'), compact(mv('tokens')));
    const notes = [];
    if (meta && !cnt.requests) notes.push(t('node_no_req_counter'));
    if (mv('ll_reqs') != null) notes.push(t('node_via_ll', compact(mv('ll_reqs')), compact(mv('ll_tokens'))));
    const llNote = notes.length ? `<div class="note node-ll">${esc(notes.join(' · '))}</div>` : '';
    const emb = mv('emb_ll_reqs') != null
      ? `<div class="note node-emb">${esc(t('node_emb_ll', compact(mv('emb_ll_reqs')), compact(mv('emb_ll_tokens'))))}</div>` : '';

    return `<div class="node-col node-${state}" data-col="${idx}">`
      + `<div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-port">· ${port}</span>${pub}</div>`
      + `<div class="node-model${modelCls}"${modelTitle}>${esc(model)}</div>`
      + '<div class="kv">'
      + cell(t('node_status'), esc(statusText(state, probeT)), STATE_CLASS[state])
      + cell(t('node_latency'), lat)
      + sp.cells
      + usage
      + '</div>'
      + (sp.note ? `<div class="note node-note">${esc(sp.note)}</div>` : '')
      + llNote
      + emb
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
