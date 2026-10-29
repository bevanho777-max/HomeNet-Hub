// comfy renderer (v2.32) — ComfyUI 节点 / ComfyUI Nodes: one full-width card, one column per
// ComfyUI server, from the comfyui target (server/collectors/comfyui.js, read every 2 s).
//
// The same column layout as the inference nodes card (nodes.js / tokens.css .nodes-grid):
// a head (node · ComfyUI version), one line for the GPU, then six standard cells -- status /
// queue, current progress / last finished, images today / average time per image -- that
// line up row by row across the columns. Every cell has a second line in every state.
//
// A node that does not answer is grey and says 未开机 (the ComfyUI machines are switched off
// or asleep a lot), never red. Today's figures come from the hub's own job table, so they
// stay on the card, greyed, while the node is off.
import { card, esc } from './common.js';
import { cv, t } from '../i18n.js';

function hm(ms) {
  const d = new Date(ms), now = new Date();
  const p2 = (x) => ('0' + x).slice(-2);
  const s = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? s : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${s}`;
}

// 38.5 s · 1:05 · 1:02:07
function dur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${(Math.round(sec * 10) / 10).toFixed(1)} s`;
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p2 = (x) => ('0' + x).slice(-2);
  return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
}

// the standard three-line cell (label / value / second line; every line .fit -- fit.js shrinks
// it, then swaps in data-short, then data-short2). `value` is text.
function cell(label, value, { cls = '', sub = '—', short = null, subShort = null, labelShort = null, title = '' } = {}) {
  const ds = (x) => (x != null && x !== '' ? ` data-short="${esc(x)}"` : '');
  return `<div class="item"${title ? ` title="${esc(title)}"` : ''}><span class="label fit"${labelShort && labelShort !== label ? ds(labelShort) : ''}>${esc(label)}</span>`
    + `<span class="value fit${cls ? ` ${cls}` : ''}"${short && short !== value ? ds(short) : ''}>${esc(value)}</span>`
    + `<span class="sub fit"${subShort && subShort !== sub ? ds(subShort) : ''}>${esc(sub)}</span></div>`;
}

// 'busy' | 'idle' | 'off' | 'wait' (no reading yet)
export function comfyState(n) {
  if (!n?.checked) return 'wait';
  if (!n.reachable) return 'off';
  return n.job || n.running > 0 ? 'busy' : 'idle';
}

function statusCell(state, n) {
  const lat = { sub: t('comfy_latency', n.latency_ms ?? '—'), subShort: `${n.latency_ms ?? '—'} ms` };
  if (state === 'busy') return cell(t('comfy_status'), t('comfy_busy'), { cls: 'lv-cool', short: t('abbr_comfy_busy'), ...lat });
  if (state === 'idle') return cell(t('comfy_status'), t('comfy_idle'), { cls: 'lv-ok', ...lat });
  if (state === 'off') {
    return cell(t('comfy_status'), t('comfy_off'), { cls: 'node-idle-text', sub: t('node_sub_ondemand'), subShort: t('abbr_ondemand'), title: n.error ? t('comfy_off_title', n.error) : '' });
  }
  return cell(t('comfy_status'), '—', { sub: t('comfy_checking') });
}

function queueCell(state, n) {
  // (off: when the hub last reached it -- since this hub started)
  if (state === 'off') return cell(t('comfy_queue'), '—', n.seen_at ? { sub: t('comfy_seen', hm(n.seen_at)), subShort: hm(n.seen_at) } : { sub: t('comfy_never'), subShort: t('abbr_comfy_never') });
  if (state !== 'busy' && state !== 'idle') return cell(t('comfy_queue'), '—', { sub: '—' });
  const r = n.running ?? 0, k = n.pending ?? 0;
  return cell(t('comfy_queue'), t('comfy_queue_val', r, k), {
    cls: r ? 'lv-cool' : '', short: t('abbr_comfy_queue_val', r, k),
    sub: r + k ? t('comfy_queue_total', r + k) : t('node_no_queue'),
  });
}

