// info renderer (§12-step4) — generic label/value list card.
// Fully layout-driven: each item is { label, value, level? }. `value` is a
// literal string, with optional {metric} placeholders resolved from this card's
// target snapshot (same templating as header_right). No per-purpose logic — add
// any "info box" by adding a type:info card in layout.yaml, zero code changes.
import { card, mget, lvClass, esc } from './common.js';

export function renderInfo(gridCard, target, snap) {
  const title = gridCard.title || target?.name || target?.id || 'Info';
  const accent = target?.color || '';

  const items = (gridCard.items || []).map((it) => {
    if (it == null || typeof it !== 'object') return '';
    const val = String(it.value ?? '').replace(/\{(\w+)\}/g, (_, k) => mget(snap, k).display ?? '—');
    const cls = it.level ? lvClass(it.level) : '';
    return `<div class="item"><span class="label">${esc(it.label)}</span><span class="value ${cls}">${esc(val)}</span></div>`;
  }).join('');

  return card({ key: gridCard.target || title, title, body: `<div class="kv">${items}</div>`, accent });
}
