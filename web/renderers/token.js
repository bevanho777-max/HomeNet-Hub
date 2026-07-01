// token renderer (§6) — by-model columns + 5-day spark.
// Data comes from snap.extra.token (pivoted server-side, see token_detail.js).
// clickable:detail → app.js opens the /api/token_detail modal.
import { card, mget, esc } from './common.js';

export function renderToken(gridCard, target, snap) {
  const title = target.name || target.id;
  const accent = target.color || '';
  const tk = snap?.extra?.token;

  // header_right template e.g. "LiteLLM · {token_speed} t/s"
  let tag = '';
  if (gridCard.header_right) {
    tag = gridCard.header_right.replace(/\{(\w+)\}/g, (_, k) => mget(snap, k).display || '—');
  }

  if (!tk || !tk.columns?.length) {
    return card({
      key: target.id, title, tag, accent, clickable: gridCard.clickable === 'detail',
      body: `<div class="note">No usage data${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  // §12-step6: front shows up to `front_max` (default 3) class boxes by usage,
  // plus Total. With ≤front_max classes this is identical (config order, no
  // sort) to before; only when there are MORE classes do we keep the Top-N so a
  // narrow card never overflows. The modal still lists every class.
  const frontMax = Number(gridCard.front_max) > 0 ? Number(gridCard.front_max) : 3;
  const totalCol = tk.columns.find((c) => c.key === 'total');
  let classCols = tk.columns.filter((c) => c.key !== 'total' && (c.all_raw || 0) > 0);
  if (classCols.length > frontMax) {
    classCols = [...classCols].sort((a, b) => (b.all_raw || 0) - (a.all_raw || 0)).slice(0, frontMax);
  }
  const cols = totalCol ? [...classCols, totalCol] : classCols;
  // §12-step2 patch: stat-box front labels are config-driven (generic fallbacks)
  const L = gridCard.labels || {};
  const todayLabel = L.today || 'Today';
  const reqLabel = L.requests_suffix || 'req';
  const colHtml = cols.map((c) => `
    <div class="tk-col">
      <div class="tk-h" style="color:${esc(c.color)}">${esc(c.label)}</div>
      <div class="tk-all">${esc(c.all)}</div>
      <div class="tk-sub">${esc(todayLabel)} ${esc(c.today)}</div>
      <div class="tk-sub">${esc(c.requests ?? 0)} ${esc(reqLabel)}</div>
    </div>`).join('');

  const max = Math.max(1, ...(tk.spark || []).map((s) => s.value || 0));
  const sparkHtml = (tk.spark || []).map((s) => {
    const h = Math.round(((s.value || 0) / max) * 58) + 4;
    return `<div class="col"><div class="n">${esc(s.display)}</div><div class="b" style="height:${h}px"></div><div class="d">${esc(s.label)}</div></div>`;
  }).join('');

  // click hint is externalized (gridCard.hint); shown only when clickable + set.
  const note = (gridCard.clickable === 'detail' && gridCard.hint)
    ? `<div class="note">${esc(gridCard.hint)}</div>` : '';
  const body = `<div class="tk-grid" style="grid-template-columns:repeat(${cols.length},1fr)">${colHtml}</div>`
    + (sparkHtml ? `<div class="spark">${sparkHtml}</div>` : '')
    + note;

  return card({ key: target.id, title, tag, body, accent, clickable: gridCard.clickable === 'detail' });
}
