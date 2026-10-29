// v2.27 fit-text. A cell never wraps, grows or widens because of what is in it: every text
// part marked .fit is one line (tokens.css), and when it does not fit its box this tries,
// in order,
//   (a) a smaller font, in 0.5px steps, down to a floor -- 13px for a value, 10px for a
//       label or second line (data-min overrides);
//   (b) its short form: data-short (then data-short2, data-short3, shorter still) on the element, or, for a cell whose short
//       form is a different arrangement (HDD temperatures -> "max · min"), the .alt-form
//       sibling the renderer put next to it (the item gets .is-alt), again from full size;
//   (b2) v2.29: no written short form left -- the text without its trailing " · " parts,
//       longest first ("10-23 11:40 · 44.3" -> "10-23 11:40"), the full text in the title;
//   (c) an ellipsis, with the full text in the element's title (a last resort: the layout
//       check counts every one outside a table's text column as a fault).
// v2.28: before any of that, lineRows() gives each row of cells one line count (a row keeps
// its third lines only when every cell in it has one; elsewhere a third line joins its value
// line, .sub-inline). Such an inline third line is fitted last, into the room the value left:
// smaller, then its short form, and when it still does not fit it leaves the line
// (.sub-away) and its text becomes the cell's title. The By Model mini table is one line
// (fitPtab): as many entries as fit, the rest counted in a "+N".
const FLOOR_VALUE = 13;
const FLOOR_TEXT = 10;
// a By Model name cut narrower than this says nothing: show one entry fewer instead
const MIN_PT_LABEL = 18;

function floorOf(el) {
  if (el.dataset.min) return Number(el.dataset.min);
  return el.classList.contains('value') ? FLOOR_VALUE : FLOOR_TEXT;
}

// Exact widths: scrollWidth / clientWidth are rounded to whole pixels, and text that is
// 0.3px too wide still gets an ellipsis. So the content is measured with a Range (the text's
// own fractional width) against the element's fractional content box.
function textWidth(el) {
  const rg = document.createRange();
  rg.selectNodeContents(el);
  return rg.getBoundingClientRect().width;
}
function boxWidth(el) {
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
}
const overflows = (el) => textWidth(el) > boxWidth(el) + 0.05 || el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1;

function reset(el) {
  if (el._fitFull != null && el.innerHTML !== el._fitFull) el.innerHTML = el._fitFull;
  el.style.fontSize = '';
  el.classList.remove('is-cut');
  if (el._fitTitle) { el.removeAttribute('title'); el._fitTitle = false; }
}

// largest font in [floor, base] (0.5px steps) at which el fits; null if none does
function shrink(el, base, floor) {
  if (!overflows(el)) return base;
  // text width is close to linear in font size: start from the proportional guess
  const ratio = boxWidth(el) / Math.max(1, textWidth(el));
  let s = Math.min(base - 0.5, Math.floor(base * ratio * 2) / 2);
  for (; s >= floor; s -= 0.5) {
    el.style.fontSize = `${s}px`;
    if (!overflows(el)) return s;
  }
  el.style.fontSize = `${floor}px`;
  return null;
}

function fitOne(el, base) {
  const floor = Math.min(floorOf(el), base);
  if (shrink(el, base, floor) != null) return;
  // (b) short form
  const item = el.closest('.item, .fit-scope');
  const alt = el.classList.contains('full-form') && item?.querySelector(':scope > .alt-form');
  if (alt) {
    el.style.fontSize = '';
    item.classList.add('is-alt');
    for (const a of alt.matches('.fit') ? [alt] : alt.querySelectorAll('.fit')) {
      if (isInlineSub(a)) continue;   // fitted with the other inline third lines, last
      const b = parseFloat(getComputedStyle(a).fontSize);
      fitOne(a, b);
    }
    return;
  }
  // short forms, longest first (data-short, data-short2, data-short3), then (b2)
  for (const sh of [el.dataset.short, el.dataset.short2, el.dataset.short3, ...segmentForms(el)]) {
    if (sh == null) continue;
    if (el._fitFull == null) el._fitFull = el.innerHTML;
    el.textContent = sh;
    el.style.fontSize = '';
    if (shrink(el, base, floor) != null) { setTitle(el); return; }
  }
  // (c) ellipsis at the floor size, full text on hover
  el.style.fontSize = `${floor}px`;
  el.classList.add('is-cut');
  setTitle(el);
}

