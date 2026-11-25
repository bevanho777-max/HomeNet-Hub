// v2.52 「hub 监测项错误」 (BACKLOG 69) -- `npm test` (node --test).
//   TargetErrors (server/target_errors.js): which monitored items are in an error state and since when, with the
//   board's exclusions -- a machine that is off, a service that runs only when opened and is not running, 测试中 --
//   and the KiwiVM card's API errors (the card stays online on its last good data: the 11-24 / 11-25 case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TargetErrors } from '../server/target_errors.js';

const H = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

const T = {
  m27: { id: 'm27', name: 'm27', source: { type: 'http_push' } },
  m110: { id: 'm110', name: 'm110', always_on: false, source: { type: 'http_push' } },
  m25: { id: 'm25', name: 'm25', source: { type: 'http_push' } },
  hermes: { id: 'svc_hermes27', name: 'Hermes', source: { type: 'http', url: 'http://192.168.1.27:9119/' } },
  comfy110: { id: 'svc_comfy110', name: 'ComfyUI 110', machine: 'm110', always_on: false, source: { type: 'http', url: 'http://192.168.1.110:8188/' } },
  oc: { id: 'svc_openclaw', name: 'OpenClaw', source: { type: 'http', url: 'http://192.168.1.24:18789/readyz' } },
  vps: { id: 'vps_bwg', name: '搬瓦工 VPS', source: { type: 'kiwivm' } },
  nodes: { id: 'nodes', name: '推理节点', source: { type: 'inference_nodes' } },
};
const up = { online: true, stale: false, extra: {} };
const off = { online: false, stale: true, error: 'no push (stale)', since: NOW - 5 * H };
const bindings = [{ target: 'm27', ip: '192.168.1.27' }, { target: 'm110', ip: '192.168.1.110' }, { target: 'm25', ip: '192.168.1.25' }];

test('KiwiVM API error: counted from err_since even though the card stays online', () => {
  const te = new TargetErrors();
  const vps = { online: true, extra: { vps: { api: { ok: false, err: 'getLiveServiceInfo: KiwiVM error 700005: Authentication failure', err_at: NOW - 60000, err_since: NOW - 29 * H } } } };
  const r = te.compute({ targets: [T.vps], snap: { vps_bwg: vps }, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'api');
  assert.equal(r.items[0].since, NOW - 29 * H);
  assert.equal(r.items[0].duration_s, 29 * 3600);
  assert.match(r.items[0].error, /700005/);
  const ok = te.compute({ targets: [T.vps], snap: { vps_bwg: { online: true, extra: { vps: { api: { ok: true } } } } }, now: NOW });
  assert.equal(ok.items.length, 0);
});

test('machine off: its services and the machine itself are not errors; machine up: a down service is', () => {
  const te = new TargetErrors();
  const svcDown = { online: false, error: 'timeout', since: NOW - 2 * H };
  let r = te.compute({ targets: [T.m27, T.hermes], snap: { m27: off, svc_hermes27: svcDown }, bindings, now: NOW });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.excluded.map((x) => x.id).sort(), ['m27', 'svc_hermes27']);
  r = te.compute({ targets: [T.m27, T.hermes], snap: { m27: up, svc_hermes27: svcDown }, bindings, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'svc_hermes27');
  assert.equal(r.items[0].since, NOW - 2 * H);
});

test('on demand (always_on: false): not running / unreachable is not an error, another error is', () => {
  const te = new TargetErrors();
  let r = te.compute({ targets: [T.m110, T.comfy110], snap: { m110: up, svc_comfy110: { online: false, error: 'connect ECONNREFUSED 192.168.1.110:8188', since: NOW - 3 * H } }, bindings, now: NOW });
  assert.deepEqual(r.items, []);
  r = te.compute({ targets: [T.m110, T.comfy110], snap: { m110: up, svc_comfy110: { online: false, error: 'HTTP 401', since: NOW - 3 * H } }, bindings, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].error, 'HTTP 401');
  r = te.compute({ targets: [T.m110, T.comfy110], snap: { m110: off, svc_comfy110: { online: false, error: 'HTTP 401', since: NOW - 3 * H } }, bindings, now: NOW });
  assert.deepEqual(r.items, []);
});

test('no start time of its own: timed from when the hub first saw it, forgotten once it clears', () => {
  const te = new TargetErrors();
  const snap = (errs) => ({ nodes: { online: true, extra: { route_errors: errs, nodes: {} } } });
  let r = te.compute({ targets: [T.nodes], snap: snap([{ port: 4003, error: 'HTTP 401' }]), now: NOW });
  assert.equal(r.items[0].since, NOW);
  r = te.compute({ targets: [T.nodes], snap: snap([{ port: 4003, error: 'HTTP 401' }]), now: NOW + 2 * H });
  assert.equal(r.items[0].since, NOW);
  assert.equal(r.items[0].duration_s, 7200);
  te.compute({ targets: [T.nodes], snap: snap([]), now: NOW + 3 * H });
  r = te.compute({ targets: [T.nodes], snap: snap([{ port: 4003, error: 'HTTP 401' }]), now: NOW + 4 * H });
  assert.equal(r.items[0].since, NOW + 4 * H);
});

test('counters: a scrape down on an always-on node counts; on an on-demand node a missing / refused scrape does not', () => {
  const te = new TargetErrors();
  const kinds = (why, detail) => ({ reqs: { mark: { code: 'stale', why, detail, since: (NOW - 2 * H) / 1000 } }, tokens: { mark: { code: 'stale', why, detail, since: (NOW - 2 * H) / 1000 } } });
  const snap = {
    m25: up, m110: up,
    nodes: { online: true, extra: { route_errors: [], nodes: {
      m25: { counters: { kinds: kinds('down', 'server returned HTTP status 401 Unauthorized') } },
      m110: { counters: { kinds: kinds('down', 'dial tcp 192.168.1.110:8080: connect: connection refused') } },
    } } },
  };
  const r = te.compute({ targets: [T.m25, T.m110, T.nodes], snap, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'counter');
  assert.match(r.items[0].error, /^m25 .*401.*\(reqs \/ tokens\)$/);
  assert.equal(r.items[0].since, NOW - 2 * H);
});

test('refused pushes count while they go on; a stale alert does not; a refused config reload counts', () => {
  const te = new TargetErrors();
  const alerts = new Map([['m25', { ip: '192.168.1.28', hostname: 'aiserver02', at: NOW - 60000, first: NOW - 3 * H, count: 5400 }]]);
  let r = te.compute({ targets: [T.m25], snap: { m25: up }, alerts, now: NOW });
  assert.equal(r.items[0].kind, 'push');
  assert.equal(r.items[0].since, NOW - 3 * H);
  alerts.get('m25').at = NOW - H;
  r = te.compute({ targets: [T.m25], snap: { m25: up }, alerts, now: NOW });
  assert.deepEqual(r.items, []);
  r = te.compute({ targets: [T.oc], snap: { svc_openclaw: up }, configError: { at: new Date(NOW - 2 * H).toISOString(), errors: ['targets.yaml: bad indentation', 'x'] }, now: NOW });
  assert.equal(r.items[0].kind, 'config');
  assert.equal(r.items[0].since, NOW - 2 * H);
  assert.match(r.items[0].error, /等 2 项$/);
});
