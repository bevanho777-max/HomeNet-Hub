// v2.27 fit-text. A cell never wraps, grows or widens because of what is in it: every text
// part marked .fit is one line (tokens.css), and when it does not fit its box this tries,
// in order,
//   (a) a smaller font, in 0.5px steps, down to a floor -- 13px for a value, 10px for a
//       label or second line (data-min overrides);
//   (b) its short form: data-short (then data-short2, shorter still) on the element, or, for a cell whose short
//       form is a different arrangement (HDD temperatures -> "max · min"), the .alt-form
//       sibling the renderer put next to it (the item gets .is-alt), again from full size;
//   (c) an ellipsis, with the full text in the element's title.
// Containers (.fit-box: the By Model mini table) are checked for overflow the same way and
// shrink their children together.
const FLOOR_VALUE = 13;
const FLOOR_TEXT = 10;

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
      const b = parseFloat(getComputedStyle(a).fontSize);
      fitOne(a, b);
    }
    return;
  }
  // short forms, longest first (data-short, then data-short2)
  for (const sh of [el.dataset.short, el.dataset.short2]) {
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

function setTitle(el) {
  if (el.hasAttribute('title') && !el._fitTitle) return;   // the renderer's own title wins
  const full = el._fitFull != null ? (() => { const d = document.createElement('div'); d.innerHTML = el._fitFull; return d.textContent; })() : el.textContent;
  el.setAttribute('title', full.trim());
  el._fitTitle = true;
}

/** Fit every .fit element under `root` (an element or the document). Writes first, then one
 *  read for all of them, then the few that overflow are fixed one by one -- so a card whose
 *  text all fits costs a single layout pass. */
export function fitAll(root = document) {
  const els = [...root.querySelectorAll('.fit')].filter((el) => !el.closest('.alt-form'));
  root.querySelectorAll('.is-alt').forEach((it) => it.classList.remove('is-alt'));
  root.querySelectorAll('.alt-form .fit').forEach(reset);
  els.forEach(reset);
  const bases = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
  const bad = els.map((el, i) => (el.offsetParent !== null && overflows(el) ? i : -1)).filter((i) => i >= 0);
  for (const i of bad) fitOne(els[i], bases[i]);
}

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
