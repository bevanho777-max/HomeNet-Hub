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
import { renderNodes } from './renderers/nodes.js';
import { renderComfy } from './renderers/comfy.js';
import { initHistory, historyRefresh, relocalizeHistory } from './renderers/history.js';
import { initMachineDetail, openMachineModal, openNodeModal, openComfyModal, closeMachineModal, bindMachineModal, relocalizeMachineModal } from './renderers/machine_detail.js';
import { openTableModal, closeTableModal, bindTableModal, relocalizeTableModal } from './renderers/table_detail.js';
import { bindAddTarget, closeAddPanel, openAddPanel, relocalizeAddPanel } from './renderers/add_target.js';
import { bindCredentials, closeCredPanel, relocalizeCredPanel } from './renderers/credentials.js';
import { bindClients, closeClientsPanel, relocalizeClientsPanel } from './renderers/clients.js';
import { bindSession, refreshSession, sessionLost, closeLoginPanel, closeSetupPanel, maybeOpenSetup, isAuthed, openLoginPanel, relocalizeSession } from './renderers/session.js';
import { bindDemoBar, applyDemoBar, emptyBoardHtml } from './renderers/demo.js';
import { esc, statusLevel, setLine } from './renderers/common.js';
import { si3 } from './fmt.js';
import { fitCards, fitLine, fitLines } from './fit.js';
import { applyDocumentLang, applyStaticText, cmap, colmap, cv, getLang, onLangChange, setLang, t } from './i18n.js';

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
      el.innerHTML = `<h2>${esc(c.title)}${c.role ? `<span class="role">${esc(c.role)}</span>` : ''}${c.tag ? `<span class="tag fit">${c.tag}</span>` : ''}</h2><div class="card-body">${c.body}</div>`;
      el._body = c.body;
      syncTagShort(el.querySelector('h2 .tag'), c);
      container.appendChild(el);
    } else {
      if (c.accent) el.style.setProperty('--accent', c.accent);
      const body = el.querySelector('.card-body');
      // v2.25: an unchanged card is not touched at all (the live nodes card refreshes every
      // 2 s; nothing else on the page should be rewritten for it)
      if (body && el._body !== c.body) { updateBodyKeepRings(body, c.body); el._body = c.body; }
      // shell-persist: the header is written once at first mount, so anything in it has
      // to be re-synced here or the card keeps what it was born with until a hard reload.
      const h2 = el.querySelector('h2');
      // The title. It changes when the target is renamed in YAML — and, now, whenever the
      // viewer flips the language switch and the card resolves `name_en` instead. It is the
      // h2's leading TEXT node (the tag span, when present, is its sibling), so this touches
      // the text and leaves the tag alone.
      if (h2) {
        const first = h2.firstChild;
        if (first && first.nodeType === Node.TEXT_NODE) {
          if (first.textContent !== c.title) first.textContent = c.title;
        } else if (c.title) {
          // Mounted title-less (a stack frame) and has since gained one.
          h2.insertBefore(document.createTextNode(c.title), h2.firstChild);
        }
      }
      // v2.32 the purpose pill after the title (LLM / ComfyUI), kept in sync the same way
      let roleEl = h2 && h2.querySelector('.role');
      if (c.role) {
        if (!roleEl && h2) { roleEl = document.createElement('span'); roleEl.className = 'role'; h2.insertBefore(roleEl, h2.querySelector('.tag')); }
        if (roleEl && roleEl.textContent !== c.role) roleEl.textContent = c.role;
      } else if (roleEl) roleEl.remove();
      // create the .tag span if it wasn't there at first mount (a card that mounted
      // tagless while offline can later gain a header_right, e.g. uptime), update it when
      // present, remove it when the tag goes empty.
      let tagEl = h2 && h2.querySelector('.tag');
      if (c.tag) {
        if (!tagEl && h2) { tagEl = document.createElement('span'); tagEl.className = 'tag fit'; h2.appendChild(tagEl); }
        if (tagEl && (tagEl._fitFull ?? tagEl.innerHTML) !== c.tag) { tagEl.innerHTML = c.tag; tagEl._fitFull = null; }
        syncTagShort(tagEl, c);
      } else if (tagEl) {
        tagEl.remove();
      }
    }
    el.classList.toggle('clickable', !!c.clickable);
    el.classList.toggle('stale', !!c.stale);
    el.classList.toggle('card-wide', !!c.wide);   // v2.20: full-row card (nodes)
    // v2.22 layout `span`: 2 = two columns (whole row when there is only one), full = row.
    // v2.23 `stretch`: the packer may widen this card to close a gap at the end of its row.
    el.classList.toggle('span-2', String(c.span) === '2');
    el.classList.toggle('span-full', c.span === 'full');
    el.dataset.span = c.span != null ? String(c.span) : (c.wide ? 'full' : '1');
    el.dataset.stretch = c.stretch ? '1' : '0';
    if (c.kind && el.dataset.kind !== c.kind) el.dataset.kind = c.kind;   // CSS hooks per card type
    // B23: dispatch by card type. Every clickable card used to open the token modal,
    // which was fine while the token card was the only one; a machine card needs its
    // own. `onclick` (not addEventListener) so a re-render replaces the handler
    // instead of stacking a new one on the persisted shell.
    el.onclick = c.clickable ? (e) => openCardModal(c, e) : null;
  }
  container.querySelectorAll('.card').forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });
}

