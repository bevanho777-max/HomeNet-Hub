// roles.js (v2.50) — ComfyUI / LLM 节点: which of its two jobs each RTX 5090 machine is doing.
//
// m110 and m136 take turns: sometimes ComfyUI, sometimes a large language model -- one at a time (Bevan's rule;
// BACKLOG 64). The LLM is reached through litellm 4003 (m110) / 4004 (m136). The hub only WATCHES: nothing here
// starts, stops or changes anything on either machine.
//
// Inputs, per machine (the comfy target's nodes that name their inference node with `llm:`):
//   ComfyUI   the ComfyUI collector's reading (answers? queue) and the agent's extra.comfyui (process, since)
//   LLM       the live reader (inference_live: answers? requests in flight) and the agent's extra.llm
//             (agents/homenet-agent.ps1: engine process, ports, since, busy)
//   power     the machine target: its agent pushes (on) or not (off)
//
// One detection every EVAL_MS (the agent re-reads its processes every ~10 s):
//   whichever service is there is the role (there = it answers, or its process runs);
//   both there (a switch in progress): the one at work wins -- ComfyUI's queue not empty, or the LLM has requests
//   in flight; both idle (or both at work): the one started last (the processes' start times);
//   neither: 'off' -- the role stays what it was (the card keeps its last figures, greyed).
// A new state must be detected CONFIRM times in a row before it is taken, so a restart (ComfyUI down for a few
// seconds) does not flip the card back and forth. The state, the role, when each began and the last things seen
// (model, engine, ports, GPU) are kept in the hub's database (node_role): a hub restart keeps all of it. Every
// change of state is logged (role_log) -- the detail modal's timeline -- and printed to the container log.
import Database from 'better-sqlite3';
import { llmInfo } from './engine.js';
import { comfyInfo } from './comfy_follow.js';

export const EVAL_MS = 10000;
export const CONFIRM = 2;
const KEEP_DAYS = 90;
const SEEN_WRITE_MS = 300000;      // last_on is rewritten at most this often while nothing else changes

export const STATES = ['comfy', 'llm', 'off'];

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

/** is the machine pushing right now (its agent is up) */
export function powerOn(m) { return !!(m && m.online !== false && !m.stale); }

/**
 * One detection for one machine.
 * @returns { state: 'comfy'|'llm'|'off', why, comfyUp, llmUp, comfyBusy, llmBusy, power }
 *   why: only-comfy | only-llm | busy-comfy | busy-llm | newer-comfy | newer-llm | kept | none
 */
export function detect({ machine = null, comfyNode = null, liveNode = null, current = null } = {}) {
  const power = powerOn(machine);
  const c = comfyInfo(machine), l = llmInfo(machine);
  const comfyUp = comfyNode?.reachable === true || num(c?.procs) > 0;
  const llmUp = liveNode?.reachable === true || num(l?.procs) > 0;
  const comfyBusy = comfyNode?.reachable === true && num(comfyNode.running) + num(comfyNode.pending) > 0;
  const llmBusy = (liveNode?.reachable === true && num(liveNode.busy) + num(liveNode.queued) > 0) || num(l?.busy) > 0;
  const base = { comfyUp, llmUp, comfyBusy, llmBusy, power };
  if (!comfyUp && !llmUp) return { ...base, state: 'off', why: 'none' };
  if (comfyUp && !llmUp) return { ...base, state: 'comfy', why: 'only-comfy' };
  if (llmUp && !comfyUp) return { ...base, state: 'llm', why: 'only-llm' };
  if (comfyBusy !== llmBusy) return { ...base, state: comfyBusy ? 'comfy' : 'llm', why: comfyBusy ? 'busy-comfy' : 'busy-llm' };
  const cs = num(c?.since), ls = num(l?.since);
  if (ls > cs) return { ...base, state: 'llm', why: 'newer-llm' };
  if (cs > ls) return { ...base, state: 'comfy', why: 'newer-comfy' };
  return { ...base, state: current === 'llm' ? 'llm' : 'comfy', why: 'kept' };
}

/**
 * The confirmation step: `st` = { state, cand, candN }; returns the state to take now (or null: keep).
 * A detection equal to the current state clears any candidate.
 */
export function confirmStep(st, detected, need = CONFIRM) {
  if (detected === st.state) { st.cand = null; st.candN = 0; return null; }
  if (detected === st.cand) st.candN += 1; else { st.cand = detected; st.candN = 1; }
  if (st.candN >= need) { st.cand = null; st.candN = 0; return detected; }
  return null;
}

/** segments of [from, to] (ms) from a state at `from` and the changes after it: [{ from, to, state }] */
export function segments(startState, changes, from, to) {
  const out = [];
  let cur = startState, at = from;
  for (const ch of changes) {
    if (ch.at <= from) { cur = ch.state; continue; }
    if (ch.at >= to) break;
    if (ch.state === cur) continue;
    if (ch.at > at) out.push({ from: at, to: ch.at, state: cur });
    cur = ch.state; at = ch.at;
  }
  if (to > at) out.push({ from: at, to, state: cur });
  return out.filter((s) => s.to > s.from);
}

