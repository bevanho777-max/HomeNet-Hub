// service renderer (§6) — no rings; KV list + header_right status/badge.
import { card, mget, lvClass, esc } from './common.js';

// status string → status level (online=ok, unknown=neutral, else danger)
function statusLevel(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s === 'online' || s === 'running' || s === 'ok' || s === 'up') return 'ok';
  if (s === 'unknown' || s === '') return null;
  return 'danger';
}

export function renderService(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';

  if (!snap || snap.online === false) {
    return card({
      key: target.id, title, tag: 'offline', accent, stale: true,
      body: `<div class="note">Unavailable${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  const label = (k) => metrics?.[k]?.label || k;

  // header_right: "status" → colored status value, "badge" → target.badge, else metric
  let tag = '';
  if (gridCard.header_right === 'status') {
    const m = mget(snap, 'status');
    const lvl = statusLevel(m.value);
    tag = `<span class="${lvClass(lvl)}">${esc(m.display)}</span>`;
  } else if (gridCard.header_right === 'badge') {
    tag = esc(target.badge || '');
  } else if (gridCard.header_right) {
    tag = esc(mget(snap, gridCard.header_right).display || '');
  }

  const items = (gridCard.items || []).map((k) => {
    const m = mget(snap, k);
    const small = (k === 'model' || k === 'role') ? ' style="font-size:12px"' : '';
    const cls = k === 'status' ? lvClass(statusLevel(m.value)) : lvClass(m.level);
    return `<div class="item"><span class="label">${esc(label(k))}</span><span class="value ${cls}"${small}>${esc(m.display)}</span></div>`;
  }).join('');

  return card({ key: target.id, title, tag, body: `<div class="kv">${items}</div>`, accent, stale: snap.stale });
}
