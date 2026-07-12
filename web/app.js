// Config-driven dashboard frontend (§6).
// Reads /api/config (layout) + /api/snapshot (values) and renders. Old markup,
// old styles, new "config → DOM" logic. Config is re-fetched with ETag so a
// hot-reloaded YAML re-shapes the panel with no page reload.
import { renderMachine } from './renderers/machine.js';
import { renderToken } from './renderers/token.js';
import { renderService } from './renderers/service.js';
import { renderStack } from './renderers/stack.js';
import { renderInfo } from './renderers/info.js';
import { initHistory } from './renderers/history.js';
import { esc, statusLevel } from './renderers/common.js';

const FAST_MS = 1500;     // snapshot poll (machine/GPU rhythm)
const CONFIG_MS = 10000;  // config re-check (hot-reload pickup)

const $ = (s) => document.querySelector(s);

let CONFIG = null;
let CONFIG_ETAG = null;
let lastSnap = {};

// ── shell-persist mount (ported from .24: keeps .ring DOM so comet/breathe
// animations stay continuous; only the body data updates) ──
function mountCards(containerId, cards) {
  const container = document.getElementById(containerId);
  const seen = new Set();
  for (const c of cards) {
    seen.add(c.key);
    let el = container.querySelector(`.card[data-key="${CSS.escape(c.key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.dataset.key = c.key;
      if (c.accent) el.style.setProperty('--accent', c.accent);
      el.innerHTML = `<h2>${esc(c.title)}${c.tag ? `<span class="tag">${c.tag}</span>` : ''}</h2><div class="card-body">${c.body}</div>`;
      container.appendChild(el);
    } else {
      if (c.accent) el.style.setProperty('--accent', c.accent);
      const body = el.querySelector('.card-body');
      if (body) updateBodyKeepRings(body, c.body);
      // shell-persist: create the .tag span if it wasn't there at first mount
      // (a card that mounted tagless while offline can later gain a header_right,
      //  e.g. uptime), update it when present, remove it when the tag goes empty.
      const h2 = el.querySelector('h2');
      let tagEl = h2 && h2.querySelector('.tag');
      if (c.tag) {
        if (!tagEl && h2) { tagEl = document.createElement('span'); tagEl.className = 'tag'; h2.appendChild(tagEl); }
        if (tagEl) tagEl.innerHTML = c.tag;
      } else if (tagEl) {
        tagEl.remove();
      }
    }
    el.classList.toggle('clickable', !!c.clickable);
    el.classList.toggle('stale', !!c.stale);
    el.onclick = c.clickable ? () => openTokenModal(c.key) : null;
  }
  container.querySelectorAll('.card').forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });
}

function updateBodyKeepRings(body, newHTML) {
  const tmp = document.createElement('div');
  tmp.innerHTML = newHTML;
  const oldRings = body.querySelectorAll('.ring');
  const newRings = tmp.querySelectorAll('.ring');
  if (oldRings.length && oldRings.length === newRings.length) {
    newRings.forEach((nr, i) => {
      const or = oldRings[i];
      const style = nr.getAttribute('style') || '';
      const mP = style.match(/--p:\s*([0-9.]+)/);
      const mC = style.match(/--c:\s*([^;]+)/);
      if (mP) or.style.setProperty('--p', mP[1]);
      if (mC) or.style.setProperty('--c', mC[1].trim());
      const ob = or.querySelector('b'), nb = nr.querySelector('b');
      if (ob && nb && ob.textContent !== nb.textContent) ob.textContent = nb.textContent;
    });
    const oldBox = body.querySelector('.rings');
    const newBox = tmp.querySelector('.rings');
    if (oldBox && newBox) {
      while (oldBox.nextSibling) body.removeChild(oldBox.nextSibling);
      let n = newBox.nextSibling;
      while (n) { const next = n.nextSibling; body.appendChild(n); n = next; }
      return;
    }
  }
  body.innerHTML = newHTML;
}

// ── status pills ──
// B1: green for healthy vocab, red only for explicit failure vocab (offline/down/
// timeout/…) or transport failure (online===false); unknown/other → neutral grey.
function chip(target, snap) {
  let cls = 'unknown', lat = '';
  if (snap) {
    if (snap.online === false) cls = 'offline';
    else {
      const st = snap.metrics?.status?.value;
      const lvl = statusLevel(st);
      cls = st == null ? 'online' : (lvl === 'danger' ? 'offline' : lvl === 'ok' ? 'online' : 'unknown');
      const l = snap.metrics?.latency?.display;
      if (l && l !== '—') lat = `<span class="lat">${esc(l)}</span>`;
    }
  }
  return `<span class="chip ${cls}"><span class="dot"></span>${esc(target.name || target.id)}${lat}</span>`;
}

// ── main render ──
function targetById(id) { return (CONFIG.targets || []).find((t) => t.id === id) || { id }; }

// B14: identity color for `color: auto` (or omitted) — role decided from live data.
// GPU metrics present (⇔ payload gpus[] non-empty) → gpu; none → host; service/
// token/stack → service. Switches in real-time (pull a card → gpu metrics null →
// host color). An explicit color always wins (manual priority). Role colors are
// overridable via theme.yaml `roles: { gpu, host, service }`.
const ROLE_DEFAULT = { gpu: '#ff9d5c', host: '#5aa6ff', service: '#b18cff' };
function autoColor(target, snap, cardType) {
  if (target && target.color && target.color !== 'auto') return target.color; // manual wins
  const roles = { ...ROLE_DEFAULT, ...(CONFIG.theme?.roles || {}) };
  let role;
  if (cardType === 'service' || cardType === 'token' || cardType === 'stack') role = 'service';
  else {
    const hasGpu = ['gpu', 'vram_pct', 'gpu_temp', 'gpu_power', 'vram_bytes']
      .some((k) => typeof snap?.metrics?.[k]?.value === 'number');
    role = hasGpu ? 'gpu' : 'host';
  }
  return roles[role] || '';
}

function render() {
  if (!CONFIG) return;
  const metrics = CONFIG.metrics || {};

  // chips
  const sb = CONFIG.layout?.status_bar?.targets || [];
  $('#services').innerHTML = sb.map((id) => chip(targetById(id), lastSnap[id])).join('');

  // cards
  const cards = [];
  for (const gc of CONFIG.layout?.grid || []) {
    const raw = targetById(gc.target);
    const snap = lastSnap[gc.target];
    const target = { ...raw, color: autoColor(raw, snap, gc.type) }; // B14: resolve auto/omitted color
    if (gc.type === 'machine') cards.push(renderMachine(gc, target, snap, metrics));
    else if (gc.type === 'token') cards.push(renderToken(gc, target, snap));
    else if (gc.type === 'service') cards.push(renderService(gc, target, snap, metrics));
    else if (gc.type === 'stack') cards.push(renderStack(gc, (id) => {
      const t = targetById(id); const s = lastSnap[id];
      return { target: { ...t, color: autoColor(t, s, 'service') }, snap: s };
    }, metrics));
    else if (gc.type === 'info') cards.push(renderInfo(gc, target, snap));
  }
  mountCards('grid', cards);

  $('#rawjson').textContent = JSON.stringify(lastSnap, null, 2);
}

// externalized UI label with a generic (non-project) bottom-line fallback (§12-step2)
function txt(key, fallback) {
  const v = CONFIG?.layout?.text?.[key];
  return (v == null || v === '') ? fallback : v;
}
function tokenCardCfg() {
  return (CONFIG?.layout?.grid || []).find((c) => c.type === 'token') || {};
}

// ── polling ──
async function snapTick() {
  try {
    const r = await fetch('/api/snapshot', { cache: 'no-store' });
    lastSnap = await r.json();
    $('#conn').className = 'conn ok';
    $('#conn').textContent = txt('conn_online', 'Online');
    render();
  } catch {
    $('#conn').className = 'conn bad';
    $('#conn').textContent = txt('conn_offline', 'Disconnected');
  }
}

async function configTick(first = false) {
  try {
    const headers = CONFIG_ETAG ? { 'If-None-Match': CONFIG_ETAG } : {};
    const r = await fetch('/api/config', { cache: 'no-store', headers });
    if (r.status === 304) return;
    if (!r.ok) return;
    CONFIG = await r.json();
    CONFIG_ETAG = r.headers.get('ETag') || CONFIG.etag || null;
    applyConfig(first);
  } catch { /* keep previous config */ }
}

// §12-step6: inject theme.yaml values as CSS variables (override :root defaults,
// which already equal the built-in look → unmodified theme = pixel-identical).
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const root = document.documentElement.style;
  const set = (k, v) => { if (v != null && v !== '') root.setProperty(k, v); };
  set('--font', theme.font_family);
  set('--card-bg', theme.card_bg);
  if (theme.background) { set('--bg0', theme.background.base0); set('--bg1', theme.background.base1); set('--bg2', theme.background.base2); }
  if (theme.status) { set('--green', theme.status.ok); set('--yellow', theme.status.warn); set('--red', theme.status.danger); set('--cyan', theme.status.cool); }
  applySubtitle(theme.subtitle);
}
// optional brand subtitle (title authority stays layout.header.title). Created
// only when set, so the default (unset) DOM/layout is unchanged.
function applySubtitle(text) {
  let el = document.getElementById('subtitle');
  if (text) {
    if (!el) {
      el = document.createElement('span');
      el.id = 'subtitle';
      el.style.cssText = 'font-size:12px;color:var(--muted);margin-left:8px;align-self:center';
      document.querySelector('.brand')?.appendChild(el);
    }
    el.textContent = text;
  } else if (el) { el.remove(); }
}

function applyConfig(first) {
  applyTheme(CONFIG.theme);
  const title = CONFIG.header?.title || 'Dashboard';
  document.title = title;
  $('#title').textContent = title;
  // externalized chrome labels (config-driven, generic fallbacks)
  if (!$('#conn').textContent) $('#conn').textContent = txt('conn_connecting', 'Connecting…');
  $('#historyTitle').textContent = CONFIG.layout?.history?.title || '';
  $('#rawTitle').textContent = txt('raw_title', 'Raw JSON');
  $('#tokenModalClose').textContent = txt('modal_close', 'Close');
  initHistory(CONFIG);
  render();
  if (first) console.log('[hub] config loaded etag=', CONFIG_ETAG);
}

// ── clock ──
function tickClock() {
  const el = $('#clock');
  if (el && CONFIG?.header?.clock !== false) el.textContent = new Date().toLocaleTimeString('zh-CN');
}

// ── token detail modal ──
const TOKEN_RANGES = ['24h', '7d', '30d'];
let tokenRange = '24h';
let tokenTargetId = null;

async function openTokenModal(targetId) {
  tokenTargetId = targetId;
  $('#tokenModalTitle').textContent = tokenCardCfg().detail_title || 'Detail';
  $('#tokenModal').classList.add('open');
  $('#tokenModalRanges').innerHTML = TOKEN_RANGES.map((r) =>
    `<button data-r="${r}" class="${r === tokenRange ? 'active' : ''}">${r}</button>`).join('');
  $('#tokenModalRanges').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tokenRange = b.dataset.r;
    [...$('#tokenModalRanges').children].forEach((x) => x.classList.toggle('active', x === b));
    loadTokenDetail();
  };
  loadTokenDetail();
}
function closeTokenModal() { $('#tokenModal').classList.remove('open'); }

async function loadTokenDetail() {
  const tbl = $('#tokenModalTable');
  try {
    const r = await fetch(`/api/token_detail?range=${tokenRange}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.error) { tbl.innerHTML = `<div class="note">Detail unavailable: ${esc(j.error)}</div>`; drawTokenChart({ days: [], classes: [], matrix: {} }); return; }
    drawTokenChart(j.series || { days: [], classes: [], matrix: {} });
    const col = tokenCardCfg().columns || {};
    const th = (k, fb) => esc(col[k] || fb);
    tbl.innerHTML = `<table class="tbl"><thead><tr><th>${th('model', 'Model')}</th><th>${th('tokens', 'Tokens')}</th><th>${th('requests', 'Requests')}</th><th>${th('share', 'Share')}</th></tr></thead><tbody>${
      (j.table || []).map((row) => `<tr><td><span class="sw" style="background:${esc(row.color)}"></span>${esc(row.label)}</td><td>${esc(row.tokens)}</td><td>${esc(row.requests)}</td><td>${esc(row.share)}%</td></tr>`).join('')
    }</tbody></table>`;
  } catch (e) {
    tbl.innerHTML = `<div class="note">Detail request failed</div>`;
  }
}

