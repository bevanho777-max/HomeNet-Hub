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
//
// v2.50 ComfyUI / LLM 节点 (BACKLOG 64): m110 / m136 take turns running ComfyUI or a large language model, one at a
// time. The hub judges which (server/roles.js: the one that runs; both -- the one at work, else the one started last;
// a new role only after two detections in a row) and the column shows that role, in the same place with the same six
// cells of the same size: a role tag after the machine's name (ComfyUI orange, LLM purple), then
//   ComfyUI  status / queue / progress / last done / images today / average per image (as before)
//   LLM      status (latency on its second line) / concurrency-queue / Prefill (上次) / Decode (上次) / requests today /
//            tokens today -- the 推理节点 card's very cells (nodes.js speedCells, usageCells: the same sources, the same
//            「上次」 rule, the same ≈), so nothing here computes them a second way.
// Both off: the column greys out, its status says 离线 · 最后为 LLM 12:20 (未开机 when the machine itself is off) and every
// other cell keeps its last figure -- today's images / requests / tokens stay until Beijing midnight.
import { card, esc } from './common.js';
import { cv, t } from '../i18n.js';
import { cell as nodeCell, speedCells, usageCells } from './nodes.js';

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

// ── v2.50 roles ─────────────────────────────────────────────────────────────

const ROLE_NAME = { comfy: 'ComfyUI', llm: 'LLM' };
const ENGINE_NAME = { strata: 'Strata', llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI API' };
export const roleName = (r) => ROLE_NAME[r] || r;

/** v2.50 extra.llm of a live, fresh machine snapshot (agents/homenet-agent.ps1); null when off / stale / not reported */
export function llmInfo(m) {
  if (!m || m.online === false || m.stale) return null;
  const c = m.extra?.llm;
  return c && typeof c === 'object' && Number.isFinite(Number(c.procs)) ? c : null;
}
const machineUp = (m) => !!(m && m.online !== false && !m.stale);

/**
 * the LLM side's state now: 'busy' | 'idle' | 'cut' | 'stopped' | 'off' (machine off) | 'wait'
 *   reachable (live reader): busy while requests run, else idle; not reachable: its machine's agent says whether an
 *   LLM server process runs (yellow 连线中断) or not (grey 未运行); the machine not reporting at all: 未开机
 */
export function llmState(lv, m) {
  if (!machineUp(m)) return lv?.reachable === true ? (Number(lv.busy) > 0 ? 'busy' : 'idle') : 'off';
  if (lv?.reachable === true) return Number(lv.busy) > 0 || Number(lv.queued) > 0 ? 'busy' : 'idle';
  const c = llmInfo(m);
  if (Number(c?.procs) > 0) return 'cut';
  if (!c && lv?.reachable == null) return 'wait';
  return 'stopped';
}

/** why an LLM server that runs does not answer (agent's listen list), as the status's second line */
function llmCutSub(c) {
  const ls = Array.isArray(c?.listen) ? c.listen : [];
  if (!ls.length) return { sub: t('comfy_cut_nolisten'), subShort: t('abbr_comfy_nolisten') };
  if (ls.every((l) => LOOPBACK.test(String(l?.addr ?? '')))) return { sub: t('comfy_cut_loopback'), subShort: t('abbr_comfy_loopback') };
  const p = c?.api_port || ls[0]?.port;
  return { sub: t('comfy_cut_port', p), subShort: t('abbr_comfy_port', p) };
}

function llmCutTitle(machine, c, error) {
  const since = Number(c?.since) > 0 ? hm(Number(c.since) * 1000) : '?';
  return t('llm_cut_title', machine, ENGINE_NAME[c?.engine] || c?.engine || '?', c?.name || '?', c?.pid ?? '?', since, listenText(c), error || '');
}

/** the time a role was last seen at work, for 离线 · 最后为 LLM 12:20 */
const lastSeenText = (R) => (R?.last_on ? hm(R.last_on) : '—');

/** the state of a whole column: the (confirmed) role, and what that role's service does now */
export function columnState(R, n, lv, m) {
  const role = R?.role === 'llm' ? 'llm' : 'comfy';
  const offline = R?.state === 'off';
  const sub = role === 'llm' ? llmState(lv, m) : comfyState(n, m);
  return { role, offline, sub, power: machineUp(m) };
}

/** v2.50 the role chip (「136 · ComfyUI」 / 「136 · LLM」): { cls, label, lat, tip } -- the card's own rules */
export function roleChip(id, short, R, n, lv, m, onDemand = false) {
  const cs = columnState(R, n, lv, m);
  const label = `${short} · ${roleName(cs.role)}`;
  const last = t('role_last', roleName(cs.role), lastSeenText(R));
  if (!cs.power) return { cls: 'unknown', label, lat: t('machine_off'), tip: t('role_poweroff_title', id, roleName(cs.role), lastSeenText(R)) };
  if (cs.role === 'comfy' && cs.sub === 'failed') {
    const c = comfyInfo(m);
    return { cls: 'offline', label, lat: t('comfy_failed_state'), tip: comfyDownTitle('failed', id, c) };
  }
  if (cs.offline) return { cls: 'unknown', label, lat: t('role_offline'), tip: `${t('role_offline_title', id, roleName(cs.role), lastSeenText(R))}\n${last}` };
  if (cs.role === 'llm') {
    if (cs.sub === 'busy' || cs.sub === 'idle') return { cls: 'online', label, lat: lv?.latency_ms != null ? `${lv.latency_ms}ms` : '', tip: '' };
    if (cs.sub === 'cut') return { cls: 'cut', label, lat: t('node_cut'), tip: llmCutTitle(id, llmInfo(m), lv?.error) };
    return { cls: 'unknown', label, lat: t('comfy_down'), tip: t('llm_stopped_title', id) };
  }
  if (cs.sub === 'busy' || cs.sub === 'idle') return { cls: 'online', label, lat: n?.latency_ms != null ? `${n.latency_ms}ms` : '', tip: n?.followed && n?.port ? t('comfy_followed_title', n.port) : '' };
  if (cs.sub === 'cut') return { cls: 'cut', label, lat: t('node_cut'), tip: comfyCutTitle(id, comfyInfo(m), n?.port, n?.error) };
  if (cs.sub === 'manual' || cs.sub === 'stopped') {
    return { cls: 'unknown', label, lat: t(cs.sub === 'manual' ? 'comfy_manual' : 'comfy_down'), tip: comfyDownTitle(cs.sub, id, comfyInfo(m), onDemand) };
  }
  return { cls: 'unknown', label, lat: '', tip: '' };
}

const WHY = { 'only-comfy': 'role_why_only_comfy', 'only-llm': 'role_why_only_llm', 'busy-comfy': 'role_why_busy_comfy', 'busy-llm': 'role_why_busy_llm',
  'newer-comfy': 'role_why_newer_comfy', 'newer-llm': 'role_why_newer_llm', kept: 'role_why_kept', none: 'role_why_none' };

function roleTagTitle(R) {
  if (!R) return '';
  const lines = [t('role_tag_title', roleName(R.role), R.role_since ? hm(R.role_since) : '?')];
  if (R.why && WHY[R.why]) lines.push(t(WHY[R.why]));
  if (R.cand && R.cand_n > 0) lines.push(t('role_switching', R.cand === 'off' ? t('role_offline') : roleName(R.cand), R.cand_n, R.confirm || 2));
  return lines.join('\n');
}

function head(name, role, rest, R, { mismatch = null } = {}) {
  const tag = `<span class="role-tag role-${role}"${R ? ` title="${esc(roleTagTitle(R))}"` : ''}>${esc(roleName(role))}</span>`;
  const mm = mismatch ? `<span class="role-mismatch" title="${esc(t('role_mismatch_title', mismatch.litellm || '?', mismatch.backend, mismatch.engine, mismatch.follow || 0))}">≠ :${esc(String(mismatch.engine))}</span>` : '';
  return `<div class="node-head"><span class="node-name">${esc(name)}</span>${tag}<span class="node-port fit" data-min="10">${rest ? `· ${rest}` : ''}${mm}</span></div>`;
}

// the second line: what runs (ComfyUI: the GPU; LLM: the model, then the GPU), greyed when it is the last one seen
function gpuText(R, sys) {
  const g = sys?.gpu ? sys : (R?.info?.comfy_system?.gpu ? R.info.comfy_system : R?.info?.gpu_fallback) || {};
  return { gpu: g.gpu || null, vram: g.vram_total_gb != null ? `${g.vram_total_gb} GB` : null };
}
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function modelLine(parts, { last = false, title = '', shorts = [] } = {}) {
  const text = parts.filter(Boolean).join(' · ') || '—';
  const ds = shorts.filter((x) => x && x !== text).map((x, i) => ` data-short${i ? i + 1 : ''}="${esc(x)}"`).join('');
  return `<div class="node-model fit${last ? ' is-last' : ''}"${title ? ` title="${esc(title)}"` : ''}${ds}>${esc(text)}</div>`;
}

// ── ComfyUI mode ──
function comfyColumn(col, idx, n, mach, R, cs) {
  const name = cv(col, 'name') || col.node;
  const state = cs.sub;
  const stale = NOT_ANSWERING.has(state) || cs.offline;
  const sys = n?.system || R?.info?.comfy_system || {};
  const ver = sys.version ? `v${sys.version}` : '';
  const g = gpuText(R, n?.system);
  const gpuTitle = g.gpu ? t('comfy_gpu_title', g.gpu, n?.system?.vram_used_gb ?? '—', (n?.system?.vram_total_gb ?? R?.info?.comfy_system?.vram_total_gb) ?? '—') : '';
  const dim = cs.offline && state !== 'failed';
  const colCls = dim || state === 'off' || state === 'stopped' || state === 'manual' ? 'node-idle' : state === 'busy' ? 'node-online node-busy' : state === 'cut' ? 'node-online node-cut' : state === 'failed' ? 'node-online node-down' : 'node-online';
  const status = dim ? offlineCell(R, mach, col.node) : statusCell(state, n || {}, col.node, mach);
  const cells = status + queueCell(dim ? 'off' : state, n || {})
    + progressCell(dim ? 'off' : state, n || {}) + lastCell(n || {})
    + todayCells(n || {});
  return `<div class="node-col ${colCls}" data-col="${idx}" data-role="comfy">`
    + head(name, 'comfy', esc(ver), R)
    + modelLine([g.gpu, g.vram], { last: stale, title: gpuTitle })
    + `<div class="kv node-kv">${cells}</div>`
    + '</div>';
}

// 离线 · 最后为 LLM 12:20 -- or 未开机 when the machine itself is off; grey either way
function offlineCell(R, mach, id) {
  const r = roleName(R?.role === 'llm' ? 'llm' : 'comfy'), when = lastSeenText(R);
  const off = !machineUp(mach);
  return cell(t('comfy_status'), off ? t('machine_off') : t('role_offline'), {
    cls: 'node-idle-text', sub: t('role_last', r, when), subShort: t('abbr_role_last', r, when),
    title: off ? t('role_poweroff_title', id, r, when) : t('role_offline_title', id, r, when),
  });
}

// ── LLM mode ──
const LLM_STATE_CLASS = { busy: 'lv-cool', idle: 'lv-ok', cut: 'lv-warn', stopped: 'node-idle-text', off: 'node-idle-text', wait: '' };

function llmStatusCell(state, lv, m, id) {
  const lat = lv?.latency_ms != null ? { sub: t('comfy_latency', lv.latency_ms), subShort: `${lv.latency_ms} ms` } : { sub: t('comfy_latency', '—'), subShort: '— ms' };
  if (state === 'busy') return cell(t('comfy_status'), t('node_busy'), { cls: 'lv-cool', short: t('abbr_busy'), ...lat });
  if (state === 'idle') return cell(t('comfy_status'), t('node_online'), { cls: 'lv-ok', ...lat });
  if (state === 'cut') { const c = llmInfo(m); return cell(t('comfy_status'), t('node_cut'), { cls: 'lv-warn', ...llmCutSub(c), title: llmCutTitle(id, c, lv?.error) }); }
  if (state === 'stopped') return cell(t('comfy_status'), t('comfy_down'), { cls: 'node-idle-text', sub: t('llm_down_sub'), subShort: t('abbr_comfy_noproc'), title: t('llm_stopped_title', id) });
  if (state === 'off') return cell(t('comfy_status'), t('comfy_off'), { cls: 'node-idle-text', sub: t('node_sub_ondemand'), subShort: t('abbr_ondemand') });
  return cell(t('comfy_status'), '—', { sub: t('comfy_checking') });
}

// 并发 / 排队: requests running / streams the server runs, and how many wait (the live reader's own figures)
function concCell(state, lv, R) {
  const label = t('llm_conc'), labelShort = t('abbr_llm_conc');
  if ((state === 'busy' || state === 'idle') && lv?.busy_known === false) {
    return nodeCell(label, '—', { sub: t('llm_conc_unknown'), subShort: t('abbr_llm_conc_unknown'), labelShort, title: t('llm_conc_unknown_title') });
  }
  if (state === 'busy' || state === 'idle') {
    const r = Number(lv?.running) || 0, M = Number(lv?.max_streams) || 1, q = Number(lv?.queued) || 0;
    return nodeCell(label, esc(`${r}/${M}`), { cls: r ? 'lv-cool' : '', sub: q ? t('node_queued', q) : t('node_no_queue'), labelShort });
  }
  const seen = R?.info?.llm_seen;
  return nodeCell(label, '—', seen ? { sub: t('comfy_seen', hm(seen)), subShort: hm(seen), labelShort } : { sub: t('comfy_never'), subShort: t('abbr_comfy_never'), labelShort });
}

function llmColumn(col, idx, mach, R, cs, lv, meta) {
  const name = cv(col, 'name') || col.node;
  const node = R?.llm || col.node;
  const state = cs.sub;
  const I = R?.info || {};
  const route = meta?.extra?.nodes?.[node];
  const r = Array.isArray(route?.routes) ? (route.routes.find((x) => x.live && x.intended) || route.routes.find((x) => x.live)) : null;
  const ll = r ? r.port : I.litellm_port;
  const eng = lv?.engine?.engine || I.llm_engine || llmInfo(mach)?.engine || null;
  const rest = [eng ? esc(ENGINE_NAME[eng] || eng) : esc(t('llm_engine_unknown')), ll ? esc(t('node_litellm_port', ll)) : null].filter(Boolean).join(' · ');
  const model = lv?.engine?.model || I.llm_model || llmInfo(mach)?.model || null;
  const g = gpuText(R, null);
  const live = state === 'busy' || state === 'idle';
  const dim = cs.offline || state === 'off' || state === 'stopped';
  const colCls = dim ? 'node-idle' : state === 'busy' ? 'node-online node-busy' : state === 'cut' ? 'node-online node-cut' : 'node-online';
  const mTitle = [model, g.gpu, g.vram].filter(Boolean).join(' · ');
  const cells = (cs.offline ? offlineCell(R, mach, col.node) : llmStatusCell(state, lv, mach, col.node))
    + concCell(cs.offline ? 'off' : state, lv, R)
    + speedCells(col, lv, live && !cs.offline)
    + usageCells(meta, node);
  return `<div class="node-col ${colCls}" data-col="${idx}" data-role="llm">`
    + head(name, 'llm', rest, R, { mismatch: R?.mismatch || null })
    + modelLine([model || '—', g.gpu, g.vram], { last: !live || cs.offline, title: mTitle, shorts: [clip(model, 22), clip(model, 14)] })
    + `<div class="kv node-kv">${cells}</div>`
    + '</div>';
}

/**
 * @param gc       layout card ({ type: comfy, target: <comfyui target id>, nodes: [{ node, name }],
 *                 v2.50 usage: <inference_nodes id>, live: <inference_live id>)
 * @param resolve  id → { target, snap }
 */
export function renderComfy(gc, resolve) {
  const view = resolve(gc.target).snap?.extra?.comfy || null;
  const meta = gc.usage ? resolve(gc.usage).snap || null : null;
  const liveNodes = gc.live ? resolve(gc.live).snap?.extra?.live?.nodes || {} : {};
  const cols = (gc.nodes || []).map((col, idx) => {
    const n = view?.nodes?.[col.node] || null;
    const mach = resolve(col.node)?.snap || null;     // v2.41 the machine of the same id (its agent's extra.comfyui / llm)
    const R = view?.roles?.[col.node] || null;        // v2.50 its role (server/roles.js)
    const lv = R ? liveNodes[R.llm] || null : null;
    const cs = columnState(R, n, lv, mach);
    return cs.role === 'llm' ? llmColumn(col, idx, mach, R, cs, lv, meta) : comfyColumn(col, idx, n, mach, R, cs);
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
