// v2.50 ComfyUI / LLM nodes (BACKLOG 64) -- `npm test` (node --test).
//   detect / confirmStep / segments (server/roles.js): the role rules -- whichever runs; both up: the one at work,
//     else the one started last; neither: off with the role kept; a new state only after two detections in a row;
//   RoleTracker through simulated time on a scratch database: m136 switching ComfyUI -> LLM with an overlap, both
//     going off (role kept), the machine switched off, a hub restart in the middle (state, role, last values kept),
//     the timeline;
//   EndpointSet (server/endpoints.js): "host:*" entries;
//   engine.js: the follow ports from the agent's extra.llm (loopback-only ports never), the counter selectors of a
//     follow node, and which ports a follow node is asked on (none while its agent says no LLM runs, or it is off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const R = await import('../server/roles.js');
const { EndpointSet } = await import('../server/endpoints.js');
const E = await import('../server/engine.js');

const T0 = Date.UTC(2026, 10, 21, 4, 0, 0);   // 12:00 Beijing
const S = (ms) => Math.floor(ms / 1000);

// a machine snapshot as the hub keeps it, with the agent's extra.comfyui / extra.llm
function machine({ on = true, comfy = null, llm = null } = {}) {
  if (!on) return { online: false, stale: true, extra: {} };
  const extra = {};
  extra.comfyui = comfy ? { procs: 1, listen: [{ port: 8188, addr: '0.0.0.0' }], since: comfy.since } : { procs: 0, listen: [] };
  extra.llm = llm ? { procs: 1, engine: 'llamacpp', listen: [{ port: llm.port || 8080, addr: llm.addr || '0.0.0.0' }], api_port: llm.port || 8080,
    since: llm.since, busy: llm.busy ?? 0, model: 'qwen3.8-27b-q4' } : { procs: 0, listen: [] };
  return { online: true, stale: false, metrics: { vram_bytes: { display: '3.1/23.9G' } }, extra };
}

test('detect: whichever runs; both: the one at work, else the newer; neither: off', () => {
  const comfyIdle = { reachable: true, running: 0, pending: 0 }, comfyBusy = { reachable: true, running: 1, pending: 2 };
  const llmIdle = { reachable: true, busy: 0, queued: 0 }, llmBusy = { reachable: true, busy: 1, queued: 0 };
  const m = (c, l) => machine({ comfy: c ? { since: c } : null, llm: l ? { since: l } : null });
  assert.equal(R.detect({ machine: m(100, null), comfyNode: comfyIdle }).state, 'comfy');
  assert.equal(R.detect({ machine: m(null, 100), liveNode: llmIdle }).state, 'llm');
  // a process the hub cannot reach yet still counts (starting up, or the port blocked)
  assert.equal(R.detect({ machine: m(null, 100), liveNode: { reachable: false } }).state, 'llm');
  assert.equal(R.detect({ machine: m(100, 200), comfyNode: comfyBusy, liveNode: llmIdle }).why, 'busy-comfy');
  assert.equal(R.detect({ machine: m(200, 100), comfyNode: comfyIdle, liveNode: llmBusy }).why, 'busy-llm');
  assert.equal(R.detect({ machine: m(100, 200), comfyNode: comfyIdle, liveNode: llmIdle }).why, 'newer-llm');
  assert.equal(R.detect({ machine: m(300, 200), comfyNode: comfyIdle, liveNode: llmIdle }).why, 'newer-comfy');
  assert.equal(R.detect({ machine: m(100, 200), comfyNode: comfyBusy, liveNode: llmBusy }).state, 'llm');   // both at work: newer
  // the agent's own busy count (an engine the hub cannot read) counts as work too
  const ag = machine({ comfy: { since: 300 }, llm: { since: 100, busy: 1 } });
  assert.equal(R.detect({ machine: ag, comfyNode: comfyIdle, liveNode: { reachable: false } }).why, 'busy-llm');
  const none = R.detect({ machine: machine(), comfyNode: { reachable: false }, liveNode: { reachable: false } });
  assert.deepEqual([none.state, none.power], ['off', true]);
  const dark = R.detect({ machine: machine({ on: false }), comfyNode: { reachable: false } });
  assert.deepEqual([dark.state, dark.power], ['off', false]);
});

