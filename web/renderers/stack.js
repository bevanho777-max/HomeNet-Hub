// stack renderer (B12) — multiple service targets stacked in one card frame.
// Each child is rendered as a service card and keeps its own header (name / badge
// / identity color); children share the outer .card frame, separated by a hairline.
// The stack card's header_right/items/labels apply to every child.
import { card, esc } from './common.js';
import { renderService } from './service.js';

export function renderStack(gc, resolve, metrics) {
  // per-child service config, shared across children (each child's name/badge/
  // color still come from its own target definition inside renderService).
  const childCfg = {
    type: 'service',
    header_right: gc.header_right,
    items: gc.items,
    labels: gc.labels,
  };
  const label = (k) => metrics?.[k]?.label || k;
  const inners = (gc.children || []).map((childId) => {
    const { target, snap } = resolve(childId);
    if (!target) return '';
    const accentAttr = target.color ? ` style="--accent:${esc(target.color)}"` : '';
    const title = esc(target.name || target.id);

    // Offline child: keep a FULL equal slot (so a row stack stays N clean columns —
    // never collapses to a single line). Header kept (name + badge, greyed via CSS);
    // body = a centered offline status + the items skeleton showing "—". Column mode
    // hides the skeleton via CSS to stay compact.
    if (!snap || snap.online === false) {
      const skel = (gc.items || []).map((k) =>
        `<div class="item"><span class="label">${esc(label(k))}</span><span class="value">—</span></div>`).join('');
      const err = snap?.error ? ` (${esc(snap.error)})` : '';
      const badge = esc(target.badge || 'offline');
      return `<div class="stack-item stack-item-offline"${accentAttr}>`
        + `<h2>${title}<span class="tag">${badge}</span></h2>`
        + `<div class="stack-offline"><div class="stack-offline-status">Offline${err}</div>`
        + (skel ? `<div class="kv">${skel}</div>` : '') + '</div>'
        + '</div>';
    }

    const m = renderService(childCfg, target, snap, metrics); // { title, tag, body, accent }
    // m.tag may be HTML (e.g. a colored status span) — matches mountCards' contract.
    return `<div class="stack-item"${m.accent ? ` style="--accent:${esc(m.accent)}"` : ''}>`
      + `<h2>${esc(m.title)}${m.tag ? `<span class="tag">${m.tag}</span>` : ''}</h2>`
      + m.body
      + `</div>`;
  }).filter(Boolean).join('<div class="stack-div"></div>');

  // B12: direction row|column (default column). Row lays out only when the card is
  // actually wide enough — app.js measures .stack and toggles `.is-row`. Threshold
  // is `min_row_width` (else children × 180px) so a ~400px 4-col slot still rows
  // while a narrow phone card wraps back to column.
  const dir = gc.direction === 'row' ? 'row' : 'column';
  const minW = Number(gc.min_row_width) || ((gc.children || []).length * 180);
  return card({
    key: gc.key || `stack:${(gc.children || []).join(',')}`,
    title: gc.title || '',                 // outer frame usually title-less; children carry headers
    body: `<div class="stack" data-dir="${dir}" data-min="${minW}"><div class="stack-inner">${inners}</div></div>`,
    accent: gc.accent || '',
    stale: false,
  });
}