// v2.32 the tag's short forms (fit.js swaps them in when the header is too narrow)
function syncTagShort(tagEl, c) {
  if (!tagEl) return;
  for (const [k, v] of [['short', c.tagShort], ['short2', c.tagShort2]]) {
    if (v) { if (tagEl.dataset[k] !== v) tagEl.dataset[k] = v; } else if (k in tagEl.dataset) delete tagEl.dataset[k];
  }
}

// B23: which modal a card opens. `kind` comes from the renderer via card(), so the
// routing lives with the card definition rather than being re-derived from the layout.
function openCardModal(c, e) {
  // A stack is several targets in one frame: open the one that was clicked. A click on
  // the divider between children lands on no child and does nothing.
  if (c.kind === 'stack') {
    const id = e?.target?.closest?.('.stack-item')?.dataset.target;
    if (id) openMachineModal(id, c.detail?.ranges);
    return;
  }
  // v2.20 nodes card: the clicked column is the node; a click between columns does nothing.
  if (c.kind === 'nodes') {
    const idx = Number(e?.target?.closest?.('.node-col')?.dataset.col);
    const col = c.detail?.gc?.nodes?.[idx];
    if (col) openNodeModal({ col, usageTarget: c.detail.gc.target, liveTarget: c.detail.gc.live || null, ranges: c.detail.ranges });
    return;
  }
  // v2.32 ComfyUI nodes card: likewise, the clicked column
  if (c.kind === 'comfy') {
    const idx = Number(e?.target?.closest?.('.node-col')?.dataset.col);
    const col = c.detail?.gc?.nodes?.[idx];
    if (col) openComfyModal({ col, target: c.detail.gc.target, ranges: c.detail.ranges });
    return;
  }
  // The machine modal titles itself from config (target name + " Detail") so a language
  // change can re-derive it without app.js having to remember which card was clicked.
  if (c.kind === 'machine') openMachineModal(c.key);
  // A table card only becomes clickable when it has rows the front could not fit, and it
  // carries them on the card object — so this modal opens from data already in hand
  // rather than a second fetch.
  else if (c.kind === 'table') openTableModal(c);
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
    // Keep the .rings box itself (moving it would restart the comets) and swap in the new
    // markup around it, one level at a time up to the card body -- v2.23 machine cards
    // nest the rings in a .mach wrapper, and whatever sits before them (the missing-GPU
    // warning) has to update too, not only what follows.
    const oldBox = body.querySelector('.rings');
    const newBox = tmp.querySelector('.rings');
    const depth = (el, root) => { let d = 0; for (let x = el; x && x !== root; x = x.parentNode) d += 1; return d; };
    if (oldBox && newBox && body.contains(oldBox) && depth(oldBox, body) === depth(newBox, tmp)) {
      let o = oldBox, nw = newBox;
      while (o !== body) {
        const op = o.parentNode, np = nw.parentNode;
        while (o.nextSibling) op.removeChild(o.nextSibling);
        while (nw.nextSibling) op.appendChild(nw.nextSibling);
        while (o.previousSibling) op.removeChild(o.previousSibling);
        while (np.firstChild !== nw) op.insertBefore(np.firstChild, o);
        if (op !== body && op.className !== np.className) op.className = np.className;
        o = op; nw = np;
      }
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
// Target display text resolved once, here, rather than in each renderer: name and badge
// reach five callers (chips, machine, service, token, stack) and one of them would end up
// on the base value while the others took `name_en`.
function targetById(id) {
  const t = (CONFIG.targets || []).find((x) => x.id === id) || { id };
  return { ...t, name: cv(t, 'name'), badge: cv(t, 'badge') };
}

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

// ── v2.23 grid packing: explicit rows, never a hole ───────────────────────
// v2.27 fit-text (fit.js) for the cards whose body, header tag or width changed since they were
// last fitted. Runs after packGrid, so the widths are final.
function fitBoard() {
  fitCards([...document.querySelectorAll('#grid > .card')]);
}

// CSS decides HOW MANY columns (v2.33: 1/2/4 by screen width, see :root in tokens.css); this
// decides WHERE each card goes. Rows are filled in config order by span. A row that ends
// short is closed by (1) widening the row's `stretch` cards in proportion to their span,
// or, when it has none, (2) pulling up later cards that fit, and only then (3) widening
// its last card -- so no column count leaves an empty cell, and no filler card is ever
// inserted. Full-width cards (nodes; Dual Compare lives outside the grid) take a row alone.
// v2.30: a full-width card is a section break -- (2) never pulls a card up across one, so
// what the config puts after the nodes card (Token Usage, Per-Project) stays after it at
// every column count; the machine row before it closes by widening its own cards.
// Placement is written as explicit grid-row / grid-column, so CSS `span` classes are just
// the no-JS fallback.
// v2.33: the column count is 1, 2 or 4 (tokens.css :root) and machine cards carry no
// `stretch`: eight of them fill whole rows at every count, so nothing here widens a machine
// card any more; the rules above still close a short row on a board with another card count.
export function packLayout(cards, cols) {
  const pending = cards.map((c) => ({ ...c, w: c.full ? cols : Math.min(c.span || 1, cols) }));
  const rows = [];
  const widen = (list, free) => {
    const total = list.reduce((a, r) => a + r.w, 0);
    let given = 0;
    const shares = list.map((r) => { const x = (free * r.w) / total; const f = Math.floor(x); given += f; return { r, f, rem: x - f }; });
    let left = free - given;
    shares.sort((a, b) => b.rem - a.rem).forEach((sh) => { if (left > 0) { sh.f += 1; left -= 1; } });
    shares.forEach((sh) => { sh.r.w += sh.f; });
  };
  while (pending.length) {
    const row = [];
    let used = 0;
    while (pending.length && used + pending[0].w <= cols) { const it = pending.shift(); row.push(it); used += it.w; }
    let free = cols - used;
    if (free > 0) {
      let st = row.filter((r) => r.stretch);
      if (!st.length) {
        for (let i = 0; i < pending.length && free > 0;) {
          const it = pending[i];
          if (it.full) break;                 // (never across a section break)
          if (it.w <= free) { row.push(it); free -= it.w; pending.splice(i, 1); } else i += 1;
        }
        st = row.filter((r) => r.stretch);
      }
      if (free > 0) {
        if (st.length) widen(st, free);
        else { row[row.length - 1].w += free; row[row.length - 1].fallback = true; }
      }
    }
    rows.push(row);
  }
  return rows;
}

function packGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const cols = parseInt(getComputedStyle(grid).getPropertyValue('--cols'), 10) || 1;
  const els = [...grid.children].filter((el) => el.classList.contains('card'));
  const rows = packLayout(els.map((el) => ({
    el, full: el.dataset.span === 'full', span: parseInt(el.dataset.span, 10) || 1, stretch: el.dataset.stretch === '1',
  })), cols);
  rows.forEach((row, ri) => {
    let col = 1;
    for (const it of row) {
      const r = String(ri + 1), c = `${col} / span ${it.w}`;
      if (it.el.style.gridRow !== r) it.el.style.gridRow = r;
      if (it.el.style.gridColumn !== c) it.el.style.gridColumn = c;
      it.el.dataset.w = String(it.w);
      it.el.classList.toggle('packed-fallback', !!it.fallback);
      col += it.w;
    }
  });
}

// (v2.27: alignKvRows is gone. Every cell is the standard fixed height, so cells in a row of
// cards line up by construction; nothing is stretched to match a taller neighbour.)

let packRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(packRaf);
  packRaf = requestAnimationFrame(() => { packGrid(); fitBoard(); fitLines(); });
});

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
    const before = cards.length;
    const raw = targetById(gc.target);
    const snap = lastSnap[gc.target];
    const target = { ...raw, color: autoColor(raw, snap, gc.type) }; // B14: resolve auto/omitted color
    if (gc.type === 'machine') cards.push(renderMachine(gc, target, snap, metrics));
    else if (gc.type === 'token') cards.push(renderToken(gc, target, snap, currentLive()));
    else if (gc.type === 'service') cards.push(renderService(gc, target, snap, metrics));
    else if (gc.type === 'stack') cards.push(renderStack(gc, (id) => {
      const t = targetById(id); const s = lastSnap[id];
      return { target: { ...t, color: autoColor(t, s, 'service') }, snap: s };
    }, metrics));
    else if (gc.type === 'info') cards.push(renderInfo(gc, target, snap));
    else if (gc.type === 'table') cards.push(renderTable(gc, target, snap));
    else if (gc.type === 'nodes') cards.push(renderNodes(gc, resolveWithLive));
    else if (gc.type === 'comfy') cards.push(renderComfy(gc, resolveWithLive));
    if (cards.length > before) {
      if (gc.span != null) cards[cards.length - 1].span = gc.span;
      if (gc.stretch) cards[cards.length - 1].stretch = true;
    }
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
    packGrid();
    fitBoard();
  }

  // The banner reads the same config payload everything else does, so it appears and
  // disappears on the same tick the board does.
  applyDemoBar(CONFIG, isAuthed());

  $('#rawjson').textContent = JSON.stringify(lastSnap, null, 2);
}