// stacked bars: per day, classes stacked
function drawTokenChart(series) {
  const canvas = $('#tokenModalCanvas');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 660, cssH = 220;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const days = series.days || [];
  const classes = series.classes || [];
  const matrix = series.matrix || {};
  if (!days.length) {
    ctx.fillStyle = 'rgba(248,250,252,0.4)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No data', cssW / 2, cssH / 2); return;
  }
  const padB = 22, padT = 10, H = cssH - padB - padT;
  let maxTotal = 1;
  for (let i = 0; i < days.length; i++) {
    let t = 0; for (const c of classes) t += (matrix[c.key]?.[i] || 0);
    if (t > maxTotal) maxTotal = t;
  }
  const bw = Math.min(40, (cssW - 20) / days.length * 0.6);
  const step = (cssW - 20) / days.length;
  ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
  days.forEach((d, i) => {
    const x = 10 + step * i + step / 2;
    let y = cssH - padB;
    for (const c of classes) {
      const v = matrix[c.key]?.[i] || 0;
      const h = (v / maxTotal) * H;
      ctx.fillStyle = c.color;
      ctx.fillRect(x - bw / 2, y - h, bw, h);
      y -= h;
    }
    ctx.fillStyle = 'rgba(248,250,252,0.45)';
    ctx.fillText(d, x, cssH - 6);
  });
}

// ── boot ──
$('#tokenModalClose').onclick = closeTokenModal;
$('#tokenModal').onclick = (e) => { if (e.target.id === 'tokenModal') closeTokenModal(); };

configTick(true).then(() => {
  snapTick();
  setInterval(snapTick, FAST_MS);
  setInterval(() => configTick(false), CONFIG_MS);
  tickClock();
  setInterval(tickClock, 1000);
});