export class RoleTracker {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_role (node TEXT PRIMARY KEY, state TEXT NOT NULL, role TEXT NOT NULL,
        since INTEGER NOT NULL, role_since INTEGER NOT NULL, last_on INTEGER, info TEXT);
      CREATE TABLE IF NOT EXISTS role_log (node TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, why TEXT);
      CREATE INDEX IF NOT EXISTS role_log_at ON role_log (node, at);
    `);
    this.db.prepare('DELETE FROM role_log WHERE at < ?').run(Date.now() - KEEP_DAYS * 86400000);
    this._get = this.db.prepare('SELECT * FROM node_role WHERE node = ?');
    this._put = this.db.prepare(`INSERT INTO node_role (node, state, role, since, role_since, last_on, info) VALUES (@node, @state, @role, @since, @role_since, @last_on, @info)
      ON CONFLICT (node) DO UPDATE SET state = excluded.state, role = excluded.role, since = excluded.since, role_since = excluded.role_since,
        last_on = excluded.last_on, info = excluded.info`);
    this._log = this.db.prepare('INSERT INTO role_log (node, at, state, why) VALUES (?, ?, ?, ?)');
    this._before = this.db.prepare('SELECT state FROM role_log WHERE node = ? AND at <= ? ORDER BY at DESC LIMIT 1');
    this._after = this.db.prepare('SELECT at, state FROM role_log WHERE node = ? AND at > ? AND at < ? ORDER BY at');
    this._first = this.db.prepare('SELECT MIN(at) AS at FROM role_log WHERE node = ?');
    this.nodes = new Map();
  }

  /**
   * @param comfyTarget  the comfyui target: nodes with `llm: <inference node id>` are tracked
   * @param machines     id -> machine target (its `badge`: the GPU's name when ComfyUI never said)
   */
  configure(comfyTarget, machines = new Map()) {
    const next = new Map();
    for (const n of comfyTarget?.nodes || []) {
      if (!n?.id || !n.llm) continue;
      const old = this.nodes.get(n.id);
      if (old) { old.llm = String(n.llm); old.badge = machines.get(n.id)?.badge || null; next.set(n.id, old); continue; }
      const row = this._get.get(n.id);
      let info = {};
      try { info = row?.info ? JSON.parse(row.info) : {}; } catch { info = {}; }
      next.set(n.id, {
        id: n.id, llm: String(n.llm), badge: machines.get(n.id)?.badge || null,
        state: row?.state || null, role: row?.role || null, since: row?.since || null, roleSince: row?.role_since || null,
        lastOn: row?.last_on || null, info, cand: null, candN: 0, why: null, lastEval: 0, det: null, savedAt: 0, mismatchLogged: null,
      });
    }
    this.nodes = next;
  }

  has(id) { return this.nodes.has(id); }

  _save(n, now) {
    this._put.run({ node: n.id, state: n.state, role: n.role, since: n.since, role_since: n.roleSince, last_on: n.lastOn, info: JSON.stringify(n.info) });
    n.savedAt = now;
  }

  /**
   * One step (called every ComfyUI poll, 2 s; detects every EVAL_MS).
   * @param ctx.comfyView  the ComfyUI collector's view ({ nodes: { id: {...} } })
   * @param ctx.machineOf  id -> machine snapshot
   * @param ctx.liveView   the live reader's view ({ nodes: { <llm node>: {...} } })
   * @param ctx.engine     EngineDetector (engine, port, model of the LLM node)
   * @param ctx.nodesSnap  the inference_nodes snapshot (litellm routes and their backend address)
   */
  update({ now = Date.now(), comfyView = null, machineOf = () => null, liveView = null, engine = null, nodesSnap = null } = {}) {
    for (const n of this.nodes.values()) {
      const m = machineOf(n.id);
      const cn = comfyView?.nodes?.[n.id] || null;
      const ln = liveView?.nodes?.[n.llm] || null;
      this._remember(n, { m, cn, ln, engine, nodesSnap, now });
      if (now - n.lastEval < EVAL_MS) continue;
      n.lastEval = now;
      const det = detect({ machine: m, comfyNode: cn, liveNode: ln, current: n.role });
      n.det = det; n.why = det.why;
      let dirty = false;
      if (det.state !== 'off') {
        const was = n.lastOn;
        n.lastOn = now;
        if (!was || now - n.savedAt >= SEEN_WRITE_MS) dirty = true;
      }
      if (!n.state) {
        // never seen before: taken at once (nothing to flip back from)
        n.state = det.state; n.since = now;
        n.role = det.state === 'off' ? 'comfy' : det.state; n.roleSince = now;
        this._log.run(n.id, now, n.state, det.why);
        console.log(`[role] ${n.id}: first seen ${n.state} (${det.why})`);
        dirty = true;
      } else {
        const take = confirmStep(n, det.state);
        if (take) {
          const prev = n.state;
          n.state = take; n.since = now;
          if (take !== 'off' && take !== n.role) { n.role = take; n.roleSince = now; }
          this._log.run(n.id, now, take, det.why);
          console.log(`[role] ${n.id}: ${prev} -> ${take} (${det.why}${take === 'off' ? `, role stays ${n.role}` : ''})`);
          dirty = true;
        }
      }
      if (n.infoDirty) { n.infoDirty = false; dirty = true; }
      if (dirty) this._save(n, now);
    }
    return this.view(now, { machineOf, engine });
  }

  // the last things seen of each side, for the card while that side is not there (kept across a restart)
  _remember(n, { m, cn, ln, engine, nodesSnap, now }) {
    const I = n.info;
    const set = (k, v) => { if (v != null && JSON.stringify(I[k]) !== JSON.stringify(v)) { I[k] = v; n.infoDirty = true; } };
    if (cn?.reachable && cn.system) {
      set('comfy_system', { version: cn.system.version || null, gpu: cn.system.gpu || null, vram_total_gb: cn.system.vram_total_gb ?? null });
    }
    if (cn?.reachable && cn.port) set('comfy_port', cn.port);
    const e = engine?.has(n.llm) ? engine.info(n.llm) : null;
    if (e?.engine) {
      set('llm_engine', e.engine);
      set('llm_engine_name', e.name);
      if (e.port) set('llm_port', e.port);
      if (e.model) set('llm_model', e.model);
    }
    const l = llmInfo(m);
    if (l && num(l.procs) > 0) {
      if (l.model && !e?.model) set('llm_model', String(l.model).slice(0, 96));
      if (l.engine && !e?.engine) set('llm_engine', String(l.engine));
    }
    if (ln?.reachable === true) {
      if (!I.llm_seen || now - I.llm_seen >= 60000) { I.llm_seen = now; n.infoDirty = n.infoDirty || !n.savedAt || now - n.savedAt >= SEEN_WRITE_MS; }
    }
    // GPU when ComfyUI never said: the machine card's badge and the VRAM total its agent reports ("30.8/31.8G")
    if (!I.comfy_system?.gpu && n.badge) {
      const mx = String(m?.metrics?.vram_bytes?.display || '').match(/\/([\d.]+)\s*G/i);
      set('gpu_fallback', { gpu: n.badge, vram_total_gb: mx ? Number(mx[1]) : (I.gpu_fallback?.vram_total_gb ?? null) });
    }
    // litellm: the instance(s) routing to the LLM node, and the backend port they send to
    const route = nodesSnap?.extra?.nodes?.[n.llm];
    if (Array.isArray(route?.routes)) {
      const r = route.routes.find((x) => x.live && x.intended) || route.routes.find((x) => x.live) || null;
      set('litellm_port', r ? r.port : null);
      const at = r?.at?.[0] || null;
      const bp = at ? Number(String(at).split(':').pop()) || null : null;
      set('backend_port', bp);
    }
  }

  /** the LLM engine's port now (where it answers to the hub, else where the agent saw it) vs litellm's backend port */
  _mismatch(n, m, engine) {
    const I = n.info;
    if (!I.backend_port) return null;
    const e = engine?.has(n.llm) ? engine.info(n.llm) : null;
    const l = llmInfo(m);
    const live = e?.engine && !e.error ? e.port : null;
    const seen = l && num(l.procs) > 0 ? num(l.api_port) || null : null;
    const now = live || seen;
    if (!now || now === I.backend_port) return null;
    return { litellm: I.litellm_port || null, backend: I.backend_port, engine: now };
  }

  view(now = Date.now(), { machineOf = null, engine = null } = {}) {
    const out = {};
    for (const n of this.nodes.values()) {
      const m = machineOf ? machineOf(n.id) : null;
      const mm = this._mismatch(n, m, engine);
      if (mm && n.mismatchLogged !== `${mm.backend}>${mm.engine}`) {
        n.mismatchLogged = `${mm.backend}>${mm.engine}`;
        console.log(`[role] ${n.id}: litellm ${mm.litellm || '?'} sends to :${mm.backend}, the engine answers on :${mm.engine} -- not changed automatically`);
      } else if (!mm) n.mismatchLogged = null;
      out[n.id] = {
        llm: n.llm, state: n.state, role: n.role, since: n.since, role_since: n.roleSince, last_on: n.lastOn,
        cand: n.cand, cand_n: n.candN, confirm: CONFIRM, why: n.why,
        power: n.det ? (n.det.power ? 'on' : 'off') : null,
        up: n.det ? { comfy: n.det.comfyUp, llm: n.det.llmUp, comfy_busy: n.det.comfyBusy, llm_busy: n.det.llmBusy } : null,
        info: n.info, ...(mm ? { mismatch: mm } : {}),
      };
    }
    return out;
  }

  /** the role timeline of one machine over [fromMs, toMs]: segments of comfy / llm / off ('none' before the first record) */
  timeline(id, fromMs, toMs) {
    const first = this._first.get(id)?.at ?? null;
    const before = this._before.get(id, fromMs)?.state || null;
    const changes = this._after.all(id, fromMs, toMs);
    const segs = segments(before || 'none', changes, fromMs, toMs);
    return { node: id, from: fromMs, to: toMs, first, segments: segs };
  }
}
