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

  // header_right: 'badge' → target.badge, else a metric key → its display.
  // B13: an array combines parts with a vertical hairline, e.g. [badge, uptime]
  // → "RX 7900XTX │ 15d 7h". Backward-compatible with a single string.
  const hrPart = (el) => (el === 'badge' ? (target.badge || '') : (mget(snap, el).display || ''));
  let tag = target.badge || '';
  if (gridCard.header_right) {
    tag = Array.isArray(gridCard.header_right)
      ? gridCard.header_right.map(hrPart).filter((s) => s && s !== '—').map(esc).join('<span class="tag-sep"></span>')
      : (gridCard.header_right === 'badge' ? (target.badge || '') : (mget(snap, gridCard.header_right).display || tag));
  }

  const body = `<div class="rings">${rings}</div>${items ? `<div class="kv">${items}</div>` : ''}`;
  return card({ key: target.id, title, tag, body, accent, stale: snap.stale });
}
