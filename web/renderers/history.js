// history renderer (§6) — dual-pane compare, self-drawn canvas line chart.
// Driven by layout.history (ranges / selectable_targets / default). Each pane
// fetches /api/history?target=&range and plots whichever known metrics exist.
import { esc } from './common.js';
import { drawMulti } from './chart.js';

// Series are declared by metric id + chart placement only (color = line color,
// axis = left 0..100 / right auto-scale). The display label and unit suffix come
// from metrics.yaml (config) — §12-step5, so renaming a metric label there
// updates the legend automatically. No display labels are hardcoded here.
const SUBS = [
  // B9: aligned to v1 history — exactly GPU% / VRAM% / Temp / Power (no cpu/mem_pct).
  { k: 'gpu',       color: '#6aa9ff', axis: 'L' },
  // B23: was 'vram_pct', a key that only exists in config.example — the live config
  // maps VRAM as the {v,max} composite `vram_bytes`, whose normalised value is the
  // used/total ratio. The pane has therefore never drawn this line.
  { k: 'vram_bytes', color: '#5eead4', axis: 'L' },
  { k: 'gpu_temp',  color: '#f7c948', axis: 'R' },
  { k: 'gpu_power', color: '#ff7b7b', axis: 'R' },
];

let CFG = null;
let curRange = '6h';
let panes = []; // B10: [{ idx, target }] — N panes (was fixed L/R)
let names = {};
let METRICS = {};                       // metric templates from /api/config (§12-step5)
// B17: a failed/aborted load used to fall through to an empty chart, which is
// indistinguishable from "no data". Show the reason on the pane instead, and let a
// click retry just that pane.
function paneError(idx, msg) {
  const err = document.querySelector(`.histErr[data-pane="${idx}"]`);
  if (!err) return;
  err.innerHTML = `<span class="histErrMsg">${esc(msg)}</span><button type="button">重试</button>`;
  err.hidden = false;
}

function paneErrorClear(idx) {
  const err = document.querySelector(`.histErr[data-pane="${idx}"]`);
  if (err) { err.hidden = true; err.innerHTML = ''; }
}

// B18: one in-flight request per pane. /api/history is served by synchronous
// better-sqlite3 queries, so concurrent requests do not overlap — they serialize on
// the event loop at ~0.3s each. Left unbounded, a periodic refresh landing on top of
// an unfinished one snowballs until every request blows the 5s budget. Automatic
// reloads are dropped while a pane is busy; user-initiated ones pass force and
// supersede the request in flight (a range/target switch makes it stale anyway).
const inflight = new Map();   // pane idx -> AbortController

async function loadPane(idx, { force = false } = {}) {
  const p = panes[idx];
  const canvas = document.querySelector(`.histCanvas[data-pane="${idx}"]`);
  const legend = document.querySelector(`.legend[data-pane="${idx}"]`);
  if (!canvas || !p?.target) return;
  const running = inflight.get(idx);
  if (running) {
    if (!force) return;
    running.abort();
  }
  // B15: AbortController timeout so a stalled fetch can't wedge the pane.
  const ctrl = new AbortController();
  inflight.set(idx, ctrl);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 10000);
  try {
    const r = await fetch(`/api/history?target=${encodeURIComponent(p.target)}&range=${curRange}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (inflight.get(idx) !== ctrl) return;   // superseded: newer request owns the pane
    // B19: clear the overlay only once the chart is actually on screen. Clearing first
    // meant a throw inside drawMulti left the pane showing a complete-looking chart
    // under a "load failed" overlay, and reported a render bug as a network one.
    try {
      drawMulti(canvas, j.series || {}, legend, { subs: SUBS, metrics: METRICS, height: 240 });
    } catch (e) {
      paneError(idx, `渲染失败：${e?.message || e}`);
      return;
    }
    paneErrorClear(idx);
  } catch (e) {
    if (inflight.get(idx) !== ctrl) return;   // aborted by a newer request, not a failure
    // Keep whatever is already drawn — a stale chart plus a visible notice beats
    // silently wiping the pane to blank.
    paneError(idx, timedOut
      ? `加载超时（${curRange}）`
      : `加载失败：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    if (inflight.get(idx) === ctrl) inflight.delete(idx);
  }
}

