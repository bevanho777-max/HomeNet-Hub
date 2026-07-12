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
  const inners = (gc.children || []).map((childId) => {
    const { target, snap } = resolve(childId);
    if (!target) return '';
    const m = renderService(childCfg, target, snap, metrics); // { title, tag, body, accent }
    // m.tag may be HTML (e.g. a colored status span) — matches mountCards' contract.
    return `<div class="stack-item"${m.accent ? ` style="--accent:${esc(m.accent)}"` : ''}>`
      + `<h2>${esc(m.title)}${m.tag ? `<span class="tag">${m.tag}</span>` : ''}</h2>`
      + m.body
      + `</div>`;
  }).filter(Boolean).join('<div class="stack-div"></div>');

  // B12: direction row|column (default column). .stack is the query container;
  // .stack-inner holds the flex row/col so a narrow container can fall back to column.
  const dir = gc.direction === 'row' ? 'row' : 'column';
  return card({
    key: gc.key || `stack:${(gc.children || []).join(',')}`,
    title: gc.title || '',                 // outer frame usually title-less; children carry headers
    body: `<div class="stack" data-dir="${dir}"><div class="stack-inner">${inners}</div></div>`,
    accent: gc.accent || '',
    stale: false,
  });
}
