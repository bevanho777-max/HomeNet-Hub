// v2.49 the inference node figures (server/collectors/nodes.js nodeFigures) through a simulated day --
// `npm test` (node --test). A fake Prometheus answers the hub's queries from a simulated server: it counts
// a request when the request FINISHES (as Strata does: m25 2026-11-13, the journal's "done:" lines match
// the counter one for one), Prometheus scrapes it every 15 s, LiteLLM logs a row 1 s after a request ends.
// The hub's live poll runs every minute. Checked at every poll:
//   - nothing is marked ("Counter error" is gone; the ≈ only where the figure is really uncertain),
//   - the figure never goes down (continuous),
//   - it never exceeds what the server really served by then (no request counted twice),
//   - once everything served has been scraped, it IS that (exact).
// Scenarios: a Strata restart like m25's at 06:54 (a request finishing after the last scrape, one STARTED
// after it, the restart, 3 minutes of failed scrapes, the new process serving before its first scrape),
// a counter reset with no failed scrape at all, 3 failed scrapes in a row, a 10-minute scrape outage (the
// ≈ shows, the figure keeps going), Prometheus itself unreadable, and the finished day (00:10).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = await import('../server/collectors/nodes.js');

const INST = '10.9.0.25:18090', JOB = 'strata_sim';
const SEL = {
  reqs: `strata:requests_total{instance="${INST}"}`,
  prompt: `llamacpp:prompt_tokens_total{instance="${INST}"}`,
  cached: `llamacpp:prompt_tokens_cached_total{instance="${INST}"}`,
  pred: `llamacpp:tokens_predicted_total{instance="${INST}"}`,
};
const NAME = { reqs: 'strata:requests_total', prompt: 'llamacpp:prompt_tokens_total', cached: 'llamacpp:prompt_tokens_cached_total', pred: 'llamacpp:tokens_predicted_total' };
const NODE = { id: 'sim', counters: { requests: [SEL.reqs], tokens: [SEL.prompt, SEL.cached, SEL.pred], net: [SEL.prompt, SEL.pred] } };
const D0 = 1794499200;                 // a Beijing midnight
const END = 4 * 3600 + 900;            // the simulated stretch after it
const SCRAPE0 = 10, STEP = 15;         // scrapes at D0 + 10 + 15k

// ── the simulated server ────────────────────────────────────────────
// processes: [from, to) -- the counter starts at 0 with each; between them nothing answers
const PROCS = [
  { from: D0 - 7200, to: D0 + 3622 },          // S1: stopped at 01:00:22 (after the 01:00:10 scrape)
  { from: D0 + 3822, to: D0 + 7215 },          //     back 200 s later (first scrape 01:03:55); S2: reset at 02:00:15
  { from: D0 + 7215, to: D0 + END + 3600 },    //     no failed scrape in between
];
const FAIL = [
  [D0 + 10805, D0 + 10850],                    // S3: 3 failed scrapes (03:00:10, :25, :40), the server fine
  [D0 + 12600, D0 + 13200],                    // S4: 10 minutes of failed scrapes, the server fine
];
const procAt = (t) => PROCS.find((p) => t >= p.from && t < p.to) || null;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const REQS = [];
const add = (st, dur, { via = 'll', prompt = 600 + Math.floor(rnd() * 300), cached = rnd() < 0.3 ? 400 : 0, completion = 30 + Math.floor(rnd() * 80) } = {}) =>
  REQS.push({ st, en: st + dur, via, prompt, cached, completion });