test('confirmStep: a new state only after two detections in a row', () => {
  const st = { state: 'comfy', cand: null, candN: 0 };
  assert.equal(R.confirmStep(st, 'llm'), null);
  assert.equal(R.confirmStep(st, 'comfy'), null);     // back: the candidate is dropped
  assert.equal(R.confirmStep(st, 'llm'), null);
  assert.equal(R.confirmStep(st, 'off'), null);       // a different one starts over
  assert.equal(R.confirmStep(st, 'llm'), null);
  assert.equal(R.confirmStep(st, 'llm'), 'llm');
});

test('segments: from the state at the start and the changes after it', () => {
  const segs = R.segments('comfy', [{ at: 50, state: 'comfy' }, { at: 150, state: 'llm' }, { at: 150, state: 'llm' }, { at: 260, state: 'off' }], 100, 300);
  assert.deepEqual(segs, [{ from: 100, to: 150, state: 'comfy' }, { from: 150, to: 260, state: 'llm' }, { from: 260, to: 300, state: 'off' }]);
  assert.deepEqual(R.segments('none', [{ at: 200, state: 'llm' }], 100, 300), [{ from: 100, to: 200, state: 'none' }, { from: 200, to: 300, state: 'llm' }]);
});

test('RoleTracker: m136 ComfyUI -> LLM with an overlap, off with the role kept, power off, a hub restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  const db = join(dir, 'h.db');
  const log = console.log; const lines = []; console.log = (s) => lines.push(String(s));
  try {
    const comfyT = { nodes: [{ id: 'm136', url: 'http://x:8188', llm: 'm136' }, { id: 'm999', url: 'http://y:8188' }] };
    const machines = new Map([['m136', { id: 'm136', badge: 'RTX 5090 Laptop' }]]);
    let tr = new R.RoleTracker(db);
    tr.configure(comfyT, machines);
    assert.equal(tr.has('m136'), true);
    assert.equal(tr.has('m999'), false);               // no `llm:` -> not tracked
    const nodesSnap = { extra: { nodes: { m136: { routes: [{ port: 4004, live: true, intended: true, at: ['192.168.1.136:8080'] }] } } } };
    let now = T0;
    let M = machine({ comfy: { since: S(T0) - 3600 } });
    let comfyNode = { reachable: true, running: 1, pending: 0, port: 8188, system: { version: '0.45.3', gpu: 'RTX 5090 Laptop', vram_total_gb: 23.9 } };
    let lv = { reachable: false, busy: 0, queued: 0 };
    const engine = { has: () => true, info: () => (lv.reachable ? { engine: 'llamacpp', name: 'llama.cpp', port: 8081, model: 'qwen3.8-27b-q4', error: null } : { engine: null, error: 'no port to ask' }) };
    const step = (n = 1) => {
      let v;
      for (let i = 0; i < n; i++) {
        now += R.EVAL_MS;
        v = tr.update({ now, comfyView: { nodes: { m136: comfyNode } }, machineOf: () => M, liveView: { nodes: { m136: lv } }, engine, nodesSnap });
      }
      return v.m136;
    };
    let v = step();
    assert.deepEqual([v.state, v.role, v.why], ['comfy', 'comfy', 'only-comfy']);   // first sighting: taken at once
    assert.equal(v.info.comfy_system.gpu, 'RTX 5090 Laptop');
    // the LLM starts while ComfyUI still generates: ComfyUI keeps the role
    M = machine({ comfy: { since: S(T0) - 3600 }, llm: { since: S(now), port: 8081 } });
    lv = { reachable: true, busy: 0, queued: 0 };
    v = step(3);
    assert.deepEqual([v.state, v.why], ['comfy', 'busy-comfy']);
    // ComfyUI finishes, idle; the LLM started later -> LLM, but only on the second detection
    comfyNode = { ...comfyNode, running: 0 };
    v = step();
    assert.deepEqual([v.state, v.cand, v.cand_n], ['comfy', 'llm', 1]);
    v = step();
    assert.deepEqual([v.state, v.role, v.why], ['llm', 'llm', 'newer-llm']);
    assert.equal(v.info.llm_model, 'qwen3.8-27b-q4');
    assert.equal(v.info.litellm_port, 4004);
    // litellm 4004 sends to :8080, the engine answers on :8081 -> reported (and logged), never changed
    assert.deepEqual(v.mismatch, { litellm: 4004, backend: 8080, engine: 8081 });
    assert.ok(lines.some((l) => /litellm 4004 sends to :8080, the engine answers on :8081/.test(l)));
    // ComfyUI closed: LLM alone
    M = machine({ llm: { since: S(now) - 30, port: 8081 } });
    comfyNode = { reachable: false };
    v = step(2);
    assert.deepEqual([v.state, v.why], ['llm', 'only-llm']);
    // a restart of the LLM: one detection without it does not flip the card
    const keepM = M; M = machine();
    lv = { reachable: false };
    v = step();
    assert.deepEqual([v.state, v.cand], ['llm', 'off']);
    M = keepM; lv = { reachable: true, busy: 1, queued: 0 };
    v = step();
    assert.deepEqual([v.state, v.cand], ['llm', null]);
    // both off: state off, the role stays LLM; last_on = the last detection with a service up
    const lastOn = now;
    M = machine(); lv = { reachable: false };
    v = step(2);
    assert.deepEqual([v.state, v.role, v.power, v.last_on], ['off', 'llm', 'on', lastOn]);
    // a hub restart: a new tracker on the same database keeps state, role and the last things seen
    tr = new R.RoleTracker(db);
    tr.configure(comfyT, machines);
    M = machine({ on: false });
    v = step();
    assert.deepEqual([v.state, v.role, v.last_on, v.power], ['off', 'llm', lastOn, 'off']);
    assert.equal(v.info.llm_model, 'qwen3.8-27b-q4');
    assert.equal(v.info.comfy_system.version, '0.45.3');
    // the timeline over the window: comfy, then llm, then off
    const tl = tr.timeline('m136', T0, now + 1);
    assert.deepEqual(tl.segments.map((s) => s.state), ['none', 'comfy', 'llm', 'off']);
    assert.ok(tl.segments.every((s, i, a) => i === 0 || s.from === a[i - 1].to));
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EndpointSet: exact entries and host:* (every port of that host)', () => {
  const s = new EndpointSet(['192.168.1.110:*', '192.168.1.26:12346']);
  assert.equal(s.has('192.168.1.110:8080'), true);
  assert.equal(s.has('192.168.1.110:1234'), true);
  assert.equal(s.has('192.168.1.26:12346'), true);
  assert.equal(s.has('192.168.1.26:12347'), false);
  assert.equal(s.has('192.168.1.11:8080'), false);
  assert.equal(s.size, 2);
  assert.equal(new EndpointSet().size, 0);
});

