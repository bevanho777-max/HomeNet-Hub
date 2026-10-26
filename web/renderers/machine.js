// machine renderer (§6) — rings + KV grid + header_right (uptime/badge).
import { ring, kvItem, mget, card, esc, shownParts } from './common.js';
import { cv, t } from '../i18n.js';

function hm(ms) {
  const d = new Date(ms), now = new Date();
  const p2 = (x) => ('0' + x).slice(-2);
  const s = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? s : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${s}`;
}

// v2.31: the hub refused a push for this target from a host other than the one it is bound
// to (server/store/push_bindings.js). Said on the card face, online or not: the card's own
// numbers still come from the bound host, so nothing else on it would look wrong.
function pushAlert(snap) {
  const a = snap?.push_alert;
  if (!a?.ip) return '';
  const tip = t('push_unexpected_title', hm(a.first || a.at), hm(a.at), a.count || 1);
  return `<div class="push-alert" title="${esc(tip)}">${esc(t('push_unexpected', a.ip, a.hostname))}</div>`;
}

export function renderMachine(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';

  if (!snap || snap.online === false) {
    // Still clickable while offline: the host has no live values but its history is
    // exactly what you want to look at when it stops reporting.
    return card({
      key: target.id, title, tag: target.badge || '', accent,
      stale: true, kind: 'machine', clickable: gridCard.clickable === 'detail',
      body: `${pushAlert(snap)}<div class="note">Host offline / no data${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  // i18n: a metric template may carry `label_en`; with none, the base label is used in
  // both languages rather than falling back to the bare key.
  const label = (k) => cv(metrics?.[k], 'label') || k;
  const rings = (gridCard.rings || []).map((k) => ring(label(k), mget(snap, k))).join('');
  // v2.27: a table-like cell (By Model) is two cells wide; the grid fills any hole it would
  // leave (grid-auto-flow: dense). `subs` puts a second metric on a cell's second line (the
  // gateway's 5-minute count under today's), so it needs no cell of its own.
  const keys = gridCard.items || [];
  const subs = gridCard.subs && typeof gridCard.subs === 'object' ? gridCard.subs : {};
  const isTable = (k) => metrics?.[k]?.parts_layout === 'table';
  // v2.28: a table cell with one entry or none (just after midnight) is one cell wide -- two
  // would be mostly empty. The column it gives back gets real content: a `subs` metric has a
  // cell of its own again, right after its cell (the gateway's "Last 5m" beside Chat Today);
  // only a card without one widens its last plain cell. The grid keeps its shape, no hole.
  const narrow = keys.filter((k) => isTable(k) && shownParts(mget(snap, k)).length < 2);
  let spare = narrow.length;
  const promoted = new Set();
  for (const k of keys) if (spare && subs[k] && !isTable(k)) { promoted.add(k); spare -= 1; }
  const plain = keys.filter((k) => !isTable(k));
  const takers = new Set(spare ? plain.slice(-spare) : []);
  const items = keys.map((k) => {
    const sk = subs[k];
    const sub = sk && !promoted.has(k) ? `${label(sk)} ${mget(snap, sk).display ?? '—'}` : '';
    const wide = (isTable(k) && !narrow.includes(k)) || takers.has(k);
    return kvItem(label(k), mget(snap, k), metrics?.[k], { sub, itemCls: wide ? 'span2' : '' })
      + (promoted.has(k) ? kvItem(label(sk), mget(snap, sk), metrics?.[sk]) : '');
  }).join('');

  // header_right: 'badge' → target.badge, else a metric key → its display.
  // B13: an array combines parts with a vertical hairline, e.g. [badge, uptime]
  // → "RX 7900XTX │ 15d 7h". Backward-compatible with a single string.
  const hrPart = (el) => (el === 'badge' ? (target.badge || '') : (mget(snap, el).display || ''));
  let tag = target.badge || '';
  if (gridCard.header_right) {
    tag = Array.isArray(gridCard.header_right)
      ? gridCard.header_right.map(hrPart).filter((s) => s && s !== '—').map(esc).join('<span class="tag-sep"></span>')
      : (gridCard.header_right === 'badge' ? (target.badge || '') : (mget(snap, gridCard.header_right).display || tag));
  }

  // v2.18: fewer GPUs detected than the target's gpu_count. Said in words on the card
  // face, because the aggregates alone would look perfectly healthy with one card gone.
  const gc = snap.metrics?.gpu_cards;
  const warn = gc && gc.expected && typeof gc.value === 'number' && gc.value < gc.expected
    ? `<div class="gpu-missing">${esc(t('gpu_cards_missing', gc.value, gc.expected))}</div>` : '';

  // v2.23: rings and cells sit in one .mach block so a card the grid has widened can put
  // them side by side (tokens.css); data-n (cell slots, a two-wide cell counting two) lets
  // the cell grid pick a column count that divides it, so no row is left half empty.
  const n = keys.length + keys.filter(isTable).length;
  const body = `${pushAlert(snap)}${warn}<div class="mach"><div class="rings">${rings}</div>${items ? `<div class="kv" data-n="${n}">${items}</div>` : ''}</div>`;
  return card({
    key: target.id, title, tag, body, accent, stale: snap.stale,
    kind: 'machine', clickable: gridCard.clickable === 'detail',
  });
}