// ── v2.25 live inference state ───────────────────────────────────────
// Pushed by the hub every ~2 s (Server-Sent Events, /api/live/stream), with /api/live
// polled as a fallback while no push has arrived for 6 s. Each update re-renders ONLY the
// nodes card body and the Token Usage header -- not the page. The newest of the pushed
// state and the one in the regular snapshot wins (a slow snapshot reply must not roll the
// card back).
let liveView = null;
let liveLastMsg = 0;
let liveTimer = null;
let liveES = null;
function liveTargetId() { return (CONFIG?.layout?.grid || []).find((c) => c.type === 'nodes' && c.live)?.live || null; }
function currentLive() {
  const id = liveTargetId();
  if (!id) return null;
  const a = lastSnap[id]?.extra?.live || null;
  if (!a) return liveView;
  if (!liveView) return a;
  return (liveView.at || 0) >= (a.at || 0) ? liveView : a;
}
function resolveWithLive(id) {
  if (id && id === liveTargetId()) return { target: targetById(id), snap: { online: true, extra: { live: currentLive() } } };
  return { target: targetById(id), snap: lastSnap[id] };
}
function renderLive() {
  if (!CONFIG) return;
  for (const gc of CONFIG.layout?.grid || []) {
    let c = null;
    if (gc.type === 'nodes') c = renderNodes(gc, resolveWithLive);
    else if (gc.type === 'token') {
      const raw = targetById(gc.target);
      c = renderToken(gc, { ...raw, color: autoColor(raw, lastSnap[gc.target], 'token') }, lastSnap[gc.target], currentLive());
    }
    if (!c) continue;
    const el = [...document.querySelectorAll('#grid > .card')].find((x) => x.dataset.key === c.key);
    if (!el) continue;
    if (gc.type === 'nodes') {
      const body = el.querySelector('.card-body');
      if (body && el._body !== c.body) { body.innerHTML = c.body; el._body = c.body; }
    } else {
      const tagEl = el.querySelector('h2 .tag');
      if (tagEl && c.tag && tagEl.innerHTML !== c.tag) tagEl.innerHTML = c.tag;
    }
    fitCards([el]);
  }
}
// A stream is one long-lived HTTP connection, and over plain HTTP/1.1 (the board opened at
// http://<lan-ip>:3100) a browser allows only 6 per host across ALL its tabs -- a 7th tab
// would hang. So only a visible tab keeps the stream open: a hidden one closes it (and does
// not poll either) and reopens it the moment it is shown. (Through the HTTPS proxy the
// browser speaks HTTP/2 and the limit does not apply.)
const onLiveView = (v) => { if (v && typeof v === 'object' && v.nodes) { liveView = v; renderLive(); } };
function openLiveStream() {
  if (liveES || !window.EventSource || document.hidden) return;
  try {
    liveES = new EventSource('/api/live/stream');
    liveES.onmessage = (e) => { liveLastMsg = Date.now(); try { onLiveView(JSON.parse(e.data)); } catch { /* ignore */ } };
  } catch { liveES = null; }
}
function closeLiveStream() { if (liveES) { liveES.close(); liveES = null; } }
function startLive() {
  if (liveTimer) return;
  openLiveStream();
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeLiveStream(); else { liveLastMsg = 0; openLiveStream(); } });
  liveTimer = setInterval(async () => {
    if (document.hidden || !liveTargetId() || Date.now() - liveLastMsg < 6000) return;
    try {
      const r = await fetchT('/api/live', { cache: 'no-store' }, 3000);
      if (r.ok) onLiveView(await r.json());
    } catch { /* next tick */ }
  }, 2000);
}

