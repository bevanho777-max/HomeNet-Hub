// v2.48.1 config tolerance (server/config/tolerate.js) -- `npm test` (node --test).
// Four cases from the request: an unknown target type, an unknown card type, an unknown field, broken YAML;
// plus: a format error is still refused, a hot reload of a bad file keeps the old config, and the check mode
// (server/config/check.js) answers with the right exit code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'hnh-tolerate-'));
process.env.CONFIG_DIR = DIR;              // read by loader.js at import, so set before importing it
const { loadConfig } = await import('../server/config/loader.js');
const { ConfigStore } = await import('../server/config/watch.js');
const { validate, crossValidate } = await import('../server/config/schema.js');

const METRICS = `metrics:
  cpu: { label: CPU, unit: "%", thresholds: { warn: 80, danger: 95 } }
`;
const TARGETS = `targets:
  - id: box
    name: Box
    source: { type: http, url: "http://127.0.0.1:9/stats", interval: 5s }
    map: { cpu: "$.cpu" }
  - id: other
    name: Other
    source: { type: http, url: "http://127.0.0.1:9/other" }
    map: { cpu: "$.cpu" }
`;
const LAYOUT = `status_bar: { targets: [box, other] }
grid:
  - { type: machine, target: box, rings: [cpu], items: [cpu] }
  - { type: machine, target: other, rings: [cpu], items: [cpu] }
history: { selectable_targets: [box, other], default: [box] }
`;
const write = ({ metrics = METRICS, targets = TARGETS, layout = LAYOUT } = {}) => {
  writeFileSync(join(DIR, 'metrics.yaml'), metrics);
  writeFileSync(join(DIR, 'targets.yaml'), targets);
  writeFileSync(join(DIR, 'layout.yaml'), layout);
  writeFileSync(join(DIR, 'theme.yaml'), 'font_family: "Inter"\n');
};
// the loaded config must pass this version's strict checks on its own
const strictOk = (c) => {
  for (const k of ['metrics', 'targets', 'layout']) assert.deepEqual(validate(k, c[k]), { ok: true }, k);
  assert.deepEqual(crossValidate(c), { ok: true });
};

before(() => write());
after(() => rmSync(DIR, { recursive: true, force: true }));

test('baseline: a config this version knows loads with no warnings', () => {
  write();
  const c = loadConfig();
  assert.deepEqual(c.warnings, []);
  assert.equal(c.targets.targets.length, 2);
  strictOk(c);
});

test('unknown target type: the target is skipped, what draws it becomes a placeholder, the rest is untouched', () => {
  write({
    targets: `${TARGETS}  - id: vps_new
    name: VPS
    source: { type: kiwivm_v9, interval: 5m }
    map: { traffic: "$.used" }
`,
    layout: `status_bar: { targets: [box, vps_new, other] }
grid:
  - { type: machine, target: box, rings: [cpu], items: [cpu] }
  - { type: service, target: vps_new, items: [traffic] }
  - { type: machine, target: other, rings: [cpu], items: [cpu] }
history: { selectable_targets: [box, vps_new, other], default: [box], panes: [box, vps_new] }
`,
  });
  const c = loadConfig();
  assert.deepEqual(c.targets.targets.map((t) => t.id), ['box', 'other']);
  assert.deepEqual(c.skipped_targets, [{ id: 'vps_new', type: 'kiwivm_v9' }]);
  assert.deepEqual(c.layout.grid[1], { type: 'unsupported', unsupported_type: 'kiwivm_v9', target: 'vps_new' });
  assert.equal(c.layout.grid[0].type, 'machine');
  assert.equal(c.layout.grid[2].type, 'machine');
  assert.deepEqual(c.layout.status_bar.targets, ['box', 'other']);
  assert.deepEqual(c.layout.history.selectable_targets, ['box', 'other']);
  assert.deepEqual(c.layout.history.panes, ['box']);
  assert.ok(c.warnings.some((w) => w.includes('"vps_new" skipped') && w.includes('kiwivm_v9')));
  strictOk(c);
});

