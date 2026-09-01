// Multi-series timeseries chart (§6) — extracted from history.js so the machine
// detail modal draws with exactly the same code as History · Dual Compare rather
// than a second, drifting copy. Series definition, metric templates and height are
// parameters now; everything else is the original renderer.
import { esc } from './common.js';

export const subUnit = (metrics, k) => metrics?.[k]?.unit || '';
// B23: the left axis IS the 0..100 scale, so anything drawn against it is a percentage
// regardless of what unit its template carries for the card face. mem_bytes is labelled
// "G" so the card can read "5.0/15.6G", but the value that reaches the timeseries is
// the used/total ratio -- the legend was reporting "Memory G 33G" for 33%.
const unitOf = (metrics, sub) => (sub.axis === 'L' ? '%' : subUnit(metrics, sub.k));
export const subLabel = (metrics, k) =>
  `${metrics?.[k]?.label || k}${subUnit(metrics, k) ? ' ' + subUnit(metrics, k) : ''}`;
const labelOf = (metrics, sub) => {
  const u = unitOf(metrics, sub);
  return `${metrics?.[sub.k]?.label || sub.k}${u ? ' ' + u : ''}`;
};

// B24: on-chart series labels. The unit IS the axis cue -- the left axis is always the
// fixed 0..100 percent scale and only the right axis carries °C/W/counts -- so the
// suffix is worth its width exactly when both axes are in play. On a percentage-only
// chart (the gateway card: cpu/cache_hit/success) it would just repeat "%" three times.
const tagOf = (metrics, sub, hasRight) =>
  hasRight ? labelOf(metrics, sub) : (metrics?.[sub.k]?.label || sub.k);

// Ellipsise to fit `max` px under whatever font the caller has set on ctx.
const fitText = (ctx, s, max) => {
  if (ctx.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
};

const LBL_FONT = '600 11px system-ui, sans-serif';
const LBL_LH = 13;          // minimum vertical distance between two stacked labels

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Record<string,{ts:number,value:number}[]>} series  from /api/history
 * @param {HTMLElement|null} legendEl
 * @param {{subs:{k:string,color:string,axis:'L'|'R'}[], metrics:object, height?:number,
 *          emptyText?:string}} opts
 */
export function drawMulti(canvas, series, legendEl, opts) {
  const { subs, metrics, height = 240, emptyText = 'No data yet (collecting samples…)' } = opts;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 360, cssH = height;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const present = subs.filter((s) => (series[s.k] || []).length >= 2);
  // Right axis is only meaningful when something is plotted against it. Drawing its
  // ticks regardless left a bare 0…1.1 scale on cards whose metrics are all
  // percentages (the gateway card is exactly this), which reads as a broken axis.
  const hasRight = present.some((s) => s.axis === 'R');
  // B24: series names live in a gutter to the RIGHT of the axis, never inside the plot.
  // That is what makes them collision-proof by construction rather than by tuning: a
  // spike cannot cross a label, a label cannot hide a sample, and because the gutter is
  // bare card background the text needs no halo or backdrop to stay readable. Width is
  // measured every draw (labels come from metrics.yaml and can be renamed) and capped at
  // 28% of the canvas so the 340px Dual Compare pane keeps a usable plot; longer names
  // are ellipsised rather than allowed to eat the chart.
  ctx.font = LBL_FONT;
  const tagCap = Math.max(24, cssW * 0.28 - 12);
  const tags = present.map((sub) => fitText(ctx, tagOf(metrics, sub, hasRight), tagCap));
  const gutterW = tags.length ? Math.max(...tags.map((t) => ctx.measureText(t).width)) + 12 : 0;
  const padL = 38, padR = (hasRight ? 34 : 16) + gutterW, padT = 12, padB = 22;
  const W = cssW - padL - padR, H = cssH - padT - padB;

  let allTs = [];
  for (const s of present) (series[s.k] || []).forEach((p) => allTs.push(p.ts));
  if (!allTs.length) {
    ctx.fillStyle = 'rgba(248,250,252,0.4)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(emptyText, cssW / 2, cssH / 2);
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
    if (hasRight) {
      ctx.fillStyle = 'rgba(248,250,252,0.35)'; ctx.textAlign = 'left';
      ctx.fillText((rMax - (rMax - rMin) * i / 4).toFixed(0), cssW - padR + 5, y + 3);
    }
  }
  ctx.fillStyle = 'rgba(248,250,252,0.4)'; ctx.textAlign = 'center';
  // Span longer than a day needs the date to be readable at all; below that the
  // clock alone is less cluttered. 24h/7d/30d in the detail modal hit both cases.
  const spanSec = xMax - xMin;
  const fmtT = (t) => {
    const d = new Date(t * 1000);
    const hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    if (spanSec <= 36 * 3600) return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  };
  for (let i = 0; i <= 3; i++) { const t = xMin + (xMax - xMin) * i / 3; ctx.fillText(fmtT(t), xPos(t), cssH - 6); }

  for (const sub of present) {
    const pts = series[sub.k] || [];
    const yf = sub.axis === 'L' ? yL : yR;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = xPos(p.ts), y = yf(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = sub.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // B24 label placement. Each name anchors at its own line's last sample, then two
  // deterministic sweeps (push down, then push back up off the floor) open at least
  // LBL_LH between neighbours and clamp everything inside the plot band -- same data in,
  // same layout out, so a redraw of the same window never makes the labels jump.
  if (present.length) {
    const plotRight = cssW - padR, labelX = cssW - gutterW + 8;
    const top = padT + 6, bot = padT + H - 2;
    const items = present.map((sub, i) => {
      const pts = series[sub.k];
      const last = pts[pts.length - 1];
      const y = (sub.axis === 'L' ? yL : yR)(last.value);
      const x = xPos(last.ts);
      // A series that stopped reporting mid-window ends short of the axis (m110 offline
      // for days). Say so with a dashed pull instead of implying the line runs to "now".
      return { sub, text: tags[i], x, y0: y, y, stale: x < plotRight - 6 };
    });
    items.sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const it of items) { it.y = Math.max(it.y, prev + LBL_LH, top); prev = it.y; }
    let next = Infinity;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.y = Math.max(top, Math.min(it.y, next - LBL_LH, bot));
      next = it.y;
    }
    ctx.textBaseline = 'middle';
    for (const it of items) {
      ctx.fillStyle = it.sub.color;
      ctx.beginPath(); ctx.arc(it.x, it.y0, 2.5, 0, Math.PI * 2); ctx.fill();
      if (it.stale || Math.abs(it.y - it.y0) > 2) {
        ctx.save();
        ctx.strokeStyle = it.sub.color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
        ctx.setLineDash(it.stale ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(it.x + 3, it.y0); ctx.lineTo(it.x + 7, it.y0);
        ctx.lineTo(labelX - 8, it.y); ctx.lineTo(labelX - 4, it.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.font = LBL_FONT; ctx.textAlign = 'left';
      ctx.fillText(it.text, labelX, it.y);
    }
  }

  if (legendEl) {
    legendEl.innerHTML = present.map((sub) => {
      const pts = series[sub.k] || [];
      const cur = pts.length ? pts[pts.length - 1].value : null;
      const val = cur == null ? '—' : Math.round(cur) + unitOf(metrics, sub);
      return `<span class="lg"><span class="sw" style="background:${sub.color}"></span>${esc(labelOf(metrics, sub))} <b style="color:var(--text)">${val}</b></span>`;
    }).join('');
  }
}