// externalized UI label with a generic (non-project) bottom-line fallback (§12-step2).
// `layout.text_en` overlays `layout.text` key by key in English mode; a key present in
// neither falls through to the built-in string, which is already English.
function txt(key, fallback) {
  const v = cmap(CONFIG?.layout, 'text')[key];
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
let connState = null;   // remembered so a language change can re-render the badge at once
function setConn(state) {
  const el = $('#conn'); if (!el) return;
  connState = state;
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
  applySubtitle(cv(theme, 'subtitle'));
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

// Every piece of page chrome that comes from config. Split out of applyConfig so a
// language change can re-apply it WITHOUT re-running initHistory — that would reset the
// history range and pane selection back to the config defaults, throwing away the window
// the reader is in the middle of looking at.
function applyChrome() {
  const title = cv(CONFIG.header, 'title') || 'Dashboard';
  document.title = title;
  $('#title').textContent = title;
  // externalized chrome labels (config-driven, generic fallbacks)
  if (!$('#conn').textContent) $('#conn').textContent = txt('conn_connecting', 'Connecting…');
  $('#historyTitle').textContent = cv(CONFIG.layout?.history, 'title') || '';
  $('#rawTitle').textContent = txt('raw_title', 'Raw JSON');
  // Version footer. Written only when the server reported one — an older backend, or
  // one whose package.json could not be read, leaves the footer empty rather than
  // showing "v" or "undefined".
  $('#version').textContent = CONFIG.version ? `v${CONFIG.version}` : '';
  $('#tokenModalClose').textContent = txt('modal_close', 'Close');
  $('#machineModalClose').textContent = txt('modal_close', 'Close');
}

function applyConfig(first) {
  applyTheme(CONFIG.theme);
  applyChrome();
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
  setLine($('#tokenModalTitle'), cv(tokenCardCfg(), 'detail_title') || 'Detail');
  $('#tokenModal').classList.add('open');
  fitLine($('#tokenModalTitle'));
  $('#tokenModalRanges').innerHTML = TOKEN_RANGES.map((r) =>
    // v2.24: "24h" is the Beijing calendar day (usage source), so it says "today"
    `<button data-r="${r}" class="${r === tokenRange ? 'active' : ''}">${r === '24h' ? esc(t('tk_range_today')) : r}</button>`).join('');
  $('#tokenModalRanges').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tokenRange = b.dataset.r;
    [...$('#tokenModalRanges').children].forEach((x) => x.classList.toggle('active', x === b));
    loadTokenDetail();
  };
  loadTokenDetail();
}
function closeTokenModal() { $('#tokenModal').classList.remove('open'); }

/** Re-title and re-fetch in the language now selected. No-op while the modal is closed. */
function relocalizeTokenModal() {
  if (!$('#tokenModal').classList.contains('open')) return;
  setLine($('#tokenModalTitle'), cv(tokenCardCfg(), 'detail_title') || 'Detail');
  loadTokenDetail();
}

// v2.24: when each counter started being used (before that, LiteLLM only), per node and
// kind, plus the days that are LiteLLM's UTC-date buckets.
function tokenCoverageNote(j) {
  if (!Array.isArray(j.coverage)) return '';
  const p2 = (x) => String(x).padStart(2, '0');
  const at = (sec) => { const d = new Date((sec + 8 * 3600) * 1000); return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
  // net switches with tokens (same counters' start), so it is not listed separately
  const list = j.coverage.filter((c) => c.kind !== 'net').map((c) => `${c.node} ${t(`tk_kind_${c.kind}`)} ${at(c.since)}`).join(' · ');
  const lines = [];
  if (list) lines.push(t('tk_cov_detail', list));
  if (j.legacy_before) lines.push(t('tk_legacy', j.legacy_before.slice(5)));
  return lines.length ? `<div class="note">${lines.map(esc).join('<br>')}</div>` : '';
}

async function loadTokenDetail() {
  const tbl = $('#tokenModalTable');
  try {
    const r = await fetchT(`/api/token_detail?range=${tokenRange}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.error) { tbl.innerHTML = `<div class="note">Detail unavailable: ${esc(j.error)}</div>`; drawTokenChart({ days: [], classes: [], matrix: {} }); return; }
    drawTokenChart(j.series || { days: [], classes: [], matrix: {} });
    const col = colmap(tokenCardCfg(), 'columns');
    const th = (k, fb) => `<span title="${esc(col[k]?.label || fb)}">${esc(col[k]?.label || fb)}</span>`;
    // The Net column appears only when the rows carried it (see token_detail.js) --
    // an older queries/ file or the demo collector yields null, and a blank column
    // would read as "zero new tokens" rather than "not measured".
    const hasNet = (j.table || []).some((row) => row.net != null);
    // v2.23: figures right-aligned under right-aligned headers (.num), the model name left.
    // v2.27: fixed layout -- the header row sets the widths (tokens.css): figures by the
    // longest figure (Net carries its percentage, so it is wider), the model the rest.
    const netTh = hasNet ? `<th class="num w-pct">${th('net', 'Net')}</th>` : '';
    // v2.24 usage source: the LiteLLM share per class, a total row, and a note on where the
    // counters start (before that: LiteLLM only) and which days are UTC buckets.
    const hasLl = (j.table || []).some((row) => row.ll != null);
    const llTh = hasLl ? `<th class="num opt">${th('ll', 'via LiteLLM')}</th>` : '';
    // .opt columns step aside on a phone-width modal (tokens.css) so the rest fit unclipped.
    tbl.innerHTML = `<table class="tbl"><thead><tr><th>${th('model', 'Model')}</th><th class="num">${th('tokens', 'Tokens')}</th>${netTh}<th class="num">${th('requests', 'Requests')}</th>${llTh}<th class="num opt">${th('share', 'Share')}</th></tr></thead><tbody>${
      (j.table || []).map((row) => `<tr${row.total ? ' class="tot"' : ''}><td title="${esc(row.label)}"><span class="sw" style="background:${esc(row.color)}"></span>${esc(row.label)}</td><td class="num">${esc(row.tokens)}</td>${
        hasNet ? `<td class="num w-pct">${esc(row.net ?? '—')}${row.net_pct != null ? ` <span class="pct">${esc(row.net_pct)}%</span>` : ''}</td>` : ''
      }<td class="num">${esc(si3(Number(row.requests ?? 0)))}</td>${hasLl ? `<td class="num opt">${esc(row.ll ?? '—')}</td>` : ''}<td class="num opt">${esc(row.share)}%</td></tr>`).join('')
    }</tbody></table>${tokenCoverageNote(j)}`;
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

// ── language switch ──
// Everything the switch has to touch, in one place. Two things it deliberately does NOT
// do: re-run initHistory (that resets the range and pane selection, throwing away the
// window being looked at — relocalizeHistory re-labels the pickers instead), and rewrite
// a panel's last OUTCOME line ("Wrong password."), which stays in the language it was
// reported in rather than being silently restated under the reader.
function paintLangSwitch() {
  const box = $('#langSw');
  if (!box) return;
  box.querySelectorAll('.langBtn').forEach((b) => b.classList.toggle('active', b.dataset.lang === getLang()));
}

function relocalizeAll() {
  paintLangSwitch();
  applyStaticText();
  if (CONFIG) {
    applyChrome();
    if (connState) setConn(connState);   // the badge is written per tick; don't wait for one
    relocalizeHistory(CONFIG);
    render();
  }
  relocalizeSession();
  relocalizeAddPanel();
  relocalizeCredPanel();
  relocalizeClientsPanel();
  relocalizeTableModal();
  relocalizeMachineModal();
  relocalizeTokenModal();
}

// Applied before the first paint so an EN reader never sees the zh markup flash. In zh
// this writes back exactly what the document already contains.
applyDocumentLang();
applyStaticText();
paintLangSwitch();
$('#langSw').onclick = (e) => {
  const b = e.target.closest('.langBtn');
  if (b) setLang(b.dataset.lang);
};
onLangChange(relocalizeAll);

// ── boot ──
$('#tokenModalClose').onclick = closeTokenModal;
$('#tokenModal').onclick = (e) => { if (e.target.id === 'tokenModal') closeTokenModal(); };
bindMachineModal();
bindTableModal();
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
// Minting or revoking a client key changes what the Per-Project card can put a name to,
// so it refreshes through the same path. The card resolves names server-side on its own
// 5m poll, so a brand-new key shows as a hash until that lands — the panel is the
// authoritative view in the meantime, which is where the operator already is.
bindClients({
  onChanged: async () => { await configTick(false); await snapTick(); },
});
// admin-auth: logging in or out changes what this tab may see AND what it may show, so
// both directions refresh the board through the same two ticks everything else uses.
// Logging out also closes any admin panel left open behind the modal.
bindSession({
  onChange: async () => {
    closeAddPanel();
    closeCredPanel();
    closeClientsPanel();
    closeTableModal();
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
  startLive();
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
