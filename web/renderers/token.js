// token renderer (§6) — by-model columns + 5-day spark.
// Data comes from snap.extra.token (pivoted server-side, see token_detail.js).
// clickable:detail → app.js opens the /api/token_detail modal.
import { card, mget, esc } from './common.js';
import { cmap, cv, t } from '../i18n.js';
import { si3 } from '../fmt.js';

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

export function renderToken(gridCard, target, snap, liveView = null) {
  const title = target.name || target.id;
  const accent = target.color || '';
  const tk = snap?.extra?.token;

  // header_right template e.g. "当前生成 {token_speed} t/s" (header_right_en for EN).
  // v2.24: no speed (nothing generating) reads "—", not "— t/s"; hovering lists the nodes.
  let tag = '';
  const tpl = cv(gridCard, 'header_right');
  if (typeof tpl === 'string' && tpl) {
    // v2.25: with a live reader the speed is live (2 s, pushed) -- the sum of the nodes'
    // current decode rates; without one, the usage engine's Prometheus rate as before.
    let sp = mget(snap, 'token_speed');
    let nodes = tk?.speed_nodes;
    if (liveView && liveView.nodes) {
      const tot = liveView.decode_total;
      sp = { value: tot, display: tot == null ? '—' : (Math.round(tot * 10) / 10).toFixed(1) };
      nodes = Object.entries(liveView.nodes).map(([node, n]) => ({ node, tps: n.busy > 0 && n.decode_tps != null ? n.decode_tps : (n.reachable ? 0 : null) }));
    }
    const text = (sp.value == null ? tpl.replace(/\{token_speed\}\s*t\/s/, '—') : tpl)
      .replace(/\{(\w+)\}/g, (_, k) => (k === 'token_speed' ? sp.display : mget(snap, k).display) || '—');
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
  // v2.27: the front is a table -- one row per class (Total last), one column per figure:
  // all-time, today, today's net (actually computed, cache hits excluded), today's requests,
  // today's part through LiteLLM. A row of figures cannot grow a box the way five stacked
  // lines did; the table is fixed-layout (tokens.css), so no figure can widen it either.
  // Headers: the card's own labels where it has them, else the abbreviation table.
  const L = cmap(gridCard, 'labels');
  const hasNet = cols.some((c) => c.net_today != null);
  const hasLl = cols.some((c) => c.ll_today != null);
  const heads = [
    ['all', t('abbr_tk_total')],
    ['today', L.today || t('abbr_tk_today')],
    ...(hasNet ? [['net', L.net || t('abbr_tk_net')]] : []),
    ['reqs', t('abbr_tk_reqs')],
    ...(hasLl ? [['ll', t('abbr_tk_ll')]] : []),
  ];
  const fig = (c, k) => {
    if (k === 'all') return c.all;
    if (k === 'today') return c.today;
    if (k === 'net') return c.net_today ?? '—';
    if (k === 'reqs') return si3(Number(c.requests ?? 0));
    return c.ll_today ?? '—';
  };
  const rowsHtml = cols.map((c) => `<tr${c.key === 'total' ? ' class="tot"' : ''}><td class="tk-name" title="${esc(c.label)}"><span class="sw" style="background:${esc(c.color)}"></span><span style="color:${esc(c.color)}">${esc(c.label)}</span></td>`
    + heads.map(([k]) => `<td class="num${k === 'll' ? ' tk-ll' : ''}">${esc(fig(c, k))}</td>`).join('') + '</tr>').join('');
  const table = `<table class="tbl tk-tbl"><colgroup><col class="c-name">${heads.map(() => '<col class="c-num">').join('')}</colgroup>`
    + `<thead><tr><th></th>${heads.map(([, h]) => `<th class="num" title="${esc(h)}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table>`;

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
  const body = `<div class="tk-main"><div class="tk-tblwrap">${table}</div>`
    + (sparkHtml ? `<div class="spark">${sparkHtml}</div>` : '')
    + '</div>'
    + note;

  return card({ key: target.id, title, tag, body, accent, kind: 'token', clickable: gridCard.clickable === 'detail' });
}
