// table renderer (§6) — generic row table for a `shape: table` sql target.
// Data comes from snap.extra.rows exactly as the query returned it; which
// columns appear, in what order, under what label and in what number format is
// entirely a layout decision (gridCard.columns). No per-purpose logic here — a
// new table card is a new query file + a type:table card, zero code changes.
import { card, esc } from './common.js';

// Same compact scale the token pivot uses server-side, so a token count reads
// identically on both cards.
function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// pg hands back bigint as a string, so "601847029" must still count as numeric.
function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function cell(value, format) {
  if (value == null) return '—';
  if (format === 'text') return String(value);
  const n = asNumber(value);
  if (n == null) return String(value);
  if (format === 'compact') return compact(n);
  return n.toLocaleString('en-US'); // 'number', and the default for numeric cells
}

export function renderTable(gridCard, target, snap) {
  const title = gridCard.title || target?.name || target?.id || 'Table';
  const accent = target?.color || '';
  const key = gridCard.target || title;

  // columns is an ordered map: key → "Label" | { label, format }
  const cols = Object.entries(gridCard.columns || {}).map(([k, v]) => (
    typeof v === 'string' ? { key: k, label: v, format: null }
      : { key: k, label: v?.label ?? k, format: v?.format ?? null }
  ));

  const rows = Array.isArray(snap?.extra?.rows) ? snap.extra.rows : null;

  if (!rows || !rows.length || !cols.length) {
    // Offline and "query returned nothing" are different states and must not
    // wear the same message: one is a broken card, the other is a true answer.
    const note = snap?.online === false
      ? `No data${snap?.error ? ` (${esc(snap.error)})` : ''}`
      : esc(gridCard.empty_note || 'No rows');
    return card({ key, title, accent, kind: 'table', body: `<div class="note">${note}</div>` });
  }

  // First column is the row's identity (left-aligned); the rest are figures.
  const head = cols.map((c, i) => `<th${i ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${
    cols.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(cell(r[c.key], c.format))}</td>`).join('')
  }</tr>`).join('');

  const hint = gridCard.hint ? `<div class="note">${esc(gridCard.hint)}</div>` : '';
  return card({
    key, title, accent, kind: 'table',
    tag: gridCard.header_right ? String(gridCard.header_right) : '',
    body: `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${hint}`,
  });
}
