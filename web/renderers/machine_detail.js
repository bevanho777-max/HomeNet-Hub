// Machine detail modal (§6) — click a machine card, get that host's history as one
// multi-line chart. Same renderer and same /api/history data as History · Dual
// Compare; only the shell (Token Detail's modal) and the series selection differ.
import { esc, lvClass, setLine } from './common.js';
import { fitLines } from '../fit.js';
import { cv, t } from '../i18n.js';
import { drawMulti } from './chart.js';

const RANGES = ['24h', '7d', '30d'];

// Default lines per role. A card only ever plots the intersection of its role's list
// with what /api/history actually returned, so a host that reports no GPU (m27, the
// gateway) silently falls back rather than drawing four empty axes. `fallback` is
// what a target gets when its role list matches nothing it has.
//
// Axis assignment follows the value's nature, not the metric name: the left axis is
// the renderer's fixed 0..100 scale, so everything normalised to a percentage lives
// there — plain percentages (cpu/gpu), the {v,max} byte ratios (mem/disk/vram, which
// the collector stores as their used/total ratio), and the gateway's hit/success
// rates. Anything carrying its own unit — °C, W, request counts — auto-scales on the
// right. Colours and units come from metrics.yaml, so this table only names keys.
const ROLE_SERIES = {
  gpu: ['gpu', 'gpu_temp', 'gpu_power'],
  gateway: ['cpu', 'cache_hit', 'success'],
  nas: ['cpu', 'mem_bytes', 'disks_hdd_max'],
  host: ['cpu', 'mem_bytes', 'disk_bytes'],
  // llama.cpp speed cards. Drawn as two panels (see SPLIT_ROLES): prefill runs ~10x
  // decode, so one shared auto-scaled axis would flatten decode into the floor.
  speed: ['prefill_speed', 'decode_speed'],
};
const SPLIT_ROLES = new Set(['speed']);
const FALLBACK = ['cpu', 'mem_bytes', 'disk_bytes'];

// Axis + colour per metric, overridable from metrics.yaml (`axis:` / `color:`), which
// reaches the frontend verbatim through /api/config. These are the defaults for keys
// that do not set one.
const AXIS = {
  cpu: 'L', gpu: 'L', vram_pct: 'L', mem_pct: 'L', disk_pct: 'L',
  mem_bytes: 'L', vram_bytes: 'L', disk_bytes: 'L',
  vol1_bytes: 'L', vol2_bytes: 'L', nas_disk_bytes: 'L',
  cache_hit: 'L', success: 'L',
  gpu_temp: 'R', gpu_power: 'R', reqs_today: 'R', reqs_5m: 'R',
  disks_hdd_max: 'R', disks_ssd_max: 'R', latency: 'R',
};
const COLOR = {
  gpu: '#6aa9ff', cpu: '#6aa9ff', vram_bytes: '#5eead4', mem_bytes: '#5eead4',
  gpu_temp: '#f7c948', gpu_power: '#ff7b7b', disk_bytes: '#b18cff',
  cache_hit: '#5eead4', success: '#7ee787', reqs_today: '#f7c948', reqs_5m: '#ff7b7b',
  disks_hdd_max: '#f7c948', disks_ssd_max: '#ff7b7b',
  nas_disk_bytes: '#b18cff', vol1_bytes: '#b18cff', vol2_bytes: '#ff9d5c',
};
const PALETTE = ['#6aa9ff', '#5eead4', '#f7c948', '#ff7b7b', '#b18cff', '#ff9d5c'];

let CONFIG = null;
let range = '24h';
let targetId = null;
let inflight = null;      // AbortController for the request that owns the modal

const $ = (s) => document.querySelector(s);
const metrics = () => CONFIG?.metrics || {};

export function initMachineDetail(config) { CONFIG = config; }

// Role from the live snapshot, mirroring app.js's autoColor: GPU metrics present means
// a GPU box, litellm gateway metrics mean the gateway, NAS volumes mean the NAS.
function roleOf(snap, recorded = []) {
  // Live values first. An offline host reports nothing, so fall back to what it has
  // ever recorded -- otherwise m110 (down for days) would be typed as a plain host and
  // shown cpu/mem/disk instead of the GPU lines its history is actually full of.
  const has = (k) => typeof snap?.metrics?.[k]?.value === 'number' || recorded.includes(k);
  if (has('prefill_speed') || has('decode_speed')) return 'speed';
  if (has('gpu') || has('gpu_temp') || has('gpu_power')) return 'gpu';
  if (has('cache_hit') || has('success') || has('reqs_5m')) return 'gateway';
  if (has('nas_disk_bytes') || has('vol1_bytes')) return 'nas';
  return 'host';
}