test('engine follow: the agent\'s ports (never loopback-only), the selectors, when a follow node is asked', () => {
  const c = { procs: 1, api_port: 8081, listen: [{ port: 9000, addr: '0.0.0.0' }, { port: 8081, addr: '0.0.0.0' }, { port: 5000, addr: '127.0.0.1' }] };
  assert.deepEqual(E.llmPorts(c), [8081, 9000]);
  assert.deepEqual(E.llmPorts({ procs: 1, api_port: 1234, listen: [{ port: 1234, addr: '127.0.0.1' }] }), []);
  assert.deepEqual(E.llmPorts({ procs: 0, listen: [] }), []);
  const sel = E.nodeCounters({ engine: { host: '192.168.1.110', ports: [8080], follow: 'm110' } });
  assert.ok(sel.tokens.every((x) => x.includes('instance=~"192\\\\.168\\\\.1\\\\.110:[0-9]+"')), sel.tokens[0]);
  const fixed = E.nodeCounters({ engine: { host: '192.168.1.26', ports: [12346] } });
  assert.ok(fixed.tokens[0].includes('(12346)'));
  const det = new E.EngineDetector(null, { env: {} });
  let snap = null;
  det.machineOf = () => snap;
  const n = { def: { id: 'm110', host: '192.168.1.110', ports: [8080], follow: 'm110' } };
  snap = { online: true, stale: false, extra: { llm: { procs: 0, listen: [] } } };
  assert.deepEqual(det.portsOf(n), []);                 // ComfyUI role: nothing asked
  snap = { online: false, stale: true, extra: {} };
  assert.deepEqual(det.portsOf(n), []);                 // machine off
  snap = { online: true, stale: false, extra: {} };
  assert.deepEqual(det.portsOf(n), [8080]);             // an agent that does not report LLM servers
  snap = { online: true, stale: false, extra: { llm: c } };
  assert.deepEqual(det.portsOf(n), [8081, 9000, 8080]);
  det.stop();
});
