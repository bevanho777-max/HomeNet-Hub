// machine renderer (§6) — rings + KV grid + header_right (uptime/badge).
import { ring, kvItem, mget, card, esc } from './common.js';
import { cv, t } from '../i18n.js';

export function renderMachine(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';

  if (!snap || snap.online === false) {
    // Still clickable while offline: the host has no live values but its history is
    // exactly what you want to look at when it stops reporting.
    return card({
      key: target.id, title, tag: target.badge || '', accent,
      stale: true, kind: 'machine', clickable: gridCard.clickable === 'detail',
      body: `<div class="note">Host offline / no data${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  // i18n: a metric template may carry `label_en`; with none, the base label is used in
  // both languages rather than falling back to the bare key.
  const label = (k) => cv(metrics?.[k], 'label') || k;
  const rings = (gridCard.rings || []).map((k) => ring(label(k), mget(snap, k))).join('');
  const items = (gridCard.items || []).map((k) => kvItem(label(k), mget(snap, k), metrics?.[k])).join('');

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

  // v2.18: fewer GPUs detected than the target's gpu_count. Said in words on the card
  // face, because the aggregates alone would look perfectly healthy with one card gone.
  const gc = snap.metrics?.gpu_cards;
  const warn = gc && gc.expected && typeof gc.value === 'number' && gc.value < gc.expected
    ? `<div class="gpu-missing">${esc(t('gpu_cards_missing', gc.value, gc.expected))}</div>` : '';

  const body = `${warn}<div class="rings">${rings}</div>${items ? `<div class="kv">${items}</div>` : ''}`;
  return card({
    key: target.id, title, tag, body, accent, stale: snap.stale,
    kind: 'machine', clickable: gridCard.clickable === 'detail',
  });
}