const quiet = [[3590, 3840], [7190, 7240]].map(([a, b]) => [D0 + a, D0 + b]);
for (let t = D0 - 7000; t < D0 + END - 300; t += 37) {
  if (t < D0 && t + 200 > D0) continue;                         // (nothing across midnight)
  if (quiet.some(([a, b]) => t + 200 > a && t < b)) continue;
  // every ninth a long one (150 s: what made v2.48 read "counter low" right after it finished)
  add(t, Math.floor(t / 37) % 9 === 0 ? 150 : 6 + Math.floor(rnd() * 4));
}
for (let t = D0 + 200; t < D0 + END - 300; t += 330) if (!quiet.some(([a, b]) => t + 10 > a && t < b)) add(t, 5, { via: 'direct' });
// S1, m25 06:54 exactly: A started before the last scrape (01:00:10) and ended after it; B STARTED after
// it and ended before the stop (01:00:22) -- v2.48 lost B; one cut off by the stop (LiteLLM: failed);
// the new process serves one before its first scrape (in x there: must not be put back too)
add(D0 + 3604, 7, { prompt: 726, cached: 0, completion: 52 });     // A
add(D0 + 3612, 8, { prompt: 749, cached: 0, completion: 65 });     // B
add(D0 + 3615, 15);                                                 // cut off at 01:00:22
add(D0 + 3823, 7);                                                  // new process, before 01:03:55
// S2: C ends after the 02:00:10 scrape, the counter resets at 02:00:15 (no failed scrape), D is the new
// process' first request, in its first scrape (02:00:25)
add(D0 + 7205, 8);                                                  // C
add(D0 + 7216, 6);                                                  // D
REQS.sort((a, b) => a.st - b.st);
for (const r of REQS) {
  const p = procAt(r.st);
  r.served = !!p && procAt(r.en) === p;
  r.proc = r.served ? p : null;
  r.tokens = r.prompt + r.completion;
  r.net = r.prompt - r.cached + r.completion;
}

// the scrapes
const series = new Map();      // selector -> { metric, values: [[t, v]] }
const up = [];
for (const k of Object.keys(SEL)) series.set(SEL[k], { metric: { __name__: NAME[k], instance: INST, job: JOB }, values: [] });
const upSel = `up{instance="${INST}",job="${JOB}"}`;
series.set(upSel, { metric: { __name__: 'up', instance: INST, job: JOB }, values: up });
for (let s = D0 - 7200 + SCRAPE0; s <= D0 + END + 600; s += STEP) {
  const p = procAt(s);
  if (!p || FAIL.some(([a, b]) => s >= a && s < b)) { up.push([s, '0']); continue; }
  up.push([s, '1']);
  const done = REQS.filter((r) => r.proc === p && r.en <= s);
  const sum = (f) => String(done.reduce((a, r) => a + f(r), 0));
  series.get(SEL.reqs).values.push([s, String(done.length)]);
  series.get(SEL.prompt).values.push([s, sum((r) => r.prompt - r.cached)]);
  series.get(SEL.cached).values.push([s, sum((r) => r.cached)]);
  series.get(SEL.pred).values.push([s, sum((r) => r.completion)]);
}
const lastOkScrape = (t) => { let x = null; for (const [s, v] of up) { if (s > t) break; if (v === '1') x = s; } return x; };
const scrapeOkAt = (t) => { let x = null; for (const [s, v] of up) { if (s > t) break; x = v === '1'; } return x; };

// LiteLLM: one row per request through it, logged 1 s after it ends; failed requests are rows too (ok = 0)
const ROWS = REQS.filter((r) => r.via === 'll').map((r) => ({
  st: r.st, en: r.en, minute: Math.floor(r.st / 60) * 60, node: 'sim', type: 'chat', ok: r.served,
  tokens: r.served ? r.tokens : 0, net: r.served ? r.net : 0,
}));
const rowsAt = (t) => ROWS.filter((r) => r.en + 1 <= t);
// what the server really served by t, today
const truth = (t) => {
  const d = REQS.filter((r) => r.served && r.st >= D0 && r.en <= t);
  return { reqs: d.length, tokens: d.reduce((a, r) => a + r.tokens, 0), net: d.reduce((a, r) => a + r.net, 0) };
};