function progressCell(state, n) {
  const j = n.job;
  if (state !== 'busy' || !j) return cell(t('comfy_progress'), '—', { sub: state === 'idle' || state === 'off' ? t('comfy_no_job') : '—', labelShort: t('abbr_comfy_progress') });
  const el = (j.exact ? '' : '≥') + dur(j.elapsed_s);
  if (j.step != null && j.steps) {
    return cell(t('comfy_progress'), t('comfy_step', j.step, j.steps), {
      cls: 'lv-cool', short: `${j.step} / ${j.steps}`, sub: t('comfy_elapsed', el), subShort: el, labelShort: t('abbr_comfy_progress'),
    });
  }
  // ComfyUI sends step progress only to the client that queued the job (browser jobs)
  return cell(t('comfy_progress'), t('comfy_elapsed', el), {
    cls: 'lv-cool', short: el, sub: t('comfy_no_steps'), subShort: t('abbr_comfy_no_steps'),
    labelShort: t('abbr_comfy_progress'), title: t('comfy_no_steps_title'),
  });
}

function lastCell(n) {
  const L = n.last;
  if (!L) return cell(t('comfy_last'), '—', { sub: t('comfy_none_yet') });
  const sub = t('comfy_last_sub', L.images, dur(L.secs));
  return cell(t('comfy_last'), hm(L.at), { sub, subShort: dur(L.secs), labelShort: t('abbr_comfy_last') });
}

function todayCells(n) {
  const d = n.today || {};
  const jobs = t('comfy_jobs', d.jobs ?? 0) + (d.failed ? ` · ${t('comfy_failed', d.failed)}` : '');
  const jobsShort = t('abbr_comfy_jobs', d.jobs ?? 0) + (d.failed ? ` · ${t('abbr_comfy_failed', d.failed)}` : '');
  const avg = d.avg_s != null
    ? cell(t('comfy_avg'), dur(d.avg_s), { sub: t('comfy_avg_over', d.images), subShort: t('abbr_comfy_avg_over', d.images), labelShort: t('abbr_comfy_avg') })
    : cell(t('comfy_avg'), '—', { sub: t('comfy_none_today'), labelShort: t('abbr_comfy_avg') });
  return cell(t('comfy_today'), String(d.images ?? 0), { sub: jobs, subShort: jobsShort, labelShort: t('abbr_comfy_today') }) + avg;
}

/**
 * @param gc       layout card ({ type: comfy, target: <comfyui target id>, nodes: [{ node, name }] })
 * @param resolve  id → { target, snap }
 */
export function renderComfy(gc, resolve) {
  const view = resolve(gc.target).snap?.extra?.comfy || null;
  const cols = (gc.nodes || []).map((col, idx) => {
    const n = view?.nodes?.[col.node] || null;
    const state = comfyState(n);
    const name = cv(col, 'name') || col.node;
    const sys = n?.system || {};
    const ver = sys.version ? t('comfy_version', sys.version) : 'ComfyUI';
    const gpu = [sys.gpu, sys.vram_total_gb != null ? `${sys.vram_total_gb} GB` : null].filter(Boolean).join(' · ') || '—';
    const gpuTitle = sys.gpu ? t('comfy_gpu_title', sys.gpu, sys.vram_used_gb ?? '—', sys.vram_total_gb ?? '—') : '';
    const colCls = state === 'off' ? 'node-idle' : state === 'busy' ? 'node-online node-busy' : 'node-online';
    // (cells flow down the columns: status / queue, progress / last, today / average)
    const cells = statusCell(state, n || {}) + queueCell(state, n || {})
      + progressCell(state, n || {}) + lastCell(n || {})
      + todayCells(n || {});
    return `<div class="node-col ${colCls}" data-col="${idx}">`
      + `<div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-port fit" data-min="10">· ${esc(ver)}</span></div>`
      + `<div class="node-model fit${state === 'off' ? ' is-last' : ''}"${gpuTitle ? ` title="${esc(gpuTitle)}"` : ''}>${esc(gpu)}</div>`
      + `<div class="kv node-kv">${cells}</div>`
      + '</div>';
  });
  return {
    ...card({
      key: gc.key || `comfy:${gc.target}`,
      title: cv(gc, 'title') || t('comfy_card_title'),
      body: `<div class="nodes-grid comfy-grid" style="--ncols:${Math.max(1, cols.length)}">${cols.join('')}</div>`,
      accent: gc.accent || '',
      kind: 'comfy',
      clickable: gc.clickable === 'detail',
      detail: { ranges: gc.detail_ranges || null, gc },
    }),
    wide: true,
  };
}
