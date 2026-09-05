// Table detail modal — every row and every column a `shape: table` card has, in the
// same modal shell the token and machine cards use.
//
// NO REQUEST IS MADE. The rows are the ones already in the snapshot the card rendered
// from, handed over on the card object. That is why this view needs no login: it shows
// strictly what the public board already served, just without the front's row and column
// budget. It also means the modal can never disagree with the card behind it.
//
// TWO TRUST LEVELS FOR COLUMNS, and the distinction is the whole safety story here.
//
// A column named in `columns` or `detail_columns` was chosen by an operator editing
// layout.yaml. That is a decision, and it is rendered as-is.
//
// A column the modal DERIVED, because no `detail_columns` was declared, was chosen by
// nobody. It is whatever key the query happened to return — and that is exactly the shape
// of mistake that leaks later: a query gains a `raw_key` column for the server's own use
// and it appears on a public board the same day. The server already strips that one
// before the row leaves it; a derived column has to survive two more checks on the
// assumption that one day someone adds a column and forgets the first.
//
//   by NAME  — the key is `key`/`api_key`/`token`/`password_hash`/… as a whole trailing
//              word. NOT a substring match: `tokens_total` and `tokens_7d` are counts and
//              must render. Getting that wrong hides the most important column on the
//              card that motivated this feature, which is how the bug was found.
//   by VALUE — the cell looks like a credential or a digest whatever it is called: a
//              32+ character hex run, or an `sk-` prefix. Names can be innocent; a
//              64-hex string never is.
//
// Value checking applies ONLY to derived columns. Blanking a declared column would mean
// silently disagreeing with the card the operator is looking at.
import { esc } from './common.js';
import { parseColumns, cell } from './table.js';

const $ = (s) => document.querySelector(s);

// Whole trailing word, not substring — see above.
const UNSAFE_NAME = /(^|_)(key|keys|apikey|token|secret|password|hash|digest|credential)$/i;
// A digest or a credential, by shape.
const UNSAFE_VALUE = /^(sk-|[0-9a-f]{32,}$)/i;

let current = null;

function columnsFor(gridCard, rows) {
  const declared = parseColumns(gridCard.detail_columns);
  if (declared.length) return declared;
  // Derive: the card's own columns first, in their configured order, then anything else
  // the rows carry. Union across rows, because a row is free to omit a null column.
  const front = parseColumns(gridCard.columns);
  const seen = new Set(front.map((c) => c.key));
  const extra = [];
  for (const r of rows) {
    for (const k of Object.keys(r || {})) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (UNSAFE_NAME.test(k)) continue;
      // One bad-looking value anywhere in the column drops the column, not just that
      // cell: a half-shown digest column is worse than an absent one, because it reads
      // as complete.
      if (rows.some((row) => UNSAFE_VALUE.test(String(row?.[k] ?? '')))) continue;
      extra.push({ key: k, label: k, format: null });
    }
  }
  return [...front, ...extra];
}

function render() {
  const box = $('#tableModalBody');
  if (!box || !current) return;
  const { rows, gridCard } = current;
  const cols = columnsFor(gridCard, rows);
  if (!rows.length || !cols.length) {
    box.innerHTML = `<div class="note">${esc(gridCard.empty_note || 'No rows')}</div>`;
    return;
  }
  const head = cols.map((c, i) => `<th${i ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${
    cols.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(cell(r[c.key], c.format))}</td>`).join('')
  }</tr>`).join('');
  const hint = gridCard.hint ? `<div class="note">${esc(gridCard.hint)}</div>` : '';
  box.innerHTML = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${hint}`;
}

/** Open for a card built by renderTable. `c.detail` is null when the card fits, in which
 *  case the card was never made clickable and this cannot be reached. */
export function openTableModal(c) {
  if (!c?.detail) return;
  current = c.detail;
  const n = current.rows.length;
  $('#tableModalTitle').textContent = current.gridCard.detail_title
    || `${current.title}（共 ${n}）`;
  $('#tableModal').classList.add('open');
  render();
}

export function closeTableModal() {
  $('#tableModal')?.classList.remove('open');
  // Drop the rows rather than leaving the last card's data addressable behind a closed
  // modal; reopening always re-reads from the card that was clicked.
  current = null;
  const box = $('#tableModalBody');
  if (box) box.innerHTML = '';
}

export function bindTableModal() {
  $('#tableModalClose').onclick = closeTableModal;
  $('#tableModal').onclick = (e) => { if (e.target.id === 'tableModal') closeTableModal(); };
}
