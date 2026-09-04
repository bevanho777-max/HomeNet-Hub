// Config-driven dashboard frontend (§6).
// Reads /api/config (layout) + /api/snapshot (values) and renders. Old markup,
// old styles, new "config → DOM" logic. Config is re-fetched with ETag so a
// hot-reloaded YAML re-shapes the panel with no page reload.
import { renderMachine } from './renderers/machine.js';
import { renderToken } from './renderers/token.js';
import { renderService } from './renderers/service.js';
import { renderStack } from './renderers/stack.js';
import { renderInfo } from './renderers/info.js';
import { renderTable } from './renderers/table.js';
import { initHistory, historyRefresh } from './renderers/history.js';
import { initMachineDetail, openMachineModal, closeMachineModal, bindMachineModal } from './renderers/machine_detail.js';
import { bindAddTarget, closeAddPanel, openAddPanel } from './renderers/add_target.js';
import { bindCredentials, closeCredPanel } from './renderers/credentials.js';
import { bindSession, refreshSession, sessionLost, closeLoginPanel, closeSetupPanel, maybeOpenSetup, isAuthed, openLoginPanel } from './renderers/session.js';
import { bindDemoBar, applyDemoBar, emptyBoardHtml } from './renderers/demo.js';
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
    // B23: dispatch by card type. Every clickable card used to open the token modal,
    // which was fine while the token card was the only one; a machine card needs its
    // own. `onclick` (not addEventListener) so a re-render replaces the handler
    // instead of stacking a new one on the persisted shell.
    el.onclick = c.clickable ? () => openCardModal(c) : null;
  }
  container.querySelectorAll('.card').forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });
}