// ── the fake Prometheus ─────────────────────────────────────────────
let promDown = false;
let server, PROM;
const inRange = (vals, a, b) => vals.filter(([t]) => t > a && t <= b);
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('query') || '';
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (promDown) return send(503, { status: 'error', error: 'simulated outage' });
    let m, result;
    if ((m = q.match(/^last_over_time\((.+)\[(\d+)([hd])\] @ (\d+)\)$/))) {
      const s = series.get(m[1]); const at = Number(m[4]); const span = Number(m[2]) * (m[3] === 'h' ? 3600 : 86400);
      const v = s ? inRange(s.values, at - span, at).at(-1) : null;
      result = v ? [{ metric: s.metric, value: [at, v[1]] }] : [];
    } else if (/^min_over_time\(homenet_llama_/.test(q)) result = [];
    else if ((m = q.match(/^(.+)\[(\d+)s\] @ (\d+)$/))) {
      const s = series.get(m[1]); const at = Number(m[3]);
      const vals = s ? inRange(s.values, at - Number(m[2]), at) : [];
      result = vals.length ? [{ metric: s.metric, values: vals }] : [];
    } else return send(400, { status: 'error', error: `unsupported query ${q}` });
    return send(200, { status: 'success', data: { resultType: 'x', result } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PROM = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// the hub's live poll at t (collectNodes passes the same: engine up = a process answers, Prometheus' target health)
const poll = (t, memo = null) => N.nodeFigures(PROM, NODE, D0, t, rowsAt(t), {
  nowSec: t, nodeUp: !!procAt(t), memo,
  health: new Map([[INST, { health: scrapeOkAt(t) === false ? 'down' : 'up', error: scrapeOkAt(t) === false ? 'connection refused' : null }]]),
});
// everything served by t has been scraped (and logged): the figure must be exact
const settled = (t) => {
  const ok = lastOkScrape(t);
  return ok != null && REQS.every((r) => !(r.served && r.st >= D0 && r.en <= t) || (r.en <= ok - 2 && r.en + 1 <= t));
};

async function run(from, to, { memo = null, down = null, step = 60 } = {}) {
  const out = [];
  let prev = null;
  for (let t = D0 + from; t <= D0 + to; t += step) {
    promDown = !!(down && t >= D0 + down[0] && t < D0 + down[1]);
    const f = await poll(t + 7, memo);
    const tr = truth(t + 7);
    out.push({ t: t + 7, f, tr, settled: settled(t + 7) });
    for (const key of ['reqs', 'tokens', 'net']) {
      const v = f.metrics[key];
      assert.equal(typeof v, 'number', `${key} has a figure at +${t - D0}`);
      if (prev) assert.ok(v >= prev.metrics[key], `${key} went down at +${t - D0}: ${prev.metrics[key]} -> ${v}`);
      assert.ok(v <= tr[key], `${key} above what was served at +${t - D0}: ${v} > ${tr[key]} (counted twice)`);
    }
    prev = f;
  }
  promDown = false;
  return out;
}
const marksOf = (f) => Object.entries(f.kinds).filter(([, k]) => k.mark || k.error).map(([key, k]) => `${key}:${(k.mark || k.error).code}`);

test('Strata restart (m25 2026-11-13 06:54): continuous, every request once, nothing marked, exact once scraped', async () => {
  const out = await run(60, 3600 + 1200);
  for (const o of out) assert.deepEqual(marksOf(o.f), [], `marked at +${o.t - D0}`);
  for (const o of out.filter((x) => x.settled)) assert.deepEqual({ reqs: o.f.metrics.reqs, tokens: o.f.metrics.tokens, net: o.f.metrics.net }, o.tr, `exact at +${o.t - D0}`);
  // after the restart is seen: A and B put back (B is the one v2.48 lost), the stop told by the failed scrape
  const o = out.find((x) => x.t > D0 + 3900);
  const r = o.f.kinds.reqs.restarts;
  assert.equal(r.length, 1);
  assert.equal(r[0].p, D0 + 3610);
  assert.equal(r[0].cut, D0 + 3625);
  assert.equal(r[0].lost, 2);
  assert.equal(o.f.kinds.tokens.restarts[0].lost, 726 + 52 + 749 + 65);
  assert.ok(out.filter((x) => x.settled && x.t > D0 + 3840).length > 5, 'settled polls after the restart');
});

test('counter reset with no failed scrape: the request after the last scrape put back, the new process\' first not twice', async () => {
  const out = await run(7000, 7800);
  for (const o of out) assert.deepEqual(marksOf(o.f), [], `marked at +${o.t - D0}`);
  for (const o of out.filter((x) => x.settled)) assert.deepEqual({ reqs: o.f.metrics.reqs, tokens: o.f.metrics.tokens, net: o.f.metrics.net }, o.tr);
  const rs = out.at(-1).f.kinds.reqs.restarts.filter((x) => x.p >= D0 + 7000);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].cut, rs[0].q, 'no failed scrape: the stop is not known');
  assert.equal(rs[0].lost, 1, 'C only (D is in the new counter)');
});

test('3 failed scrapes in a row (server fine): continuous, nothing marked, exact once scraped again', async () => {
  // (every 15 s here: whatever second of the minute the hub polls at)
  const out = await run(10500, 11400, { step: 15 });
  assert.ok(out.filter((o) => scrapeOkAt(o.t) === false).length >= 3, 'polls fell inside the failed scrapes');
  for (const o of out) assert.deepEqual(marksOf(o.f), [], `marked at +${o.t - D0}`);
  for (const o of out.filter((x) => x.settled)) assert.deepEqual({ reqs: o.f.metrics.reqs, tokens: o.f.metrics.tokens, net: o.f.metrics.net }, o.tr);
});

test('10 minutes of failed scrapes: the figure keeps going from LiteLLM with a ≈ (stale), exact again after', async () => {
  const out = await run(12300, 13800);
  const marked = out.filter((o) => marksOf(o.f).length);
  assert.ok(marked.length >= 6, `≈ while the counter is over 2 minutes old (${marked.length})`);
  for (const o of marked) {
    assert.ok(o.t >= D0 + 12600 + 120 && o.t <= D0 + 13200 + 60, `marked only during the outage (+${o.t - D0})`);
    assert.equal(o.f.kinds.reqs.mark.code, 'stale');
    assert.equal(o.f.kinds.reqs.mark.why, 'down');
    assert.equal(o.f.kinds.reqs.mark.source, 'ctr+ll');
  }
  // it kept counting (LiteLLM's requests) through the outage
  const inside = out.filter((o) => o.t > D0 + 12900 && o.t < D0 + 13200);
  assert.ok(inside.at(-1).f.metrics.reqs > inside[0].f.metrics.reqs);
  for (const o of out.filter((x) => x.settled)) assert.deepEqual({ reqs: o.f.metrics.reqs, tokens: o.f.metrics.tokens, net: o.f.metrics.net }, o.tr);
});

test('Prometheus unreadable for 5 minutes: the last figure + LiteLLM since, a ≈ (read), exact again after', async () => {
  const memo = new Map();
  const out = await run(13800, 14700, { memo, down: [14100, 14400] });
  const during = out.filter((o) => o.t >= D0 + 14100 && o.t < D0 + 14400);
  assert.ok(during.length >= 4);
  for (const o of during) { assert.equal(o.f.kinds.reqs.mark?.code, 'read'); assert.equal(o.f.kinds.reqs.mark?.source, 'last+ll'); }
  for (const o of out.filter((x) => x.t >= D0 + 14400)) assert.deepEqual(marksOf(o.f), []);
  // (during the outage it is an estimate -- a direct request waits for the counter -- so exact only before and after)
  for (const o of out.filter((x) => x.settled && (x.t < D0 + 14100 || x.t >= D0 + 14400))) {
    assert.deepEqual({ reqs: o.f.metrics.reqs, tokens: o.f.metrics.tokens, net: o.f.metrics.net }, o.tr, `exact at +${o.t - D0}`);
  }
});

test('the finished stretch, as 00:10 computes a day: exact, nothing marked', async () => {
  const end = D0 + END;
  const f = await N.nodeFigures(PROM, NODE, D0, end, ROWS, { nowSec: end + 600 });
  assert.deepEqual(marksOf(f), []);
  assert.deepEqual({ reqs: f.metrics.reqs, tokens: f.metrics.tokens, net: f.metrics.net }, truth(end));
  assert.equal(f.kinds.reqs.restarts.length, 2);
});

test('the board never says "Counter error" again', () => {
  const files = ['web/i18n.js', ...readdirSync(join(ROOT, 'web/renderers')).map((f) => `web/renderers/${f}`)];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/'Counter error'|'计数来源异常'|node_ctr_err|abbr_ctr_err/.test(s), f);
  }
});
