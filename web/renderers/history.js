// history renderer (§6) — dual-pane compare, self-drawn canvas line chart.
// Driven by layout.history (ranges / selectable_targets / default). Each pane
// fetches /api/history?target=&range and plots whichever known metrics exist.
import { esc } from './common.js';

// Series are declared by metric id + chart placement only (color = line color,
// axis = left 0..100 / right auto-scale). The display label and unit suffix come
// from metrics.yaml (config) — §12-step5, so renaming a metric label there
// updates the legend automatically. No display labels are hardcoded here.
const SUBS = [
  // B9: aligned to v1 history — exactly GPU% / VRAM% / Temp / Power (no cpu/mem_pct).
  { k: 'gpu',       color: '#6aa9ff', axis: 'L' },
  { k: 'vram_pct',  color: '#5eead4', axis: 'L' },
  { k: 'gpu_temp',  color: '#f7c948', axis: 'R' },
  { k: 'gpu_power', color: '#ff7b7b', axis: 'R' },
];

let CFG = null;
let curRange = '6h';
const paneTarget = { L: null, R: null };
let names = {};
let METRICS = {};                       // metric templates from /api/config (§12-step5)
const subUnit = (k) => METRICS[k]?.unit || '';
const subLabel = (k) => `${METRICS[k]?.label || k}${subUnit(k) ? ' ' + subUnit(k) : ''}`;

function drawMulti(canvas, series, legendEl) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 360, cssH = 240;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const padL = 38, padR = 40, padT = 12, padB = 22;
  const W = cssW - padL - padR, H = cssH - padT - padB;

  const present = SUBS.filter((s) => (series[s.k] || []).length >= 2);
  let allTs = [];
  for (const s of present) (series[s.k] || []).forEach((p) => allTs.push(p.ts));
  if (!allTs.length) {
    ctx.fillStyle = 'rgba(248,250,252,0.4)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No data yet (collecting samples…)', cssW / 2, cssH / 2);
    if (legendEl) legendEl.innerHTML = '';
    return;
  }
  const xMin = Math.min(...allTs), xMax = Math.max(...allTs);
  const rightVals = [];
  present.filter((s) => s.axis === 'R').forEach((s) => (series[s.k] || []).forEach((p) => rightVals.push(p.value)));
  let rMin = rightVals.length ? Math.min(...rightVals) : 0;
  let rMax = rightVals.length ? Math.max(...rightVals) : 1;
  const rpad = (rMax - rMin) * 0.1 || 1; rMin = Math.max(0, rMin - rpad); rMax = rMax + rpad;

  const xPos = (t) => padL + ((t - xMin) / (xMax - xMin || 1)) * W;
  const yL = (v) => padT + (1 - v / 100) * H;
  const yR = (v) => padT + (1 - (v - rMin) / (rMax - rMin || 1)) * H;

  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.font = '10px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H * i / 4);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(106,169,255,0.6)'; ctx.textAlign = 'right';
    ctx.fillText(String(100 - i * 25), padL - 5, y + 3);
    ctx.fillStyle = 'rgba(247,201,72,0.6)'; ctx.textAlign = 'left';
    ctx.fillText((rMax - (rMax - rMin) * i / 4).toFixed(0), cssW - padR + 5, y + 3);
  }
  ctx.fillStyle = 'rgba(248,250,252,0.4)'; ctx.textAlign = 'center';
  const fmtT = (t) => { const d = new Date(t * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
  for (let i = 0; i <= 3; i++) { const t = xMin + (xMax - xMin) * i / 3; ctx.fillText(fmtT(t), xPos(t), cssH - 6); }

  for (const sub of present) {
    const pts = series[sub.k] || [];
    const yf = sub.axis === 'L' ? yL : yR;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = xPos(p.ts), y = yf(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = sub.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  }

  if (legendEl) {
    legendEl.innerHTML = present.map((sub) => {
      const pts = series[sub.k] || [];
      const cur = pts.length ? pts[pts.length - 1].value : null;
      const val = cur == null ? '—' : Math.round(cur) + subUnit(sub.k);
      return `<span class="lg"><span class="sw" style="background:${sub.color}"></span>${esc(subLabel(sub.k))} <b style="color:var(--text)">${val}</b></span>`;
    }).join('');
  }
}

async function loadPane(pane) {
  const target = paneTarget[pane];
  const canvas = document.querySelector(`.histCanvas[data-pane="${pane}"]`);
  const legend = document.querySelector(`.legend[data-pane="${pane}"]`);
  if (!canvas || !target) return;
  try {
    const r = await fetch(`/api/history?target=${encodeURIComponent(target)}&range=${curRange}`, { cache: 'no-store' });
    const j = await r.json();
    drawMulti(canvas, j.series || {}, legend);
  } catch { drawMulti(canvas, {}, legend); }
}

function loadAll() { loadPane('L'); loadPane('R'); }

export function initHistory(config) {
  CFG = config.layout?.history;
  const section = document.getElementById('history');
  if (!CFG) { if (section) section.hidden = true; return; }
  section.hidden = false;

  names = Object.fromEntries((config.targets || []).map((t) => [t.id, t.name || t.id]));
  METRICS = config.metrics || {};       // §12-step5: legend labels/units from config
  const selectable = (CFG.selectable_targets || []).filter((id) => names[id]);
  curRange = CFG.default_range || (CFG.ranges || ['6h'])[0];
  paneTarget.L = (CFG.default || [])[0] || selectable[0] || null;
  paneTarget.R = (CFG.default || [])[1] || selectable[1] || selectable[0] || null;

  // range buttons
  const rb = document.getElementById('rangeBtns');
  rb.innerHTML = (CFG.ranges || ['1h', '6h', '24h']).map((r) =>
    `<button data-r="${esc(r)}" class="${r === curRange ? 'active' : ''}">${esc(r)}</button>`).join('');
  rb.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    curRange = b.dataset.r;
    [...rb.children].forEach((x) => x.classList.toggle('active', x === b));
    loadAll();
  };

  // host selects
  document.querySelectorAll('.hostSel').forEach((sel) => {
    const pane = sel.dataset.pane;
    sel.innerHTML = selectable.map((id) => `<option value="${esc(id)}">${esc(names[id])}</option>`).join('');
    if (paneTarget[pane]) sel.value = paneTarget[pane];
    sel.onchange = () => { paneTarget[pane] = sel.value; loadPane(pane); };
  });

  window.addEventListener('resize', loadAll);
  loadAll();
  clearInterval(initHistory._t);
  initHistory._t = setInterval(loadAll, 10000);
}