function loadAll(opts) { panes.forEach((p) => loadPane(p.idx, opts)); }

// B15: called by app.js on foreground-restore to refresh panes immediately.
export function historyRefresh() { loadAll(); }

export function initHistory(config) {
  CFG = config.layout?.history;
  const section = document.getElementById('history');
  if (!CFG) { if (section) section.hidden = true; return; }
  section.hidden = false;

  names = Object.fromEntries((config.targets || []).map((t) => [t.id, t.name || t.id]));
  METRICS = config.metrics || {};       // §12-step5: legend labels/units from config
  const selectable = (CFG.selectable_targets || []).filter((id) => names[id]);
  curRange = CFG.default_range || (CFG.ranges || ['6h'])[0];
  // B10: N panes from `panes: [...]`, backward-compatible with `default: [a,b]`.
  const wanted = (Array.isArray(CFG.panes) && CFG.panes.length ? CFG.panes : (CFG.default || [])).filter((id) => names[id]);
  const paneIds = wanted.length ? wanted : selectable.slice(0, 2);
  panes = paneIds.map((t, i) => ({ idx: i, target: t }));

  // build pane DOM (N panes)
  const split = document.getElementById('histSplit');
  if (split) {
    split.innerHTML = panes.map((p) => `
      <div class="hist-pane">
        <select class="hostSel" data-pane="${p.idx}"></select>
        <div class="histWrap">
          <canvas class="histCanvas" data-pane="${p.idx}" height="240"></canvas>
          <div class="histErr" data-pane="${p.idx}" hidden></div>
        </div>
        <div class="legend" data-pane="${p.idx}"></div>
      </div>`).join('');

    // one delegated handler: any 重试 button reloads just its own pane. Stashed the
    // same way as the resize listener so a re-init swaps it instead of stacking.
    if (initHistory._onRetry) split.removeEventListener('click', initHistory._onRetry);
    initHistory._onRetry = (e) => {
      const btn = e.target.closest('.histErr button');
      if (!btn) return;
      const idx = Number(btn.parentElement.dataset.pane);
      if (Number.isInteger(idx)) { paneErrorClear(idx); loadPane(idx, { force: true }); }
    };
    split.addEventListener('click', initHistory._onRetry);
  }

  // range buttons
  const rb = document.getElementById('rangeBtns');
  rb.innerHTML = (CFG.ranges || ['1h', '6h', '24h']).map((r) =>
    `<button data-r="${esc(r)}" class="${r === curRange ? 'active' : ''}">${esc(r)}</button>`).join('');
  rb.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    curRange = b.dataset.r;
    [...rb.children].forEach((x) => x.classList.toggle('active', x === b));
    loadAll({ force: true });   // the in-flight responses are for the old range
  };

  // host selects
  document.querySelectorAll('.hostSel').forEach((sel) => {
    const idx = Number(sel.dataset.pane);
    sel.innerHTML = selectable.map((id) => `<option value="${esc(id)}">${esc(names[id])}</option>`).join('');
    if (panes[idx]?.target) sel.value = panes[idx].target;
    sel.onchange = () => { if (panes[idx]) { panes[idx].target = sel.value; loadPane(idx, { force: true }); } };
  });

  // B18: a window drag fires resize dozens of times, and each one used to kick off
  // one request per pane. Coalesce into a single reload once the drag settles.
  // Listener + timer are stashed on initHistory so a re-init replaces them instead
  // of stacking another copy.
  if (initHistory._onResize) window.removeEventListener('resize', initHistory._onResize);
  clearTimeout(initHistory._resizeT);
  initHistory._onResize = () => {
    clearTimeout(initHistory._resizeT);
    initHistory._resizeT = setTimeout(() => loadAll(), 250);
  };
  window.addEventListener('resize', initHistory._onResize);

  loadAll();
  clearInterval(initHistory._t);
  initHistory._t = setInterval(() => loadAll(), 10000);
}
