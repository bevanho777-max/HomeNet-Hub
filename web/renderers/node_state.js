// Inference-node state rules (v2.44: moved here from nodes.js unchanged). One set of rules is shared by the board
// (nodes.js, app.js) and the hub's GET /api/node-states, which is how health-lite learns that a node is 测试中,
// 未开机 / 无服务 or 忙碌 (v2.45). No imports: server/index.js loads this file too.
//
// 'online' | 'idle' | 'testing' | 'cut' | 'down'
// v2.39 'cut' (连线中断 / Unreachable, yellow): the probe fails, but the machine of the same id is up (its
// agent pushes) and its agent counts Strata processes (extra.strata.procs) -- the path to Strata is broken
// (the 18090 forward on m25 pointed at a port Strata had left, 2026-11-04), not Strata. Red 故障 only when
// no Strata process is left either.
// v2.40 'testing' (测试中 · <port> / Testing · <port>, cyan): the probe fails because the resident instance is not
// running, while another Strata (Bevan's test instance) listens on the machine. The machine's agent says so
// (extra.strata.listen with resident flags, from /proc + ss); the hub sends nothing to the test instance.
export function nodeState(probeTarget, probeSnap, machineSnap = null) {
  if (probeSnap && probeSnap.online !== false) return 'online';
  if (probeTarget?.always_on === false) return 'idle';
  if (testingPorts(machineSnap).length) return 'testing';
  return strataAlive(machineSnap) ? 'cut' : 'down';
}
// the machine's agent is up (pushing, not stale)
export function machineUp(m) {
  return !!m && m.online !== false && !m.stale;
}
export function strataAlive(m) {
  return machineUp(m) && Number(m.extra?.strata?.procs) > 0;
}
export function testingPorts(m) {
  const s = machineUp(m) ? m.extra?.strata : null;
  if (!s?.resident_unit || !Array.isArray(s.listen) || s.listen.some((x) => x?.resident)) return [];
  return s.listen.map((x) => Number(x?.port)).filter((p) => Number.isFinite(p) && p > 0);
}

// v2.45 the live view of one node (the nodes card's `live` target). nodeBusy is the board's 「推理中」 (moved here
// from nodes.js); liveSlots is how many of the server's slots are taken -- the 「N/M」 the board shows -- and whether
// all of them are (full). m26 runs one slot, so one long OpenClaw request fills it.
export function nodeBusy(state, lv) {
  return state === 'online' && !!lv?.reachable && Number(lv.busy) > 0;
}
export function liveSlots(state, lv) {
  if (state !== 'online' || !lv?.reachable) return null;
  const max = Number(lv.max_streams) || 1;
  const busy = nodeBusy(state, lv);
  const used = max > 1 ? Number(lv.running) || 0 : (busy ? 1 : 0);
  return { used, max, queued: Number(lv.queued) || 0, full: busy && used >= max };
}
// v2.45 why the daily health check (health-lite) leaves a node out, read off what the board shows; null = check it.
// None of these is a failure:
//   'testing' 测试中 (cyan, v2.44);
//   'off'     未开机 / 无服务 (grey: an always_on: false machine, e.g. the m133 laptop asleep or switched off);
//   'busy'    忙碌 (online and every slot taken).
export function healthSkip(state, slots) {
  if (state === 'testing') return 'testing';
  if (state === 'idle') return 'off';
  if (slots?.full) return 'busy';
  return null;
}