// B23: which modal a card opens. `kind` comes from the renderer via card(), so the
// routing lives with the card definition rather than being re-derived from the layout.
function openCardModal(c) {
  if (c.kind === 'machine') openMachineModal(c.key, `${c.title} Detail`);
  else openTokenModal(c.key);
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
      // 环下的标签是 .ring 的兄弟节点(同在 .ring-wrap 内),不在上面几行的同步范围里。
      // 只改 metrics.yaml 的 label 时环数不变,会走这条保留分支 —— 不同步它的话,标签会
      // 一直停在首次挂载时的文案(改了 rings 指标却仍显示旧名),只有硬刷才更新。
      const ol = or.parentElement?.querySelector('.ring-label');
      const nl = nr.parentElement?.querySelector('.ring-label');
      if (ol && nl && ol.textContent !== nl.textContent) ol.textContent = nl.textContent;
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

// B12-row: a row-stack lays out horizontally only when its measured width meets
// the threshold (data-min = min_row_width, else children × 180px); otherwise it
// wraps back to column. CSS container queries can't take a configurable px value,
// so we measure and toggle `.is-row` here (re-run on every render + on resize).
function layoutStacks() {
  document.querySelectorAll('.stack[data-dir="row"]').forEach((el) => {
    // Measure the AVAILABLE width in the stable column state (row content can grow
    // the element and self-lock the decision), then re-apply row only if it fits.
    el.classList.remove('is-row');
    const min = Number(el.dataset.min) || 360;
    if (el.clientWidth >= min) el.classList.add('is-row'); // reading clientWidth forces reflow first
  });
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
    else if (gc.type === 'table') cards.push(renderTable(gc, target, snap));
  }
  // P2: an empty grid is a normal state now — it is what a cleared demo board looks
  // like, and what a fresh install looks like before the first target is added. Say so
  // instead of leaving a blank page that reads as a failed load. mountCards persists
  // card DOM between renders, so the placeholder is written only once the card list is
  // genuinely empty and cleared again the moment anything exists.
  if (!cards.length) {
    $('#grid').innerHTML = emptyBoardHtml(isAuthed());
  } else {
    mountCards('grid', cards);
    layoutStacks();
  }

  // The banner reads the same config payload everything else does, so it appears and
  // disappears on the same tick the board does.
  applyDemoBar(CONFIG, isAuthed());

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

// ── polling (B15: resilient) ──
// AbortController timeout so a stalled network can't wedge a tick indefinitely.
async function fetchT(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Connection badge state machine — don't flap on a single transient blip.
const RECONNECT_AT = 2;   // consecutive failures → "Reconnecting…" (yellow)
const OFFLINE_AT = 5;     // consecutive failures → "Disconnected" (red)
let failStreak = 0;
function setConn(state) {
  const el = $('#conn'); if (!el) return;
  if (state === 'ok') { el.className = 'conn ok'; el.textContent = txt('conn_online', 'Online'); }
  else if (state === 'reconnecting') { el.className = 'conn warn'; el.textContent = txt('conn_reconnecting', 'Reconnecting…'); }
  else if (state === 'locked') { el.className = 'conn warn'; el.textContent = txt('conn_locked', 'Login required'); }
  else { el.className = 'conn bad'; el.textContent = txt('conn_offline', 'Disconnected'); }
}

async function snapTick() {
  try {
    const r = await fetchT('/api/snapshot', { cache: 'no-store' });
    if (r.status === 401) { setConn('locked'); await sessionLost(); return; }
    if (!r.ok) throw new Error('http ' + r.status);
    lastSnap = await r.json();
    // B23: the detail modal picks its default lines from the host's live role (GPU box
    // / gateway / NAS), which is the same signal autoColor() reads below.
    window.__lastSnap = lastSnap;
    failStreak = 0;
    setConn('ok');
    render();
  } catch {
    failStreak++;
    if (failStreak >= OFFLINE_AT) setConn('bad');
    else if (failStreak >= RECONNECT_AT) setConn('reconnecting');
    // a single transient failure keeps the last-known badge (no flap)
  }
}

async function configTick(first = false) {
  try {
    const headers = CONFIG_ETAG ? { 'If-None-Match': CONFIG_ETAG } : {};
    const r = await fetchT('/api/config', { cache: 'no-store', headers });
    if (r.status === 304) return;
    // 401 here means REQUIRE_LOGIN_TO_VIEW is on and we are not (or no longer) logged
    // in. Distinct from a network failure: the badge says so and the login entry comes
    // back, rather than the page sitting on "Disconnected" forever.
    if (r.status === 401) { setConn('locked'); await sessionLost(); return; }
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
  // Version footer. Written only when the server reported one — an older backend, or
  // one whose package.json could not be read, leaves the footer empty rather than
  // showing "v" or "undefined".
  $('#version').textContent = CONFIG.version ? `v${CONFIG.version}` : '';
  $('#tokenModalClose').textContent = txt('modal_close', 'Close');
  $('#machineModalClose').textContent = txt('modal_close', 'Close');
  initHistory(CONFIG);
  initMachineDetail(CONFIG);
  render();
  if (first) console.log('[hub] config loaded etag=', CONFIG_ETAG);
}

// ── clock ──
// 双时区。用 IANA 时区名交给 Intl 处理夏令时(美西 8 月 PDT 与 1 月 PST 差一小时,
// 这里不做任何偏移硬编码)。formatToParts 一次调用同时拿到显示串和当地小时,
// 昼夜判定不再多格式化一遍。
const CLOCK_ZONES = [
  { key: 'CN', tz: 'Asia/Shanghai' },
  { key: 'US', tz: 'America/Los_Angeles' },
];
const _clockFmt = new Map();   // tz  -> Intl.DateTimeFormat(只构造一次)
const _clockEls = new Map();   // key -> { row, icon, time }

function clockFmt(tz) {
  let f = _clockFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    _clockFmt.set(tz, f);
  }
  return f;
}

function clockEls(key) {
  let e = _clockEls.get(key);
  if (!e || !e.row.isConnected) {
    const row = document.querySelector(`.tzrow[data-z="${key}"]`);
    if (!row) return null;
    e = { row, time: row.querySelector('.tztime') };
    _clockEls.set(key, e);
  }
  return e;
}

function tickClock() {
  const box = $('#clock');
  if (!box) return;
  const on = CONFIG?.header?.clock !== false;
  box.hidden = !on;
  if (!on) return;
  const now = new Date();
  for (const z of CLOCK_ZONES) {
    const e = clockEls(z.key);
    if (!e) continue;
    const parts = clockFmt(z.tz).formatToParts(now);
    const g = (t) => parts.find((x) => x.type === t)?.value || '';
    const text = `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
    // 每秒只动这一处文本;整块 DOM 不重建。
    if (e.time.textContent !== text) e.time.textContent = text;
    // 图标与冷暖 class 只在昼夜翻转的那一秒改,平时不碰。
    const day = Number(g('hour')) >= 6 && Number(g('hour')) < 18;
    // 判据用"目标 class 是否已在"而不是"day class 与 day 是否相等" —— 后者在首次渲染
    // 且当地正处夜晚时会误判为无需变更,导致 night class 永远加不上(HTML 初始两个 class 都没有)。
    const want = day ? 'day' : 'night';
    if (!e.row.classList.contains(want)) {
      // 两个图标常驻 DOM,由 CSS 按 day/night 切显隐,所以这里只切 class,
      // 不再写图标内容 —— 月亮是内联 SVG,textContent 写不了。
      e.row.classList.toggle('day', day);
      e.row.classList.toggle('night', !day);
    }
  }
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
    const r = await fetchT(`/api/token_detail?range=${tokenRange}`, { cache: 'no-store' });
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
bindMachineModal();
// Slice 3: the add-target panel refreshes the board through the same two ticks a
// hot-reload would use, rather than reaching into the renderers itself. A new target
// changes the config etag, so configTick fetches instead of 304-ing.
bindAddTarget({
  onChanged: async () => { await configTick(false); await snapTick(); },
});
// Credentials do not appear on the board themselves, but a target that uses one will,
// so the panel refreshes through the same path rather than inventing a second one.
bindCredentials({
  onChanged: async () => { await configTick(false); await snapTick(); },
});
// admin-auth: logging in or out changes what this tab may see AND what it may show, so
// both directions refresh the board through the same two ticks everything else uses.
// Logging out also closes any admin panel left open behind the modal.
bindSession({
  onChange: async () => {
    closeAddPanel();
    closeCredPanel();
    await configTick(false);
    await snapTick();
  },
});
// P2 onboarding bar. "添加你的机器" is the existing add-target panel, not a second
// path — one flow to learn, and it already carries discovery. "清空演示" refreshes
// through the same configTick every other change uses, so the demo cards leave the
// screen by the normal render path rather than a bespoke teardown.
bindDemoBar({
  onAdd: () => openAddPanel(),
  // Logged out, both buttons lead to the same place: openLoginPanel already redirects
  // to the first-run wizard when that is what this install actually needs (P1).
  needsLogin: () => openLoginPanel(),
  onCleared: async () => {
    // The etag changed server-side, but this tab is holding the old one; clearing it
    // guarantees the next fetch is a 200 with the emptied board rather than a 304.
    CONFIG_ETAG = null;
    await configTick(false);
    await snapTick();
  },
});
// Esc closes whichever modal is open — the token one had no keyboard exit either.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMachineModal();
  closeTokenModal();
  closeAddPanel();
  closeCredPanel();
  closeLoginPanel();
  closeSetupPanel();
});

// B15 §4: relax the snapshot cadence on touch / narrow devices to save battery
// (desktop unchanged). Evaluated as optional — a mild 2× relaxation only.
function fastMs() {
  const m = window.matchMedia;
  const mobile = m && (m('(pointer: coarse)').matches || m('(max-width: 560px)').matches);
  return mobile ? FAST_MS * 2 : FAST_MS;
}

let snapTimer = null, configTimer = null, clockTimer = null;
function startTimers() {
  stopTimers();
  snapTimer = setInterval(snapTick, fastMs());
  configTimer = setInterval(() => configTick(false), CONFIG_MS);
  clockTimer = setInterval(tickClock, 1000);
}
function stopTimers() {
  clearInterval(snapTimer); clearInterval(configTimer); clearInterval(clockTimer);
  snapTimer = configTimer = clockTimer = null;
}

// The session comes first: with REQUIRE_LOGIN_TO_VIEW on, configTick's answer depends
// on it, and either way the header must not flash admin buttons the server would refuse.
refreshSession()
  // A fresh install with no admin password gets the one-time wizard here, before the
  // board loads: with REQUIRE_LOGIN_TO_VIEW on, configTick's 401 is the only thing that
  // would otherwise happen, and "locked" with no way to unlock reads as broken.
  .then(() => { maybeOpenSetup(); })
  .then(() => configTick(true))
  .then(() => {
    snapTick();
    tickClock();
    startTimers();
  });

// B15 §1/§3: on returning to the foreground, refresh everything immediately
// (don't wait for the next interval) and resume timers; on hidden, pause the
// timers to save power (mobile browsers throttle/freeze them anyway).
window.addEventListener('resize', layoutStacks); // B12-row: re-measure stacks on resize
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    snapTick();
    configTick(false);
    tickClock();
    historyRefresh();
    startTimers();
  } else {
    stopTimers();
  }
});