// (b2) the text without its trailing " · " parts, longest first
function segmentForms(el) {
  const base = el.dataset.short3 ?? el.dataset.short2 ?? el.dataset.short ?? (el._fitFull != null
    ? (() => { const d = document.createElement('div'); d.innerHTML = el._fitFull; return d.textContent; })() : el.textContent);
  const parts = String(base).split(' · ');
  const out = [];
  for (let n = parts.length - 1; n >= 1; n--) out.push(parts.slice(0, n).join(' · ').trim());
  return out.filter((x) => x);
}

function setTitle(el) {
  if (el.hasAttribute('title') && !el._fitTitle) return;   // the renderer's own title wins
  const full = el._fitFull != null ? (() => { const d = document.createElement('div'); d.innerHTML = el._fitFull; return d.textContent; })() : el.textContent;
  el.setAttribute('title', full.trim());
  el._fitTitle = true;
}

// v2.28 one line count per row of cells. Rows are read off the layout (cells sharing a top,
// within one card -- the node columns of the nodes card share their rows), so they follow
// whatever column count the width gave the grid.
function lineRows(root) {
  const items = [...root.querySelectorAll('.kv .item')];
  items.forEach((it) => it.classList.remove('sub-inline'));
  const rows = [];
  for (const it of items) {
    if (it.offsetParent === null) continue;
    const top = it.getBoundingClientRect().top;
    const card = it.closest('.card');
    let row = rows.find((r) => r.card === card && Math.abs(r.top - top) < 1);
    if (!row) rows.push(row = { card, top, items: [] });
    row.items.push(it);
  }
  for (const { items: row } of rows) {
    // (the HDD short form's "max · min" line only exists once fit.js has picked that form,
    // so it never makes a row three lines: it is always an inline candidate)
    // v2.30: a row of wide stack-child cells (>= 240px: two cells across a wide backend) puts
    // its second lines beside the values too -- under them, a 270px cell held "online" over
    // "Latency 4ms" and little else
    if (row.every((it) => it.querySelector(':scope > .sub')) && !row.every(wideStackCell)) continue;
    for (const it of row) if (it.querySelector(':scope > .sub, :scope > .alt-form > .sub')) it.classList.add('sub-inline');
  }
}

const wideStackCell = (it) => !!it.closest('.stack-item') && it.getBoundingClientRect().width >= 240;

const isInlineSub = (el) => el.classList.contains('sub') && !!el.closest('.item.sub-inline')
  && (el.parentElement.classList.contains('item') || el.parentElement.classList.contains('alt-form'));

function resetInline(el) {
  reset(el);
  el.classList.remove('sub-away');
  const item = el.closest('.item');
  if (item?._fitTitle === 'merged') item.setAttribute('title', item._ownTitle);
  else if (item?._fitTitle) item.removeAttribute('title');
  if (item) item._fitTitle = false;
}

// an inline third line: smaller, then its short forms, else out of the line into the title
function fitInline(el) {
  if (el.offsetParent === null || !overflows(el)) return;   // (an unused HDD short form, or fits)
  const base = parseFloat(getComputedStyle(el).fontSize);
  const floor = Math.min(floorOf(el), base);
  if (shrink(el, base, floor) != null) return;
  for (const sh of [el.dataset.short, el.dataset.short2, el.dataset.short3, ...segmentForms(el)]) {
    if (sh == null) continue;
    if (el._fitFull == null) el._fitFull = el.innerHTML;
    el.textContent = sh;
    el.style.fontSize = '';
    if (shrink(el, base, floor) != null) { setTitle(el); return; }
  }
  if (el._fitFull != null) el.innerHTML = el._fitFull;
  el.style.fontSize = '';
  el.classList.add('sub-away');
  // its text goes to the cell's title -- after the renderer's own title, if it set one
  const item = el.closest('.item');
  if (item && !item.hasAttribute('title')) { item.setAttribute('title', el.textContent.trim()); item._fitTitle = true; }
  else if (item && !item._fitTitle) {
    item._ownTitle = item.getAttribute('title');
    item.setAttribute('title', `${item._ownTitle}\n${el.textContent.trim()}`);
    item._fitTitle = 'merged';
  }
}