function seriesFor(role, available) {
  const m = metrics();
  const pick = (list) => list.filter((k) => available.includes(k));
  let keys = pick(ROLE_SERIES[role] || []);
  if (!keys.length) keys = pick(FALLBACK);
  if (!keys.length) keys = available.slice(0, 4);   // last resort: whatever exists
  return keys.map((k, i) => ({
    k,
    color: m[k]?.color || COLOR[k] || PALETTE[i % PALETTE.length],
    axis: m[k]?.axis || AXIS[k] || 'R',
  }));
}

function showError(msg, retry) {
  const el = $('#machineModalErr');
  if (!el) return;
  el.innerHTML = `<span class="histErrMsg">${esc(msg)}</span>${retry ? `<button type="button">${esc(t('chart_retry'))}</button>` : ''}`;
  el.hidden = false;
}
function clearError() {
  const el = $('#machineModalErr');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

// Lines the role asked for that the host has never recorded. Saying so beats plotting
// three lines and leaving the reader to wonder where the fourth went — nas75's disk
// temperature is exactly this until the parts-max sampler starts writing it.
function noteMissing(role, recorded, available) {
  const m = metrics();
  const wanted = ROLE_SERIES[role] || [];
  const name = (k) => cv(m[k], 'label') || k;
  const never = wanted.filter((k) => !recorded.includes(k));
  const thin = wanted.filter((k) => recorded.includes(k) && !available.includes(k));
  const el = $('#machineModalNote');
  if (!el) return;
  const parts = [];
  const sep = t('list_sep');
  if (never.length) parts.push(t('chart_never_recorded', never.map(name).join(sep)));
  if (thin.length) parts.push(t('chart_none_in_range', thin.map(name).join(sep)));
  if (!parts.length) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = parts.join(t('chart_note_sep'));
  el.hidden = false;
}

// Second chart for split roles, created on first use under the main legend and hidden
// for every other card so machine charts are untouched.
function secondPanel(show) {
  let wrap = document.getElementById('machineModalPanel2');
  if (!wrap && show) {
    wrap = document.createElement('div');
    wrap.id = 'machineModalPanel2';
    wrap.style.marginTop = '16px';
    wrap.innerHTML = '<canvas id="machineModalCanvas2" height="220" style="width:100%;display:block"></canvas>'
      + '<div class="legend" id="machineModalLegend2" style="margin-top:12px"></div>';
    $('#machineModalLegend').after(wrap);
  }
  if (wrap) wrap.hidden = !show;
  return show ? { canvas: $('#machineModalCanvas2'), legend: $('#machineModalLegend2') } : null;
}

// ── v2.18 multi-GPU ──────────────────────────────────────────────────────
// A host with several cards gets per-card series from the hub (gpuN, gpuN_vram_bytes,
// gpuN_temp / _temp_junction / _temp_mem, gpuN_power -- see normalize.js). Their
// presence is the switch: single-card hosts never record them, so their modal is the
// one chart it always was. Multi-card hosts get four panels, one line per card, drawn
// by the same drawMulti as everything else; the per-card names are handed to it as
// metric templates, so chart.js (and with it History · Dual Compare) is untouched.
const CARD_COLORS = [
  ['#6aa9ff', '#b18cff', '#5eead4'],   // GPU0: edge / junction / mem
  ['#ff9d5c', '#ff7b7b', '#f7c948'],   // GPU1
];
const cardColor = (i, shade = 0) => CARD_COLORS[i]?.[shade] || PALETTE[(i * 3 + shade) % PALETTE.length];

function gpuCardIdx(snap, recorded) {
  const set = new Set();
  const scan = (k) => { const m = /^gpu(\d+)$/.exec(k); if (m) set.add(Number(m[1])); };
  recorded.forEach(scan);
  Object.keys(snap?.metrics || {}).forEach(scan);
  return [...set].sort((a, b) => a - b);
}

function gpuMetrics(idx) {
  const m = { ...metrics() };
  for (const i of idx) {
    m[`gpu${i}`] = { label: `GPU${i}`, unit: '%' };
    m[`gpu${i}_vram_bytes`] = { label: `GPU${i}`, unit: '%' };
    m[`gpu${i}_temp`] = { label: `GPU${i} edge`, unit: '°C' };
    m[`gpu${i}_temp_junction`] = { label: `GPU${i} junction`, unit: '°C' };
    m[`gpu${i}_temp_mem`] = { label: `GPU${i} mem`, unit: '°C' };
    m[`gpu${i}_power`] = { label: `GPU${i}`, unit: 'W' };
  }
  return m;
}

function gpuPanels(idx) {
  return [
    { title: 'gpu_panel_util', subs: idx.map((i) => ({ k: `gpu${i}`, color: cardColor(i), axis: 'L' })) },
    { title: 'gpu_panel_vram', subs: idx.map((i) => ({ k: `gpu${i}_vram_bytes`, color: cardColor(i), axis: 'L' })) },
    { title: 'gpu_panel_temp', subs: idx.flatMap((i) => [
      { k: `gpu${i}_temp`, color: cardColor(i, 0), axis: 'R' },
      { k: `gpu${i}_temp_junction`, color: cardColor(i, 1), axis: 'R' },
      { k: `gpu${i}_temp_mem`, color: cardColor(i, 2), axis: 'R' },
    ]) },
    { title: 'gpu_panel_power', subs: idx.map((i) => ({ k: `gpu${i}_power`, color: cardColor(i), axis: 'R' })) },
  ];
}

// Extra panels (2..4) for the multi-GPU view, created on first use under the main
// legend and hidden for every other card.
function extraGpuPanels(n) {
  let wrap = document.getElementById('machineModalGpuPanels');
  if (!wrap && n) {
    wrap = document.createElement('div');
    wrap.id = 'machineModalGpuPanels';
    ($('#machineModalPanel2') || $('#machineModalLegend')).after(wrap);
  }
  if (!wrap) return [];
  while (wrap.children.length < n) {
    const k = wrap.children.length;
    const p = document.createElement('div');
    p.innerHTML = `<div class="gpu-panel-title"></div>`
      + `<canvas data-gpu-panel="${k}" height="200" style="width:100%;display:block;margin-top:8px"></canvas>`
      + '<div class="legend" style="margin-top:10px"></div>';
    wrap.appendChild(p);
  }
  wrap.hidden = !n;
  // A modal that needs fewer panels than an earlier one built must not leave the surplus
  // ones showing that earlier chart (the node modal uses 2, a multi-GPU host 3).
  [...wrap.children].forEach((p, i) => { p.hidden = i >= n; });
  return [...wrap.children].slice(0, n).map((p) => ({
    title: p.querySelector('.gpu-panel-title'), canvas: p.querySelector('canvas'), legend: p.querySelector('.legend'),
  }));
}

// v2.27: a parts metric (one temperature per disk) may show only "max · min" on the card
// face when its line does not fit (fit.js); every part's current value is here, one column
// per part (the bay), each coloured by its own level. By Model (parts_layout: table) is
// not repeated -- its card cell already lists every model with traffic.
function showParts(id) {
  const el = $('#machineModalParts');
  if (!el) return;
  const snap = id ? window.__lastSnap?.[id] : null;
  const ms = metrics();
  const html = Object.entries(snap?.metrics || {})
    .filter(([k, m]) => Array.isArray(m?.parts) && m.parts.length && ms[k]?.parts_layout !== 'table')
    .map(([k, m]) => `<table class="tbl partsTbl"><thead><tr><th title="${esc(cv(ms[k], 'label') || k)}">${esc(cv(ms[k], 'label') || k)}</th>`
      + `${m.parts.map((p) => `<th class="num">${esc(p.label != null ? `#${p.label}` : '')}</th>`).join('')}</tr></thead>`
      + `<tbody><tr><td>${esc(t('part_now'))}</td>${m.parts.map((p) => `<td class="num ${lvClass(p.level)}">${esc(p.display)}</td>`).join('')}</tr></tbody></table>`)
    .join('');
  el.innerHTML = html;
  el.hidden = !html;
}

function mainTitle(text) {
  const el = $('#machineModalMainTitle');
  if (!el) return;
  setLine(el, text || '');
  el.hidden = !text;
}

// ── agent vs HEAD ────────────────────────────────────────────────────────
// Agents report their own sha256 in extra.agent; /api/agent_heads hashes the same file
// in the hub's checkout. Shown for push targets only -- pulled targets have no agent.
let heads = null, headsAt = 0;
async function agentHeads() {
  if (heads && Date.now() - headsAt < 60000) return heads;
  const r = await fetch('/api/agent_heads', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  heads = (await r.json()).files || {};
  headsAt = Date.now();
  return heads;
}

async function showAgent(id) {
  const el = $('#machineModalAgent');
  if (!el) return;
  el.hidden = true; el.className = 'note';
  const target = (CONFIG?.targets || []).find((x) => x.id === id);
  if (target?.type !== 'http_push') return;
  const rep = window.__lastSnap?.[id]?.extra?.agent;
  const short = (s) => String(s || '').slice(0, 12);
  let text, lv = '';
  if (!rep?.sha256) {
    text = t('agent_unreported');
  } else {
    let head;
    try { head = (await agentHeads())[rep.file]; } catch { head = null; }
    if (targetId !== id) return;                       // modal moved on meanwhile
    if (!head) text = t('agent_head_unknown', short(rep.sha256));
    else if (head === rep.sha256) { text = t('agent_head_match', short(head)); lv = 'lv-ok'; }
    else { text = t('agent_head_mismatch', short(rep.sha256), short(head)); lv = 'lv-danger'; }
  }
  el.textContent = text;
  if (lv) el.classList.add(lv);
  el.hidden = false;
}

async function load() {
  const canvas = $('#machineModalCanvas');
  const legend = $('#machineModalLegend');
  if (!canvas || !targetId) return;
  if (nodeCtx) return nodeCtx.kind === 'comfy' ? loadComfy(canvas, legend) : loadNode(canvas, legend);
  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  let timedOut = false;
  // 30d over every series of one target measures ~0.3s server-side; 15s is generous
  // headroom while still bounding a stalled fetch, matching the history pane's intent.
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 15000);
  try {
    const r = await fetch(`/api/history?target=${encodeURIComponent(targetId)}&range=${range}`,
      { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (inflight !== ctrl) return;                    // superseded by a newer range
    const series = j.series || {};
    // Two different absences, and conflating them misreports both. A key missing from
    // the response was never recorded for this host; a key present but with fewer than
    // two points has history, just not in this window (m110 has been offline for days,
    // so every one of its series is empty at 24h but full at 30d). The threshold is 2
    // because that is what drawMulti needs to draw a segment -- counting a 1-point
    // series as usable is how nas75's freshly-started disk-temp line went missing with
    // no explanation.
    const recorded = Object.keys(series);
    const available = recorded.filter((k) => (series[k] || []).length >= 2);
    const role = roleOf(window.__lastSnap?.[targetId], recorded);
    const subs = seriesFor(role, available);
    const cardIdx = role === 'gpu' ? gpuCardIdx(window.__lastSnap?.[targetId], recorded) : [];
    const multi = cardIdx.length > 0;
    const split = SPLIT_ROLES.has(role) && !multi;
    const second = secondPanel(split);
    const extra = extraGpuPanels(multi ? 3 : 0);
    mainTitle(multi ? t('gpu_panel_util') : '');
    try {
      if (multi) {
        const gm = gpuMetrics(cardIdx);
        const panels = gpuPanels(cardIdx);
        const opts = { metrics: gm, emptyText: t('chart_no_data_range', range) };
        drawMulti(canvas, series, legend, { ...opts, subs: panels[0].subs, height: 220 });
        panels.slice(1).forEach((p, k) => {
          setLine(extra[k].title, t(p.title));
          drawMulti(extra[k].canvas, series, extra[k].legend, { ...opts, subs: p.subs, height: 200 });
        });
      } else if (split) {
        // One series per panel, each on its own auto-scaled axis.
        const one = (s) => (s ? [{ ...s, axis: 'R' }] : []);
        // Speed only exists while requests run: never bridge more than three read buckets
        // (/api/history returns ~250 per window) or 15 minutes, whichever is longer --
        // ~17 min at 1d, ~2 h at 7d. See B25b in chart.js.
        const spanSec = { '1d': 86400, '24h': 86400, '3d': 259200, '7d': 604800, '30d': 2592000 }[range] || 86400;
        const maxGapSec = Math.max(900, 3 * Math.ceil(spanSec / 250));
        const opts = { metrics: metrics(), height: 220, emptyText: t('chart_no_data_range', range), maxGapSec };
        drawMulti(canvas, series, legend, { ...opts, subs: one(subs[0]) });
        drawMulti(second.canvas, series, second.legend, { ...opts, subs: one(subs[1]) });
      } else {
        drawMulti(canvas, series, legend, {
          subs, metrics: metrics(), height: 300,
          emptyText: t('chart_no_data_range', range),
        });
      }
    } catch (e) {
      showError(t('chart_render_failed', e?.message || e), false);
      return;
    }
    noteMissing(role, recorded, available);
    clearError();
  } catch (e) {
    if (inflight !== ctrl) return;                    // aborted by a newer request
    showError(timedOut ? t('chart_timeout', range) : t('chart_load_failed', e?.message || e), true);
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}

// The modal's own title, derived from config rather than handed in by the caller, so a
// language change can re-derive it without app.js having to remember which card was
// clicked. Same string as before: the target's display name plus " Detail".
function modalTitle(id) {
  if (nodeCtx?.kind === 'comfy') return t('comfy_modal_title', cv(nodeCtx.col, 'name') || nodeCtx.col.node);
  if (nodeCtx) return t('node_modal_title', cv(nodeCtx.col, 'name') || nodeCtx.col.node);
  const target = (CONFIG?.targets || []).find((x) => x.id === id);
  return `${cv(target, 'name') || id} Detail`;
}

// Windows for the modal now open: a card may bring its own (the speed stack asks for
// 1d/3d/7d); everything else keeps RANGES.
let ranges = RANGES;

export function openMachineModal(id, customRanges) {
  nodeCtx = null;
  targetId = id;
  ranges = Array.isArray(customRanges) && customRanges.length ? customRanges : RANGES;
  if (!ranges.includes(range)) range = ranges[0];
  setLine($('#machineModalTitle'), modalTitle(id));
  $('#machineModal').classList.add('open');
  fitLines($('#machineModal'));
  clearError();
  $('#machineModalRanges').innerHTML = ranges.map((r) =>
    `<button data-r="${esc(r)}" class="${r === range ? 'active' : ''}">${esc(r)}</button>`).join('');
  showAgent(id);
  showParts(id);
  load();
}

/** Re-title and re-draw in the language now selected. No-op while the modal is closed. */
export function relocalizeMachineModal() {
  if (!targetId || !$('#machineModal')?.classList.contains('open')) return;
  setLine($('#machineModalTitle'), modalTitle(targetId));
  showAgent(targetId);
  if (!nodeCtx) showParts(targetId);
  load();   // the note and any error line are built from the dictionary too
}

// ── v2.20 推理节点 modal ────────────────────────────────────────────────
// Same shell, same drawMulti. Two sources: the node's speed target (prefill / decode,
// live samples only — held and expired values never reach the timeseries) and the
// inference_nodes target, whose <node>_reqs / _tokens (+ _emb_*) are today's running
// totals, so each day reads as a rising line that resets at the UTC day boundary.
let nodeCtx = null;   // { col, usageTarget }

export function openNodeModal({ col, usageTarget, liveTarget = null, ranges: customRanges }) {
  nodeCtx = { col, usageTarget, liveTarget };
  targetId = col.speed || col.probe;
  ranges = Array.isArray(customRanges) && customRanges.length ? customRanges : ['1d', '3d', '7d'];
  if (!ranges.includes(range)) range = ranges[0];
  setLine($('#machineModalTitle'), modalTitle(targetId));
  $('#machineModal').classList.add('open');
  fitLines($('#machineModal'));
  clearError();
  const note = $('#machineModalNote'); if (note) { note.hidden = true; note.textContent = ''; }
  const ag = $('#machineModalAgent'); if (ag) ag.hidden = true;
  showParts(null);
  $('#machineModalRanges').innerHTML = ranges.map((r) =>
    `<button data-r="${esc(r)}" class="${r === range ? 'active' : ''}">${esc(r)}</button>`).join('');
  load();
}

const SPAN_SEC = { '1d': 86400, '24h': 86400, '3d': 259200, '7d': 604800, '30d': 2592000 };

async function loadNode(canvas, legend) {
  const { col, usageTarget, liveTarget } = nodeCtx;
  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 15000);
  const get = async (id) => {
    if (!id) return {};
    const r = await fetch(`/api/history?target=${encodeURIComponent(id)}&range=${range}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).series || {};
  };
  try {
    const [sp, us, lvh] = await Promise.all([get(col.speed), get(usageTarget), get(liveTarget)]);
    if (inflight !== ctrl) return;
    const second = secondPanel(true);
    const extra = extraGpuPanels(liveTarget ? 3 : 2);
    mainTitle(t('node_panel_speed'));
    const m = metrics();
    const maxGapSec = Math.max(900, 3 * Math.ceil((SPAN_SEC[range] || 86400) / 250));   // B25b
    const noSpeed = col.speed ? t('chart_no_data_range', range) : (cv(col, 'speed_note') || t('node_no_speed_src'));
    const sOpts = { metrics: m, height: 190, emptyText: noSpeed, maxGapSec };
    drawMulti(canvas, sp, legend, { ...sOpts, subs: [{ k: 'prefill_speed', color: '#6aa9ff', axis: 'R' }] });
    drawMulti(second.canvas, sp, second.legend, { ...sOpts, subs: [{ k: 'decode_speed', color: '#5eead4', axis: 'R' }] });
    // v2.22: total (the server's own counters) against the LiteLLM share; a series the
    // node has no source for simply never appears (drawMulti skips missing keys).
    // v2.23: plus the embedding server's own count (llama-log-exporter) where there is one.
    const p = col.node;
    const um = {
      ...m,
      [`${p}_reqs`]: { label: t('node_series_total') }, [`${p}_ll_reqs`]: { label: t('node_series_ll') },
      [`${p}_emb_ll_reqs`]: { label: t('node_series_emb_ll') }, [`${p}_emb_reqs`]: { label: t('node_series_emb_total') },
      [`${p}_tokens`]: { label: t('node_series_total') }, [`${p}_ll_tokens`]: { label: t('node_series_ll') },
      [`${p}_emb_ll_tokens`]: { label: t('node_series_emb_ll') }, [`${p}_emb_tokens`]: { label: t('node_series_emb_total') },
    };
    const uOpts = { metrics: um, height: 170, emptyText: t('chart_no_data_range', range) };
    setLine(extra[0].title, t('node_panel_reqs'));
    drawMulti(extra[0].canvas, us, extra[0].legend, { ...uOpts, subs: [
      { k: `${p}_reqs`, color: '#f7c948', axis: 'R' }, { k: `${p}_ll_reqs`, color: '#5eead4', axis: 'R' },
      { k: `${p}_emb_reqs`, color: '#e879f9', axis: 'R' }, { k: `${p}_emb_ll_reqs`, color: '#b18cff', axis: 'R' }] });
    setLine(extra[1].title, t('node_panel_tokens'));
    drawMulti(extra[1].canvas, us, extra[1].legend, { ...uOpts, subs: [
      { k: `${p}_tokens`, color: '#ff9d5c', axis: 'R' }, { k: `${p}_ll_tokens`, color: '#5eead4', axis: 'R' },
      { k: `${p}_emb_tokens`, color: '#e879f9', axis: 'R' }, { k: `${p}_emb_ll_tokens`, color: '#b18cff', axis: 'R' }] });
    // v2.26: concurrency -- one line per stream (its decode t/s, right axis) and the number of
    // streams running (left axis, 0..4), from the live reader's history
    if (liveTarget) {
      const nStreams = Math.max(0, ...Object.keys(lvh).map((k) => (k.match(new RegExp(`^${p}_s(\\d+)_tps$`)) || [])[1]).filter(Boolean).map(Number));
      const COLORS = ['#5eead4', '#f7c948', '#ff9d5c', '#6aa9ff', '#e879f9', '#a3e635'];
      const lm = { ...m, [`${p}_streams`]: { label: t('node_series_streams') } };
      const subs = [];
      for (let i = 1; i <= nStreams; i++) { lm[`${p}_s${i}_tps`] = { label: `#${i}` }; subs.push({ k: `${p}_s${i}_tps`, color: COLORS[(i - 1) % COLORS.length], axis: 'R', unit: 't/s' }); }
      subs.push({ k: `${p}_streams`, color: '#cbd5e1', axis: 'L', unit: '' });
      setLine(extra[2].title, t('node_panel_streams'));
      drawMulti(extra[2].canvas, lvh, extra[2].legend, { metrics: lm, subs, height: 170, emptyText: t('chart_no_data_range', range), maxGapSec, leftMax: Math.max(4, 4 * Math.ceil(nStreams / 4)) });
    }
    clearError();
  } catch (e) {
    if (inflight !== ctrl) return;
    showError(timedOut ? t('chart_timeout', range) : t('chart_load_failed', e?.message || e), true);
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}

// ── v2.32 ComfyUI 节点 modal ──────────────────────────────────────────────
// Same shell again. Two panels: the queue (running / waiting, sampled by the hub every poll,
// one point per 5 s in the store) and what finished per hour (images and jobs, from the hub's
// own job table via /api/comfy/hourly -- zero-filled only from when the hub first read the node).
export function openComfyModal({ col, target, ranges: customRanges }) {
  nodeCtx = { kind: 'comfy', col, target };
  targetId = target;
  ranges = Array.isArray(customRanges) && customRanges.length ? customRanges : ['1d', '3d', '7d'];
  if (!ranges.includes(range)) range = ranges[0];
  setLine($('#machineModalTitle'), modalTitle(targetId));
  $('#machineModal').classList.add('open');
  fitLines($('#machineModal'));
  clearError();
  const note = $('#machineModalNote'); if (note) { note.hidden = true; note.textContent = ''; }
  const ag = $('#machineModalAgent'); if (ag) ag.hidden = true;
  showParts(null);
  $('#machineModalRanges').innerHTML = ranges.map((r) =>
    `<button data-r="${esc(r)}" class="${r === range ? 'active' : ''}">${esc(r)}</button>`).join('');
  load();
}

async function loadComfy(canvas, legend) {
  const { col, target } = nodeCtx;
  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 15000);
  const get = async (url) => {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).series || {};
  };
  try {
    const p = col.node;
    const [q, h] = await Promise.all([
      get(`/api/history?target=${encodeURIComponent(target)}&range=${range}`),
      get(`/api/comfy/hourly?node=${encodeURIComponent(p)}&range=${range}`),
    ]);
    if (inflight !== ctrl) return;
    secondPanel(false);
    const extra = extraGpuPanels(1);
    mainTitle(t('comfy_panel_queue'));
    const maxGapSec = Math.max(900, 3 * Math.ceil((SPAN_SEC[range] || 86400) / 250));
    const qm = { [`${p}_running`]: { label: t('comfy_series_running') }, [`${p}_pending`]: { label: t('comfy_series_pending') } };
    drawMulti(canvas, q, legend, { metrics: qm, height: 190, emptyText: t('chart_no_data_range', range), maxGapSec, subs: [
      { k: `${p}_running`, color: '#5eead4', axis: 'R', unit: '' }, { k: `${p}_pending`, color: '#f7c948', axis: 'R', unit: '' }] });
    const hm2 = { [`${p}_images_h`]: { label: t('comfy_series_images') }, [`${p}_jobs_h`]: { label: t('comfy_series_jobs') } };
    setLine(extra[0].title, t('comfy_panel_hourly'));
    drawMulti(extra[0].canvas, h, extra[0].legend, { metrics: hm2, height: 190, emptyText: t('chart_no_data_range', range), subs: [
      { k: `${p}_images_h`, color: '#ff9d5c', axis: 'R', unit: '' }, { k: `${p}_jobs_h`, color: '#6aa9ff', axis: 'R', unit: '' }] });
    clearError();
  } catch (e) {
    if (inflight !== ctrl) return;
    showError(timedOut ? t('chart_timeout', range) : t('chart_load_failed', e?.message || e), true);
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}

export function closeMachineModal() {
  nodeCtx = null;
  $('#machineModal').classList.remove('open');
  if (inflight) { inflight.abort(); inflight = null; }
  targetId = null;
}

export function bindMachineModal() {
  $('#machineModalClose').onclick = closeMachineModal;
  $('#machineModal').onclick = (e) => { if (e.target.id === 'machineModal') closeMachineModal(); };
  $('#machineModalRanges').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    range = b.dataset.r;
    [...$('#machineModalRanges').children].forEach((x) => x.classList.toggle('active', x === b));
    load();
  };
  // Retry button inside the error overlay reloads just this modal.
  $('#machineModalErr').onclick = (e) => {
    if (e.target.closest('button')) { clearError(); load(); }
  };
}
