// Inference-node state rules (v2.44: moved here from nodes.js unchanged). One set of rules is shared by the board
// (nodes.js, app.js) and the hub's GET /api/node-states, which is how health-lite learns that a node is 测试中.
// No imports: server/index.js loads this file too.
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
export function strataAlive(m) {
  return !!m && m.online !== false && !m.stale && Number(m.extra?.strata?.procs) > 0;
}
export function testingPorts(m) {
  const s = m && m.online !== false && !m.stale ? m.extra?.strata : null;
  if (!s?.resident_unit || !Array.isArray(s.listen) || s.listen.some((x) => x?.resident)) return [];
  return s.listen.map((x) => Number(x?.port)).filter((p) => Number.isFinite(p) && p > 0);
}