// the By Model mini table on one line: entries largest first (the renderer sorts them); the
// most that fit -- every number whole, every name at least MIN_PT_LABEL wide after shrinking,
// its short form or an ellipsis -- and "+N" for the rest (all of them are in the title)
function fitPtab(tab) {
  if (tab.offsetParent === null) return;
  const pts = [...tab.querySelectorAll(':scope > .pt')];
  const more = tab.querySelector(':scope > .pt-more');
  const labels = pts.map((p) => p.querySelector('.pt-l'));
  pts.forEach((p) => p.classList.remove('pt-off'));
  labels.forEach(reset);
  const bases = labels.map((l) => parseFloat(getComputedStyle(l).fontSize));
  for (let n = pts.length; n >= 1; n--) {
    pts.forEach((p, i) => p.classList.toggle('pt-off', i >= n));
    if (more) more.textContent = n < pts.length ? `+${pts.length - n}` : '';
    tab.style.setProperty('--pc', String(n));
    let ok = true;
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      reset(l);
      if (overflows(l)) fitOne(l, bases[i]);
      const box = pts[i].getBoundingClientRect();
      const v = pts[i].querySelector('.pt-v').getBoundingClientRect();
      if (v.right > box.right + 0.5 || (l.classList.contains('is-cut') && boxWidth(l) < MIN_PT_LABEL)) ok = false;
    }
    if (ok) return;
  }
}

/** Fit every .fit element under `root` (an element or the document). Writes first, then one
 *  read for all of them, then the few that overflow are fixed one by one -- so a card whose
 *  text all fits costs a single layout pass. v2.28: after the rows got their line counts,
 *  and with the inline third lines last. */
export function fitAll(root = document) {
  lineRows(root);
  const inline = [...root.querySelectorAll('.item.sub-inline .sub.fit')].filter(isInlineSub);
  const els = [...root.querySelectorAll('.fit')].filter((el) => !el.closest('.alt-form') && !el.closest('.ptab') && !isInlineSub(el));
  root.querySelectorAll('.is-alt').forEach((it) => it.classList.remove('is-alt'));
  root.querySelectorAll('.alt-form .fit').forEach(reset);
  els.forEach(reset);
  inline.forEach(resetInline);
  const bases = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
  const bad = els.map((el, i) => (el.offsetParent !== null && overflows(el) ? i : -1)).filter((i) => i >= 0);
  for (const i of bad) fitOne(els[i], bases[i]);
  root.querySelectorAll('.ptab').forEach(fitPtab);
  for (const el of inline) fitInline(el);
}

// v2.29 a one-line title outside the cell grid (a modal's / a panel's h2, set by setLine):
// the full text, else its written shorter forms, else those without their trailing " · "
// parts; the full text stays in the title. Measured only while it is laid out -- call again
// once its modal is open, and on resize (fitLines).
export function fitLine(el) {
  const forms = el?._lineForms;
  if (!forms || el.offsetParent === null) return;
  const seg = (f) => { const p = f.split(' · '); const o = []; for (let n = p.length - 1; n >= 1; n--) o.push(p.slice(0, n).join(' · ')); return o; };
  const all = [...new Set([...forms, ...forms.flatMap(seg)].filter(Boolean))];
  for (const f of all) {
    el.textContent = f;
    if (textWidth(el) <= boxWidth(el) + 0.05) return;
  }
  el.textContent = all[all.length - 1];
}

export const fitLines = (root = document) => root.querySelectorAll('h2, .gpu-panel-title').forEach((el) => { if (el._lineForms) fitLine(el); });

/** Fit the cards (and their header tags) whose body changed or whose width changed since they
 *  were last fitted. */
export function fitCards(cardEls) {
  const todo = [];
  for (const el of cardEls) {
    const w = el.clientWidth;
    if (el._fitBody === el._body && el._fitW === w && el._fitTag === (el.querySelector('h2 .tag')?.innerHTML || '')) continue;
    todo.push(el);
  }
  for (const el of todo) {
    fitAll(el);
    el._fitBody = el._body;
    el._fitW = el.clientWidth;
    el._fitTag = el.querySelector('h2 .tag')?.innerHTML || '';
  }
}
