// comfy renderer (v2.32) — ComfyUI 节点 / ComfyUI Nodes: one full-width card, one column per
// ComfyUI server, from the comfyui target (server/collectors/comfyui.js, read every 2 s).
//
// The same column layout as the inference nodes card (nodes.js / tokens.css .nodes-grid):
// a head (node · ComfyUI version), one line for the GPU, then six standard cells -- status /
// queue, current progress / last finished, images today / average time per image -- that
// line up row by row across the columns. Every cell has a second line in every state.
//
// A node that does not answer is grey and says 未开机 (the ComfyUI machines are switched off
// or asleep a lot) while its machine is off. Today's figures come from the hub's own job table,
// so they stay on the card, greyed, while the node is off. v2.41: while the machine is up, its
// agent says whether ComfyUI still runs -- yellow 连线中断 if it does (comfyState); v2.43: no process is grey
// (已手动停止 with m136's stop marker, else 未运行); red only 自动修复失败, when m136's watchdog gave up.
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

// v2.41 extra.comfyui of a live, fresh machine snapshot (agents/homenet-agent.ps1: procs, listen
// [{port, addr}], cmd_port, pid, since); null when the machine is off / stale or its agent does not report
// it. The same rule as server/comfy_follow.js.
export function comfyInfo(m) {
  if (!m || m.online === false || m.stale) return null;
  const c = m.extra?.comfyui;
  return c && typeof c === 'object' && Number.isFinite(Number(c.procs)) ? c : null;
}
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;
const listenText = (c) => (Array.isArray(c?.listen) ? c.listen : []).map((l) => `${String(l?.addr ?? '').includes(':') ? `[${l.addr}]` : l?.addr}:${l?.port}`).join(', ');

// why a ComfyUI that runs does not answer, as the status's second line: not listening at all, listening on
// loopback only, or its port does not answer from the hub
function cutSub(c, port) {
  const ls = Array.isArray(c?.listen) ? c.listen : [];
  if (!ls.length) return { sub: t('comfy_cut_nolisten'), subShort: t('abbr_comfy_nolisten') };
  if (ls.every((l) => LOOPBACK.test(String(l?.addr ?? '')))) return { sub: t('comfy_cut_loopback'), subShort: t('abbr_comfy_loopback') };
  return { sub: t('comfy_cut_port', port ?? ls[0]?.port), subShort: t('abbr_comfy_port', port ?? ls[0]?.port) };
}

/** the 连线中断 title, for the node card and the 「ComfyUI · 136」 pill (web/app.js) */
export function comfyCutTitle(machine, c, port, error) {
  const since = Number(c?.since) > 0 ? hm(Number(c.since) * 1000) : '?';
  return t('comfy_cut_title', machine, port ?? c?.cmd_port ?? '?', error || '', c?.pid ?? '?', since, listenText(c));
}

// 'busy' | 'idle' | 'off' | 'wait' (no reading yet) | v2.41 'cut' | v2.42 'stopped' | v2.43 'manual' | 'failed'
// v2.41: a node that does not answer is judged by its machine's agent (the machine target with the node's id,
// extra.comfyui): a ComfyUI process still runs -> 'cut' 连线中断 / Unreachable (yellow: m136 11-03 17:02,
// asyncio's accept loop died on WinError 64 and closed the 8188 listener while the process kept running);
// the machine is off (or its agent does not report ComfyUI) -> 'off', grey 未开机 as before.
// v2.42: a node configured `on_demand: true` (m110: ComfyUI runs only while Bevan opens it himself, nothing
// starts it) with no ComfyUI process is 'stopped', grey 未运行.
// v2.43 (Bevan 11-08): no process is grey everywhere -- 'manual' 已手动停止 when the stop marker is there (m136's
// agent reports it: manual_stop), else 'stopped' 未运行 (v2.41's red 'down' is gone). Red only as 'failed'
// 自动修复失败: the m136 watchdog (comfy-watchdog.ps1) gave up -- 2 restarts in an hour did not fix it, or a restart
// left no process -- and its status is fresh. comfyDownState is shared with the 「ComfyUI · 136」 pill (web/app.js).
const WD_FRESH_S = 300;
function watchdogGaveUp(c) {
  const w = c?.watchdog;
  return !!w && w.state === 'gave-up' && Number(w.age_s) >= 0 && Number(w.age_s) <= WD_FRESH_S;
}
/** a ComfyUI that does not answer, from its machine's extra.comfyui: 'failed' | 'cut' | 'manual' | 'stopped' */
export function comfyDownState(c, onDemand = false) {
  if (watchdogGaveUp(c)) return 'failed';
  if (Number(c?.procs) > 0) return 'cut';
  if (!onDemand && c?.manual_stop === true) return 'manual';
  return 'stopped';
}
export function comfyState(n, m = null) {
  if (!n?.checked) return 'wait';
  if (n.reachable) return n.job || n.running > 0 ? 'busy' : 'idle';
  const c = comfyInfo(m);
  if (!c) return 'off';
  return comfyDownState(c, !!n.on_demand);
}
/** titles for the grey / red states, for the node card and the pill */
export function comfyDownTitle(state, machine, c, onDemand = false) {
  if (state === 'manual') return t('comfy_manual_title', machine);
  if (state === 'failed') {
    const w = c?.watchdog || {};
    return t('comfy_failed_title', machine, Number(w.restarts_1h) || 0, Number(w.gave_up_at) > 0 ? hm(Number(w.gave_up_at) * 1000) : '?', w.reason || '');
  }
  return onDemand ? t('comfy_stopped_title', machine) : t('comfy_notrun_title', machine);
}
// states in which the node does not answer (no queue / job to show; the GPU line is the last one seen)
const NOT_ANSWERING = new Set(['off', 'cut', 'stopped', 'manual', 'failed']);

