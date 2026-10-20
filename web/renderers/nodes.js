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

function speedCells(speedSnap, col, speedTarget) {
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
    const cells = cell(t('node_status'), esc(statusText(state, probeT)), { cls: STATE_CLASS[state] })
      + cell(t('node_latency'), lat)
      + speedCells(speedS, col, speedT)
      + cell(t('node_reqs'), compact(mv('reqs')), { sub: reqSub })
      + cell(t('node_tokens'), compact(mv('tokens')), { sub: subOf('ll_tokens', 'emb_tokens', 'emb_ll_tokens') });

    return `<div class="node-col node-${state}" data-col="${idx}">`
      + `<div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-port">· ${port}</span>${pub}</div>`
      + `<div class="node-model${modelCls}"${modelTitle}>${esc(model)}</div>`
      + `<div class="kv node-kv">${cells}</div>`
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
