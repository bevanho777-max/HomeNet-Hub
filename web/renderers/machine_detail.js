// Machine detail modal (§6) — click a machine card, get that host's history as one
// multi-line chart. Same renderer and same /api/history data as History · Dual
// Compare; only the shell (Token Detail's modal) and the series selection differ.
import { esc } from './common.js';
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
};
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
  el.innerHTML = `<span class="histErrMsg">${esc(msg)}</span>${retry ? '<button type="button">重试</button>' : ''}`;
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
  const name = (k) => m[k]?.label || k;
  const never = wanted.filter((k) => !recorded.includes(k));
  const thin = wanted.filter((k) => recorded.includes(k) && !available.includes(k));
  const el = $('#machineModalNote');
  if (!el) return;
  const parts = [];
  if (never.length) parts.push(`${never.map(name).join('、')}：未记录历史`);
  if (thin.length) parts.push(`${thin.map(name).join('、')}：该时段无数据`);
  if (!parts.length) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = parts.join('　');
  el.hidden = false;
}

async function load() {
  const canvas = $('#machineModalCanvas');
  const legend = $('#machineModalLegend');
  if (!canvas || !targetId) return;
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
    try {
      drawMulti(canvas, series, legend, {
        subs, metrics: metrics(), height: 300,
        emptyText: `该时段无数据（${range}）`,
      });
    } catch (e) {
      showError(`渲染失败：${e?.message || e}`, false);
      return;
    }
    noteMissing(role, recorded, available);
    clearError();
  } catch (e) {
    if (inflight !== ctrl) return;                    // aborted by a newer request
    showError(timedOut ? `加载超时（${range}）` : `加载失败：${e?.message || e}`, true);
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}

export function openMachineModal(id, title) {
  targetId = id;
  $('#machineModalTitle').textContent = title;
  $('#machineModal').classList.add('open');
  clearError();
  $('#machineModalRanges').innerHTML = RANGES.map((r) =>
    `<button data-r="${esc(r)}" class="${r === range ? 'active' : ''}">${esc(r)}</button>`).join('');
  load();
}

export function closeMachineModal() {
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
