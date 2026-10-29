// Shared rendering helpers for the config-driven renderers (§6).
// Status color logic lives server-side (normalize → level); the frontend only
// maps level → lv-* class / --c color. Visuals match the .24 baseline 1:1.
import { cv, t } from '../i18n.js';
import { fitLine } from '../fit.js';

export const LV_VAR = {
  ok: 'var(--lv-ok)', warn: 'var(--lv-warn)', danger: 'var(--lv-danger)', cool: 'var(--lv-cool)',
};

export const lvClass = (level) => (level ? `lv-${level}` : '');
export const levelColor = (level) => LV_VAR[level] || 'var(--blue)';

// Status string → level (B1). Healthy vocab → ok(green); explicit failure vocab
// → danger(red). Anything else (unknown/degraded/starting…) → null(neutral).
// Transport failures (timeout/conn-fail/non-2xx) surface as snap.online===false,
// handled by callers — NOT reddened here. Collector raw value is left untouched.
const STATUS_OK = new Set(['online', 'ok', 'up', 'live', 'running', 'healthy']);
const STATUS_BAD = new Set(['offline', 'down', 'dead', 'error', 'fail', 'failed', 'unreachable', 'timeout', 'stopped', 'unavailable']);
export function statusLevel(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  if (STATUS_OK.has(s)) return 'ok';
  if (STATUS_BAD.has(s)) return 'danger';
  return null;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// v2.27: a one-line title (modal heads, chart panel titles) -- cut with an ellipsis when it
// does not fit (tokens.css), so the full text rides along in title.
// v2.29: `forms` = shorter forms for a line too narrow for `text` (fit.js fitLine; the full
// text stays in the title)
export const setLine = (el, text, forms = []) => { el.textContent = text; el.title = text; el._lineForms = [text, ...forms]; fitLine(el); };

// A metric cell from /api/snapshot: { value, level, display }.
export const mget = (snap, key) => (snap?.metrics?.[key] || { value: null, level: 'cool', display: '—' });

// Ring gauge. value===null → show "—", never 0%, color = cool (§4.1/§6).
export function ring(label, m) {
  const isNull = m.value == null || typeof m.value !== 'number';
  const p = isNull ? 0 : Math.max(0, Math.min(100, m.value));
  const c = isNull ? 'var(--lv-cool)' : levelColor(m.level);
  // B2: ring center is ALWAYS an integer percentage (composite *_bytes uses its
  // v/max ratio in m.value). Full "used/total G" stays in the KV block, never here.
  const text = isNull ? '—' : Math.round(p) + '%';
  return `<div class="ring-wrap"><div class="ring" style="--p:${p};--c:${c}"><b>${esc(text)}</b></div><div class="ring-label">${esc(label)}</div></div>`;
}

// v2.21: multi-GPU card faces show the aggregate only. The per-card "0:88% 1:14%" /
// "0:22.9/24.0 1:22.9/24.0" lines are gone from rings and cells; the per-card series stay
// in the machine modal. Alerting is unchanged: the hub gives an aggregate the WORST level
// of its cards (vram / temp / power), and that level is what colours the ring and cell.

// The standard cell (tokens.css: label, value and, when there is one, a second line under the
// value; nothing wraps). Every line is .fit: fit.js shrinks a line that does not fit, then
// swaps in its short form (`short` / `subShort`, from the abbreviation table in i18n.js), then
// cuts it. v2.28: no line is reserved -- without a `sub` the cell is two lines -- and in a row
// where not every cell has a second line, fit.js puts it on the value line instead.
// `value` is HTML when `html` is set (callers escape), text otherwise.
export function cellHtml({ label, value, cls = '', sub = '', itemCls = '', short = null, subShort = null, labelShort = null, html = false }) {
  const attr = (s) => (s != null && s !== '' ? ` data-short="${esc(s)}"` : '');
  return `<div class="item${itemCls ? ` ${itemCls}` : ''}"><span class="label fit"${labelShort !== label ? attr(labelShort) : ''}>${esc(label)}</span>`
    + `<span class="value fit${cls ? ` ${cls}` : ''}"${attr(short)}>${html ? value : esc(value)}</span>`
    + (sub ? `<span class="sub fit"${attr(subShort)}>${esc(sub)}</span>` : '')
    + '</div>';
}

const partNum = (p) => (typeof p.v === 'number' ? p.v : Number(p.display));
// the parts a `parts_layout: table` cell shows (those above zero)
export const shownParts = (m) => (m?.parts || []).filter((p) => partNum(p) !== 0);

// Key/value item; ratio metrics (have numeric value) get a status class.
// B20: a metric normalized with `part_thresholds` arrives with `parts` — each
// subfield already carries its own level, so render them as separately colored
// spans instead of tinting the whole value one color.
// opts.sub: the cell's second line (layout `subs`, e.g. the 5-minute count under today's).
export function kvItem(label, m, tpl = null, { sub = '', itemCls = '' } = {}) {
  const cls = lvClass(m.level);
  // Border tint only for the states that need attention (for a parts metric that is
  // the worst part). ok/cool keep the neutral frame, so a healthy card looks exactly
  // as it did before and a warm drive is the only thing that lights up.
  const edge = (m.level === 'warn' || m.level === 'danger') ? cls : '';
  const itemClass = [edge, itemCls].filter(Boolean).join(' ');
  // v2.30: the metric's `label_short` is the label's short form for a narrow cell (fit.js)
  const ls = tpl ? cv(tpl, 'label_short') : null;
  const lsAttr = ls && ls !== label ? ` data-short="${esc(ls)}"` : '';
  const open = `<div class="item${itemClass ? ` ${itemClass}` : ''}"><span class="label fit"${lsAttr}>${esc(label)}</span>`;
  const subHtml = sub ? `<span class="sub fit">${esc(sub)}</span>` : '';

  // `parts_layout: table` (gateway By Model): the entries above zero, label left and number
  // right; a long model name shrinks, then reads as its short form (abbr_model), then is cut.
  // v2.28: one line, largest first -- fit.js shows as many as fit and counts the rest in
  // "+N"; every entry is in the title.
  if (m.parts && tpl?.parts_layout === 'table') {
    const parts = shownParts(m)
      .sort((a, b) => (Number.isFinite(partNum(b)) ? partNum(b) : -1) - (Number.isFinite(partNum(a)) ? partNum(a) : -1));
    if (!parts.length) return `${open}<span class="value fit">${m.parts.length ? '0' : '—'}</span>${subHtml}</div>`;
    const abbr = t('abbr_model') || {};
    const cells = parts.map((p) => {
      const l = p.label || '';
      const short = typeof abbr === 'object' && abbr[l] && abbr[l] !== l ? ` data-short="${esc(abbr[l])}"` : '';
      return `<span class="pt"><span class="pt-l fit"${short} title="${esc(l)}">${esc(l)}</span><span class="pt-v ${lvClass(p.level)}">${esc(p.display)}</span></span>`;
    }).join('');
    const all = parts.map((p) => `${p.label || ''} ${p.display}`).join(' · ');
    return `${open}<span class="ptab" style="--pc:${parts.length}" title="${esc(all)}">${cells}<span class="pt-more"></span></span></div>`;
  }

  // parts in one line (a temperature per disk, the bay as a tag); the short form is the
  // hottest disk (its bay tagged) and the coolest, "max · min" on the line under them.
  if (m.parts) {
    const full = m.parts.map((p) => `<i class="${lvClass(p.level)}">${esc(p.display)}</i>${p.label ? `<sup>${esc(p.label)}</sup>` : ''}`).join('');
    const nums = m.parts.map((p) => ({ p, v: partNum(p) })).filter((x) => Number.isFinite(x.v));
    let alt = '';
    if (nums.length >= 2) {
      const hi = Math.max(...nums.map((x) => x.v));
      const lo = Math.min(...nums.map((x) => x.v));
      const hot = nums.filter((x) => x.v === hi);
      const cold = nums.find((x) => x.v === lo);
      const bays = hot.map((x) => x.p.label).filter(Boolean).join(',');
      // (v2.33: and when even that does not fit -- several bays at the same top temperature in a
      // phone-width cell -- the two temperatures alone, the bays in the title)
      const bare = `${hot[0].p.display}° · ${cold.p.display}°`;
      alt = `<span class="alt-form"><span class="value fit"${bays ? ` data-short="${esc(bare)}"` : ''}><i class="${lvClass(hot[0].p.level)}">${esc(hot[0].p.display)}°</i>${bays ? `<sup>${esc(bays)}</sup>` : ''}`
        + `<span class="mm-sep">·</span><i class="${lvClass(cold.p.level)}">${esc(cold.p.display)}°</i></span>`
        + `<span class="sub fit">${esc(t('abbr_hdd_maxmin'))}</span></span>`;
    }
    return `${open}<span class="value parts fit${alt ? ' full-form' : ''}">${full}</span>${alt}${subHtml}</div>`;
  }
  return `${open}<span class="value fit ${cls}">${esc(m.display)}</span>${subHtml}</div>`;
}

// Card model consumed by mountCards (matches the .24 shell-persist contract).
// B23: `kind` lets mountCards route a click to the right modal without re-deriving
// the card's type from the layout — the renderer already knows what it built.
// v2.32: `role` = the purpose pill after the title (LLM / ComfyUI); `tagShort` / `tagShort2` =
// the header tag's shorter forms for a narrow card (fit.js data-short / data-short2; v2.34 data-short3).
export function card({ key, title, tag = '', body, accent = '', clickable = false, stale = false, kind = '', detail = null, role = '', tagShort = null, tagShort2 = null, tagShort3 = null }) {
  // `detail` is whatever a card's modal needs, handed over by the renderer that already
  // had it. mountCards ignores it; openCardModal passes the whole card object through,
  // and the onclick handler is reassigned on every render, so this is always the data
  // from the latest snapshot rather than a stale closure.
  return { key, title, tag, body, accent, clickable, stale, kind, detail, role, tagShort, tagShort2, tagShort3 };
}
