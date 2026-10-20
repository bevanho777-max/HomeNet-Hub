// token renderer (§6) — by-model columns + 5-day spark.
// Data comes from snap.extra.token (pivoted server-side, see token_detail.js).
// clickable:detail → app.js opens the /api/token_detail modal.
import { card, mget, esc } from './common.js';
import { cmap, cv, t } from '../i18n.js';

// v2.24: "MM-DD" of a unix-seconds instant, Beijing calendar
const bjDay = (sec) => new Date((sec + 8 * 3600) * 1000).toISOString().slice(5, 10);

/** "m26 10-13 · m25 10-20 · m110 10-20": when each node's direct usage starts counting */
export function coverageList(coverage, kinds = ['tokens', 'embed_tokens']) {
  const byNode = new Map();
  for (const c of coverage || []) {
    if (!kinds.includes(c.kind) || typeof c.since !== 'number') continue;
    if (!byNode.has(c.node) || c.since < byNode.get(c.node)) byNode.set(c.node, c.since);
  }
  return [...byNode].sort((a, b) => a[1] - b[1]).map(([n, s]) => `${n} ${bjDay(s)}`).join(' · ');
}

export function renderToken(gridCard, target, snap) {
  const title = target.name || target.id;
  const accent = target.color || '';
  const tk = snap?.extra?.token;

  // header_right template e.g. "当前生成 {token_speed} t/s" (header_right_en for EN).
  // v2.24: no speed (nothing generating) reads "—", not "— t/s"; hovering lists the nodes.
  let tag = '';
  const tpl = cv(gridCard, 'header_right');
  if (typeof tpl === 'string' && tpl) {
    const sp = mget(snap, 'token_speed');
    const text = (sp.value == null ? tpl.replace(/\{token_speed\}\s*t\/s/, '—') : tpl)
      .replace(/\{(\w+)\}/g, (_, k) => mget(snap, k).display || '—');
    const nodes = tk?.speed_nodes;
    const title = Array.isArray(nodes) && nodes.length
      ? nodes.map((n) => `${n.node} ${n.tps == null ? '—' : `${n.tps} t/s`}`).join(' · ') : '';
    tag = title ? `<span title="${esc(title)}">${esc(text)}</span>` : esc(text);
  }

  if (!tk || !tk.columns?.length) {
    return card({
      key: target.id, title, tag, accent, kind: 'token', clickable: gridCard.clickable === 'detail',
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
  // `labels_en` overlays this map key by key, so translating only `today` leaves the
  // rest on their configured values instead of blanking them.
  const L = cmap(gridCard, 'labels');
  const todayLabel = L.today || 'Today';
  const reqLabel = L.requests_suffix || 'req';
  // Today's actually-new tokens, directly under today's total so the two are read as
  // a pair: a long agentic session replays its whole context every turn, so the total
  // counts tens of millions while only the uncached remainder was computed. Rendered
  // only when the query supplied net_tokens -- pivotTokens sends null otherwise, and
  // a null must not become a "0" that reads like real data. The all-time counterpart
  // lives in the detail modal's table, where there is room for it.
  const netLabel = L.net || 'Net';
  // v2.24 (usage source): the requests line is today's, and a grey last line gives the
  // part of today's tokens that went through LiteLLM.
  const llLabel = L.via_ll || 'via LiteLLM';
  const colHtml = cols.map((c) => `
    <div class="tk-col">
      <div class="tk-h" style="color:${esc(c.color)}">${esc(c.label)}</div>
      <div class="tk-div"></div>
      <div class="tk-all">${esc(c.all)}</div>
      <div class="tk-sub">${esc(todayLabel)} ${esc(c.today)}</div>
      ${c.net_today != null ? `<div class="tk-sub">${esc(netLabel)} ${esc(c.net_today)}</div>` : ''}
      <div class="tk-sub">${esc(Number(c.requests ?? 0).toLocaleString('en-US'))} ${esc(reqLabel)}</div>
      ${c.ll_today != null ? `<div class="tk-sub tk-ll">${esc(llLabel)} ${esc(c.ll_today)}</div>` : ''}
    </div>`).join('');

  // v2.23: bar heights are fractions (--f), not pixels, so the chart grows with the space it
  // is given -- a card stretched to its row's height gets taller bars, not a blank strip.
  const max = Math.max(1, ...(tk.spark || []).map((s) => s.value || 0));
  const sparkHtml = (tk.spark || []).map((s) => {
    const f = ((s.value || 0) / max).toFixed(3);
    return `<div class="col"><div class="bw"><div class="n">${esc(s.display)}</div><div class="b" style="--f:${f}"></div></div><div class="d">${esc(s.label)}</div></div>`;
  }).join('');

  // click hint is externalized (gridCard.hint); shown only when clickable + set.
  // v2.24: the card says from when direct (non-LiteLLM) usage is in it -- per node, the day
  // its counter started -- and when some counter is missing right now.
  const parts = [];
  const cov = coverageList(tk.coverage);
  if (cov) parts.push(t('tk_cov', cov));
  if (Array.isArray(tk.partial) && tk.partial.includes(tk.today)) parts.push(t('tk_partial'));
  const hintText = cv(gridCard, 'hint');
  if (gridCard.clickable === 'detail' && hintText) parts.push(hintText);
  const note = parts.length ? `<div class="note">${esc(parts.join(' · '))}</div>` : '';
  // Boxes per row in the compact arrangements (narrow card, or beside the chart on a wide
  // one): four boxes go 2x2, fewer stay on one row -- never a 2+1 with a hole.
  const n = cols.length;
  const compactCols = n <= 3 ? n : Math.ceil(n / 2);
  const body = `<div class="tk-main"><div class="tk-grid" style="--tk-n:${n};--tk-c:${compactCols}">${colHtml}</div>`
    + (sparkHtml ? `<div class="spark">${sparkHtml}</div>` : '')
    + '</div>'
    + note;

  return card({ key: target.id, title, tag, body, accent, kind: 'token', clickable: gridCard.clickable === 'detail' });
}
