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

// v2.32 the badge's shorter forms for a narrow header (fit.js data-short / data-short2):
// "RTX 4070 Laptop" -> "4070 Laptop" (vendor prefix off) -> "4070"
function badgeForms(b) {
  const noVendor = String(b || '').replace(/^(\d+×\s*)?(RTX|GTX|RX|Arc)\s+/i, '$1').trim();
  const bare = noVendor.replace(/\s+(Laptop|Mobile|Max-Q)$/i, '').trim();
  return [noVendor !== b ? noVendor : null, bare !== noVendor ? bare : null];
}

export function renderMachine(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';
  // v2.32 what the machine is for (target `role`: LLM / ComfyUI), a pill after the title
  const role = target.role || '';
  const offline = !snap || snap.online === false;

  if (offline && target.always_on !== false) {
    // Still clickable while offline: the host has no live values but its history is
    // exactly what you want to look at when it stops reporting.
    return card({
      key: target.id, title, tag: target.badge || '', accent, role,
      stale: true, kind: 'machine', clickable: gridCard.clickable === 'detail',
      body: `${pushAlert(snap)}<div class="note">Host offline / no data${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }
  // v2.32 a machine that is often off or asleep (always_on: false -- the laptops, m110) is not
  // a fault: the card stays as it is, greyed, every reading "—", and the header says 未开机
  // (with when it last reported) where the uptime was. Never red.
  if (offline) {
    const when = snap?.at ? hm(snap.at) : null;
    const word = `<span class="off-word" title="${esc(when ? t('machine_off_since', when) : t('machine_off'))}">${esc(t('machine_off'))}</span>`;
    const tag = [target.badge ? esc(target.badge) : '', word].filter(Boolean).join('<span class="tag-sep"></span>');
    return card({
      key: target.id, title, tag, tagShort: t('machine_off'), accent, role, stale: true,
      kind: 'machine', clickable: gridCard.clickable === 'detail',
      body: `${pushAlert(snap)}${machineBody(gridCard, offMetrics(snap), metrics, true)}`,
    });
  }

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
  // (v2.32 shorter forms for a narrow header: the badge alone, then without its vendor prefix)
  const [b1, b2] = badgeForms(target.badge);
  const multi = Array.isArray(gridCard.header_right) && gridCard.header_right.length > 1 && target.badge;
  const tagShort = multi ? target.badge : b1;
  const tagShort2 = multi ? b1 : b2;

  // v2.18: fewer GPUs detected than the target's gpu_count. Said in words on the card
  // face, because the aggregates alone would look perfectly healthy with one card gone.
  const gc = snap.metrics?.gpu_cards;
  const warn = gc && gc.expected && typeof gc.value === 'number' && gc.value < gc.expected
    ? `<div class="gpu-missing">${esc(t('gpu_cards_missing', gc.value, gc.expected))}</div>` : '';

  return card({
    key: target.id, title, tag, tagShort, tagShort2, body: `${pushAlert(snap)}${warn}${machineBody(gridCard, snap, metrics)}`, accent, role,
    stale: snap.stale, kind: 'machine', clickable: gridCard.clickable === 'detail',
  });
}

// v2.32 what an always_on:false machine shows while it is off: no live reading ("—"), only
// what does not change while it is off -- the size of its memory and VRAM ("—/8G"), and the
// disk as last reported ("608/953G"). Rings are all "—".
function offMetrics(snap) {
  const out = {};
  for (const [k, m] of Object.entries(snap?.metrics || {})) {
    const cap = /^\s*[\d.]+\s*\/\s*([\d.]+\s*[A-Za-z]*)\s*$/.exec(m?.display || '');
    if (!cap || !k.endsWith('_bytes') || /^gpu\d/.test(k)) continue;
    out[k] = { value: null, level: null, display: k === 'disk_bytes' ? m.display.trim() : `—/${cap[1].trim()}` };
  }
  return { metrics: out };
}

// rings + cells (v2.32: also what an always_on:false machine shows while it is off)
function machineBody(gridCard, snap, metrics, off = false) {
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

  // v2.23: rings and cells sit in one .mach block so a card the grid has widened can put
  // them side by side (tokens.css); data-n (cell slots, a two-wide cell counting two) lets
  // the cell grid pick a column count that divides it, so no row is left half empty.
  const n = keys.length + keys.filter(isTable).length;
  return `<div class="mach${off ? ' mach-off' : ''}"><div class="rings">${rings}</div>${items ? `<div class="kv" data-n="${n}">${items}</div>` : ''}</div>`;
}
