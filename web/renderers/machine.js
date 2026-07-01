// machine renderer (§6) — rings + KV grid + header_right (uptime/badge).
import { ring, kvItem, mget, card, esc } from './common.js';

export function renderMachine(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';

  if (!snap || snap.online === false) {
    return card({
      key: target.id, title, tag: target.badge || '', accent,
      stale: true,
      body: `<div class="note">Host offline / no data${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  const label = (k) => metrics?.[k]?.label || k;
  const rings = (gridCard.rings || []).map((k) => ring(label(k), mget(snap, k))).join('');
  const items = (gridCard.items || []).map((k) => kvItem(label(k), mget(snap, k))).join('');

  // header_right: a metric key (e.g. uptime) → its display, or "badge"
  let tag = target.badge || '';
  if (gridCard.header_right) {
    tag = gridCard.header_right === 'badge' ? (target.badge || '') : (mget(snap, gridCard.header_right).display || tag);
  }

  const body = `<div class="rings">${rings}</div>${items ? `<div class="kv">${items}</div>` : ''}`;
  return card({ key: target.id, title, tag, body, accent, stale: snap.stale });
}
