// table renderer (§6) — generic row table for a `shape: table` sql target.
// Data comes from snap.extra.rows exactly as the query returned it; which
// columns appear, in what order, under what label and in what number format is
// entirely a layout decision (gridCard.columns). No per-purpose logic here — a
// new table card is a new query file + a type:table card, zero code changes.
import { card, esc } from './common.js';
import { colmap, cv, getLang, t } from '../i18n.js';
import { si3 } from '../fmt.js';

// Same compact scale the token pivot uses server-side, so a token count reads
// identically on both cards (v2.27: K / M / G, three significant digits; the Per-Project
// "direct" row is a difference and may dip below zero).
const compact = si3;

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
  // v2.27: 'number' (and the default for numeric cells) is compact too -- a column's width is
  // fixed by the longest figure it can hold, and K / M / G keep that to five characters
  return compact(n);
}

// Rows to keep on the card front. A card is a fixed-height tile in a grid; a query that
// suddenly returns forty rows must not stretch it past its neighbours. Six is what fits
// next to the other cards at the default card height — override per card with
// `front_max`, and the modal shows everything either way.
const DEFAULT_FRONT_MAX = 6;

// Ordered map { key: "Label" | { label, format } } → the renderer's column list.
// Takes the CARD, not the map, because the English variant of a column map lives beside
// it on the same card (`columns_en` / a per-entry `label_en`) and resolving one without
// the other would translate the label while losing the format.
export function parseColumns(gridCard, field) {
  return Object.entries(colmap(gridCard, field)).map(([key, c]) => ({ key, label: c.label, format: c.format }));
}

export { cell };

// v2.24: a row may carry an English variant of a value (`<key>_en`) -- the Per-Project
// "direct" row is the hub's own row, so its label is translated like any other UI text.
export const val = (r, key) => (getLang() === 'en' && r[`${key}_en`] != null ? r[`${key}_en`] : r[key]);

// v2.23: a column is a figure column -- right-aligned under a right-aligned header, tabular
// digits -- unless it is the row's identity (the first column) or declared `format: text`
// (dates, names), which read left-aligned like any text.
export const isNumCol = (c, i) => i > 0 && c.format !== 'text';
// v2.27 column kind for the fixed table layout: 'num' (figure), 'txt' (a later text column,
// e.g. a date), '' (the identity column)
export const colKind = (c, i) => (i === 0 ? '' : c.format === 'text' ? 'txt' : 'num');

export function renderTable(gridCard, target, snap) {
  const title = cv(gridCard, 'title') || target?.name || target?.id || 'Table';
  const accent = target?.color || '';
  const key = gridCard.target || title;

  // columns is an ordered map: key → "Label" | { label, format }
  const cols = parseColumns(gridCard, 'columns');
  // v2.23: when the grid widens the card (layout `stretch`), the table widens with it: the
  // modal-only columns (detail_columns not on the front) are rendered too, marked .col-x,
  // and tokens.css shows them once the card is wide enough to hold them.
  const front = new Set(cols.map((c) => c.key));
  const extra = parseColumns(gridCard, 'detail_columns').filter((c) => !front.has(c.key)).map((c) => ({ ...c, x: true }));
  const allCols = [...cols, ...extra];

  const rows = Array.isArray(snap?.extra?.rows) ? snap.extra.rows : null;

  if (!rows || !rows.length || !cols.length) {
    // Offline and "query returned nothing" are different states and must not
    // wear the same message: one is a broken card, the other is a true answer.
    const note = snap?.online === false
      ? `No data${snap?.error ? ` (${esc(snap.error)})` : ''}`
      : esc(cv(gridCard, 'empty_note') || 'No rows');
    return card({ key, title, accent, kind: 'table', body: `<div class="note">${note}</div>` });
  }

  const frontMax = Number(gridCard.front_max) > 0 ? Number(gridCard.front_max) : DEFAULT_FRONT_MAX;
  const overflow = rows.length > frontMax;
  const shown = overflow ? rows.slice(0, frontMax) : rows;

  // First column is the row's identity (left-aligned); the rest are figures.
  const cls = (c, i) => { const k = [colKind(c, i), c.x ? 'col-x' : ''].filter(Boolean).join(' '); return k ? ` class="${k}"` : ''; };
  // v2.27: fixed layout -- the header row sets every column's width (tokens.css: a figure
  // column by the longest figure it can hold, a text column by its longest value); the
  // identity column takes the rest and cuts a long name (full text in title)
  const head = allCols.map((c, i) => `<th${cls(c, i)} title="${esc(c.label)}">${esc(c.label)}</th>`).join('');
  const body = shown.map((r) => `<tr>${
    // v2.22: the identity cell may ellipsise on a narrow card; its title carries the full text
    allCols.map((c, i) => { const v = esc(cell(val(r, c.key), c.format)); return i ? `<td${cls(c, i)}>${v}</td>` : `<td title="${v}">${v}</td>`; }).join('')
  }</tr>`).join('');

  // Two different notes, and only one of them is a call to action. `hint` is the card's
  // standing explanation; the overflow line says how much is not on screen and is the
  // only reason the card becomes clickable. A card that fits stays inert, exactly like
  // every other card whose detail view would add nothing.
  const more = overflow
    ? `<div class="note tblMore">${esc(cv(gridCard, 'more_label') || t('table_more'))}${t('table_count', rows.length)}</div>`
    : '';
  const hintText = cv(gridCard, 'hint');
  const hint = hintText ? `<div class="note">${esc(hintText)}</div>` : '';
  return card({
    key, title, accent, kind: 'table',
    clickable: overflow,
    tag: gridCard.header_right ? String(gridCard.header_right) : '',
    body: `<div class="tbl-wrap"><table class="tbl${extra.length ? ' has-x' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}${hint}`,
    // Handed to the modal as-is: it needs every row and every column, not the slice the
    // card front shows. These are the same objects the server sent, which have already
    // had anything unsafe removed — see table_detail.js for the second line of defence.
    detail: overflow ? { rows, gridCard, title } : null,
  });
}