function statusCell(state, n, machine, m) {
  const lat = { sub: t('comfy_latency', n.latency_ms ?? '—'), subShort: `${n.latency_ms ?? '—'} ms` };
  // (v2.41: probed on a port other than the configured one -- said in the title)
  const fol = n.followed && n.port ? { title: t('comfy_followed_title', n.port) } : {};
  if (state === 'busy') return cell(t('comfy_status'), t('comfy_busy'), { cls: 'lv-cool', short: t('abbr_comfy_busy'), ...lat, ...fol });
  if (state === 'idle') return cell(t('comfy_status'), t('comfy_idle'), { cls: 'lv-ok', ...lat, ...fol });
  if (state === 'off') {
    return cell(t('comfy_status'), t('comfy_off'), { cls: 'node-idle-text', sub: t('node_sub_ondemand'), subShort: t('abbr_ondemand'), title: n.error ? t('comfy_off_title', n.error) : '' });
  }
  if (state === 'cut') {
    const c = comfyInfo(m);
    return cell(t('comfy_status'), t('node_cut'), { cls: 'lv-warn', ...cutSub(c, n.port), title: comfyCutTitle(machine, c, n.port, n.error) });
  }
  if (state === 'stopped') {
    // (m110 on_demand: 需手动打开; elsewhere: no process, no marker)
    const sub = n.on_demand ? { sub: t('comfy_stopped_sub'), subShort: t('abbr_comfy_stopped') } : { sub: t('comfy_down_sub'), subShort: t('abbr_comfy_noproc') };
    return cell(t('comfy_status'), t('comfy_down'), { cls: 'node-idle-text', ...sub, title: comfyDownTitle(state, machine, null, !!n.on_demand) });
  }
  if (state === 'manual') {
    return cell(t('comfy_status'), t('comfy_manual'), { cls: 'node-idle-text', short: t('abbr_comfy_manual'), sub: t('comfy_manual_sub'), subShort: t('abbr_comfy_manual_sub'), title: comfyDownTitle(state, machine) });
  }
  if (state === 'failed') {
    const c = comfyInfo(m), w = c?.watchdog || {};
    const sub = w.reason === 'limit' ? { sub: t('comfy_failed_sub_limit', Number(w.restarts_1h) || 0), subShort: t('abbr_comfy_failed_limit') } : { sub: t('comfy_failed_sub_noproc'), subShort: t('abbr_comfy_failed_noproc') };
    return cell(t('comfy_status'), t('comfy_failed_state'), { cls: 'lv-danger', short: t('abbr_comfy_failed_state'), ...sub, title: comfyDownTitle(state, machine, c) });
  }
  return cell(t('comfy_status'), '—', { sub: t('comfy_checking') });
}

function queueCell(state, n) {
  // (not answering: when the hub last reached it -- since this hub started)
  if (NOT_ANSWERING.has(state)) return cell(t('comfy_queue'), '—', n.seen_at ? { sub: t('comfy_seen', hm(n.seen_at)), subShort: hm(n.seen_at) } : { sub: t('comfy_never'), subShort: t('abbr_comfy_never') });
  if (state !== 'busy' && state !== 'idle') return cell(t('comfy_queue'), '—', { sub: '—' });
  const r = n.running ?? 0, k = n.pending ?? 0;
  return cell(t('comfy_queue'), t('comfy_queue_val', r, k), {
    cls: r ? 'lv-cool' : '', short: t('abbr_comfy_queue_val', r, k),
    sub: r + k ? t('comfy_queue_total', r + k) : t('node_no_queue'),
  });
}

function progressCell(state, n) {
  const j = n.job;
  if (state !== 'busy' || !j) return cell(t('comfy_progress'), '—', { sub: state === 'idle' || NOT_ANSWERING.has(state) ? t('comfy_no_job') : '—', labelShort: t('abbr_comfy_progress') });
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
    const mach = resolve(col.node)?.snap || null;     // v2.41 the machine of the same id (its agent's extra.comfyui)
    const state = comfyState(n, mach);
    const stale = NOT_ANSWERING.has(state);
    const name = cv(col, 'name') || col.node;
    const sys = n?.system || {};
    const ver = sys.version ? t('comfy_version', sys.version) : 'ComfyUI';
    const gpu = [sys.gpu, sys.vram_total_gb != null ? `${sys.vram_total_gb} GB` : null].filter(Boolean).join(' · ') || '—';
    const gpuTitle = sys.gpu ? t('comfy_gpu_title', sys.gpu, sys.vram_used_gb ?? '—', sys.vram_total_gb ?? '—') : '';
    const colCls = state === 'off' || state === 'stopped' || state === 'manual' ? 'node-idle' : state === 'busy' ? 'node-online node-busy' : state === 'cut' ? 'node-online node-cut' : state === 'failed' ? 'node-online node-down' : 'node-online';
    // (cells flow down the columns: status / queue, progress / last, today / average)
    const cells = statusCell(state, n || {}, col.node, mach) + queueCell(state, n || {})
      + progressCell(state, n || {}) + lastCell(n || {})
      + todayCells(n || {});
    return `<div class="node-col ${colCls}" data-col="${idx}">`
      + `<div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-port fit" data-min="10">· ${esc(ver)}</span></div>`
      + `<div class="node-model fit${stale ? ' is-last' : ''}"${gpuTitle ? ` title="${esc(gpuTitle)}"` : ''}>${esc(gpu)}</div>`
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