test('unknown card type: a placeholder in the same slot, the other cards untouched', () => {
  write({
    layout: `grid:
  - { type: machine, target: box, rings: [cpu], items: [cpu] }
  - { type: hologram, target: box, title: "3D", span: 2 }
  - { type: machine, target: other, rings: [cpu], items: [cpu] }
`,
  });
  const c = loadConfig();
  assert.equal(c.layout.grid.length, 3);
  assert.deepEqual(c.layout.grid[1], { type: 'unsupported', unsupported_type: 'hologram', target: 'box', title: '3D' });
  assert.deepEqual(c.unsupported_cards, [{ index: 1, type: 'hologram', target: 'box' }]);
  assert.equal(c.layout.grid[0].target, 'box');
  assert.equal(c.layout.grid[2].target, 'other');
  assert.equal(c.targets.targets.length, 2);
  strictOk(c);
});

test('unknown field: ignored with a warning where the schema forbids unknown fields; accepted as before elsewhere', () => {
  write({
    metrics: `metrics:
  cpu: { label: CPU, unit: "%", thresholds: { warn: 80, danger: 95, critical: 99 } }
`,
    targets: `targets:
  - id: box
    name: Box
    future_flag: true
    source: { type: http, url: "http://127.0.0.1:9/stats", future_option: 3 }
    map: { cpu: "$.cpu" }
    when_down: { note: "off", note_style: dim }
  - id: other
    name: Other
    source: { type: http, url: "http://127.0.0.1:9/other" }
    map: { cpu: "$.cpu" }
`,
  });
  const c = loadConfig();
  assert.deepEqual(c.metrics.metrics.cpu.thresholds, { warn: 80, danger: 95 });
  assert.deepEqual(c.targets.targets[0].when_down, { note: 'off' });
  assert.equal(c.targets.targets[0].future_flag, true);          // targets allow extra fields: untouched
  assert.equal(c.targets.targets[0].source.future_option, 3);    // so does source
  assert.equal(c.warnings.length, 2);
  assert.ok(c.warnings.some((w) => w.includes('"critical"')));
  assert.ok(c.warnings.some((w) => w.includes('"note_style"')));
  assert.equal(c.targets.targets.length, 2);
  strictOk(c);
});

test('broken YAML: still refused; a hot reload keeps the previous config', () => {
  write();
  const store = new ConfigStore();
  store.current = loadConfig();                // (start() would also open a file watcher)
  const good = store.current.etag;
  writeFileSync(join(DIR, 'layout.yaml'), 'grid:\n  - { type: machine, target: box\n   rings: [cpu');
  assert.throws(() => loadConfig(), /YAML syntax error in layout\.yaml/);
  const origLog = console.log; console.log = () => {};
  try { store._reload('test'); } finally { console.log = origLog; }
  assert.equal(store.current.etag, good);
  assert.ok(store.lastError && store.lastError.errors.some((e) => /YAML syntax error/.test(e)));
  write();
});

test('format errors are still refused: a required field missing, a wrong type, a dangling target id', () => {
  write({ targets: TARGETS.replace('    source: { type: http, url: "http://127.0.0.1:9/other" }\n', '    source: { type: http }\n') });
  assert.throws(() => loadConfig(), (e) => e.errors.some((x) => /must have required property 'url'/.test(x)));
  write({ targets: TARGETS.replace('interval: 5s', 'interval: 5') });
  assert.throws(() => loadConfig(), (e) => e.errors.some((x) => /interval must be string/.test(x)));
  write({ layout: LAYOUT.replace('target: other, rings', 'target: nosuch, rings') });
  assert.throws(() => loadConfig(), (e) => e.errors.some((x) => /unknown target id "nosuch"/.test(x)));
  write();
});

test('check mode: exit 0 with the warnings for a newer config, exit 1 with the errors for a broken one', () => {
  const run = () => spawnSync(process.execPath, [join(ROOT, 'server/config/check.js')], { env: { ...process.env, CONFIG_DIR: DIR }, encoding: 'utf8' });
  write({ layout: LAYOUT.replace('history:', '  - { type: hologram }\nhistory:') });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  let j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.unsupported_cards.length, 1);
  write({ targets: 'targets: [ { id: box' });
  r = run();
  assert.equal(r.status, 1);
  j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.ok(j.errors.some((e) => /YAML syntax error in targets\.yaml/.test(e)));
  write();
});
