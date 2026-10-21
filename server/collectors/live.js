// live.js (v2.25, streams v2.26) — what each inference server is doing RIGHT NOW, read from
// the server itself every ~2 s. Not through Prometheus: the servers' token counters only
// move when a request ENDS, Prometheus scrapes on its own clock and a rate() needs two
// samples, so the Prometheus path is minutes late. That path stays, for history and
// reconciliation.
//
// One small GET per node per poll, 1 s timeout, exponential backoff while a node does not
// answer (m110 is switched off a lot), never more than one request in flight per node.
//
// v2.26: a server can run several requests at once (Strata `"parallel": N`, llama.cpp
// `-np N`). Each one is a STREAM with its own phase, decoded count and speed, in a fixed
// row of M cells (M = the server's slot count, read from the server). Nothing per stream
// is ever derived from a node total: a value the server does not report per stream is
// null ("—" on the card).
//   llama.cpp  GET /slots (~1.3 KB, ~2 ms even mid-prefill): M = number of slots; per slot
//              is_processing, id_task, n_prompt_tokens (context so far), n_prompt_tokens_
//              processed (moves per batch), next_token[0].n_decoded (per token), and the
//              request's params.n_predict (its max tokens, when set).
//              + GET /metrics at the start of a lone request and when it starts decoding:
//              this build flushes prompt_tokens_total / prompt_seconds_total at the batch
//              that produces the first output, so the two readings give its exact prefill.
//   Strata     idle: GET /v1/status (~1.2 KB, no generated text): activity.in_flight,
//              concurrency.serving (= M) and last_timings (the last request's exact
//              prompt_per_second / predicted_per_second).
//              busy: GET /metrics (~14 KB, a few ms): live.parallel (M), live.running,
//              live.slots[] (per batch slot: state reading|generating|idle, prompt_tokens,
//              prompt_read while reading, generated, elapsed_s; idle: held_tokens), and
//              requests[] (newest first: each finished request's prompt_read, prompt_ms,
//              decode_tok_s). A request running ALONE takes Strata's solo path, outside the
//              slots: it is the top-level live.* (phase, generated, prompt_tokens,
//              max_tokens, prompt_read, elapsed_s), shown in the first free cell. Per-slot
//              max_tokens is not reported, so a slot stream has no progress bar.
//
// Decode speed of a stream = increase of its decoded-token count between readings ÷ the
// time between them, over the last ~10 s. A node's decode = the sum over its streams. The
// value a finished request leaves behind ("last") is the server's own record when there is
// one (Strata), else the hub's mean over the observed decode.
const WINDOW_MS = 10000;
const BACKOFF_MAX_MS = 30000;
const MIN_PREFILL_TOKENS = 32;      // a (nearly) fully cached prompt has no meaningful speed
const MAX_STREAMS = 16;             // a sanity cap on what a server may claim
const IDLE_METRICS_MS = 30000;      // Strata idle: refresh the per-slot view this often

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const int = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : null; };

async function getJson(url, headers, timeoutMs) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function promText(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    const [k, v] = line.trim().split(/\s+/);
    const n = Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function freshState() {
  return {
    reachable: null, fails: 0, nextAt: 0, err: null, at: 0,
    maxStreams: 1, tasks: new Map(), held: [], queued: 0,
    last: null, lastPrefill: null, lastRecAt: 0,
  };
}

/** speed over the readings in the last WINDOW_MS (needs two of them) */
function windowRate(readings) {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  let first = readings[0];
  for (const r of readings) { if (last.t - r.t <= WINDOW_MS) { first = r; break; } }
  if (first === last) first = readings[readings.length - 2];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.n - first.n) / dt : null;
}

function meanRate(readings) {
  if (readings.length < 2) return null;
  const a = readings[0], b = readings[readings.length - 1];
  const dt = (b.t - a.t) / 1000;
  return dt > 0 ? (b.n - a.n) / dt : null;
}

function push(arr, t, n) {
  if (!arr.length || arr[arr.length - 1].n !== n) arr.push({ t, n });
  if (arr.length > 400) arr.splice(0, arr.length - 400);
}

export class LiveCollector {
  constructor({ env }) {
    this.env = env;
    this.nodes = new Map();         // node id -> { def, st }
  }

  configure(target, nodesTarget, { timeoutMs = 1000, maxAgeMs = 600000 } = {}) {
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.maxAgeMs = maxAgeMs;
    const next = new Map();
    for (const n of nodesTarget?.nodes || []) {
      if (!n.live?.url || !n.live?.kind) continue;
      next.set(n.id, { def: { id: n.id, ...n.live }, st: this.nodes.get(n.id)?.st || freshState() });
    }
    this.nodes = next;
  }

  async poll() {
    const now = Date.now();
    await Promise.all([...this.nodes.values()].map((n) => this._pollNode(n, now)));
    return this.view(now);
  }

  async _pollNode(n, now) {
    const { def, st } = n;
    if (now < st.nextAt) return;               // backing off
    try {
      if (def.kind === 'llamacpp') await this._llamacpp(def, st, now);
      else if (def.kind === 'strata') await this._strata(def, st, now);
      st.reachable = true; st.fails = 0; st.nextAt = 0; st.err = null; st.at = now;
    } catch (e) {
      // Unreachable is not "idle": requests in flight are unknown, so they are dropped
      // rather than finalized with a made-up end.
      st.fails += 1;
      st.reachable = false; st.queued = 0; st.tasks.clear();
      st.err = String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 120);
      st.nextAt = now + Math.min(2000 * 2 ** st.fails, BACKOFF_MAX_MS);
    }
  }

  /** one observation of a running stream; `obs` = { key, cell, phase, gen, prompt, read, max, elapsed } */
  _observe(st, now, obs, seen) {
    seen.add(obs.key);
    let task = st.tasks.get(obs.key);
    // the same slot running a NEW request: its counters went backwards
    if (task && ((obs.gen != null && obs.gen < (task.gen ?? 0)) || (obs.elapsed != null && task.elapsed != null && obs.elapsed + 0.5 < task.elapsed))) {
      this._end(st, task, now);
      task = null;
    }
    if (!task) {
      task = { key: obs.key, first: now, start: obs.elapsed != null ? now - obs.elapsed * 1000 : now, pp: [], dec: [], prefill: null };
      st.tasks.set(obs.key, task);
    }
    Object.assign(task, { cell: obs.cell, phase: obs.phase, gen: obs.gen, prompt: obs.prompt, read: obs.read, max: obs.max, elapsed: obs.elapsed });
    if (obs.phase === 'prefill' && Number.isFinite(obs.read) && obs.read > 0) push(task.pp, now, obs.read);
    if (obs.phase === 'decode' && Number.isFinite(obs.gen)) {
      push(task.dec, now, obs.gen);
      if (!task.decodeSeen) {                     // prefill just ended
        task.decodeSeen = true;
        if (task.prefill == null && task.pp.length >= 2) task.prefill = meanRate(task.pp);
        if (task.prefill != null) this._setPrefill(st, task.prefill, now, false);
      }
    }
    return task;
  }

  _setPrefill(st, tps, at, exact) {
    if (!(tps > 0)) return;
    if (!st.lastPrefill || at >= st.lastPrefill.at) st.lastPrefill = { tps: round1(tps), at, exact };
  }

  /** a stream ended: the server's own record of it when there is one, else our mean */
  _end(st, task, now, rec = null) {
    st.tasks.delete(task.key);
    const decode = rec && Number(rec.decode_tok_s) > 0 ? Number(rec.decode_tok_s) : meanRate(task.dec);
    let prefill = task.prefill;
    if (rec) {
      const pr = Number(rec.prompt_read), pms = Number(rec.prompt_ms);
      if (pr >= MIN_PREFILL_TOKENS && pms > 0) prefill = pr / (pms / 1000);
    }
    if (decode == null && prefill == null) return;
    if (!st.last || now >= st.last.at) st.last = { prefill: round1(prefill), decode: round1(decode), at: now };
  }

  _endUnseen(st, now, seen, matchRecord = () => null) {
    for (const task of [...st.tasks.values()]) {
      if (!seen.has(task.key)) this._end(st, task, now, matchRecord(task));
    }
  }

  // ── llama.cpp ──────────────────────────────────────────────────────
  async _llamacpp(def, st, now) {
    const base = def.url.replace(/\/+$/, '');
    const slots = (await getJson(`${base}/slots`, {}, this.timeoutMs)) || [];
    const list = Array.isArray(slots) ? slots : [];
    st.maxStreams = Math.min(Math.max(list.length, 1), MAX_STREAMS);
    st.held = [];
    st.queued = 0;
    const busy = list.filter((s) => s && s.is_processing);
    const metrics = async () => promText(await (await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(this.timeoutMs) })).text());
    const seen = new Set();
    for (const s of busy) {
      const cell = Number.isInteger(s.id) ? s.id : list.indexOf(s);
      const gen = Number(s.next_token?.[0]?.n_decoded) || 0;
      const nPredict = Number(s.params?.n_predict ?? s.params?.max_tokens);
      const key = `${cell}:${s.id_task}`;
      const isNew = !st.tasks.has(key);
      const task = this._observe(st, now, {
        key, cell, phase: gen > 0 ? 'decode' : 'prefill', gen,
        prompt: int(s.n_prompt_tokens), read: int(s.n_prompt_tokens_processed),
        max: nPredict > 0 ? nPredict : null, elapsed: null,
      }, seen);
      // exact prefill for a request running alone: prompt counters at its start and at
      // its first decoded token (see the header)
      if (busy.length === 1) {
        if (isNew && gen === 0) { try { task.base = await metrics(); } catch { /* estimate only */ } }
        if (gen > 0 && task.base && !task.exactDone) {
          task.exactDone = true;
          try {
            const m = await metrics();
            const dn = m['llamacpp:prompt_tokens_total'] - task.base['llamacpp:prompt_tokens_total'];
            const ds = m['llamacpp:prompt_seconds_total'] - task.base['llamacpp:prompt_seconds_total'];
            if (dn >= MIN_PREFILL_TOKENS && ds > 0) { task.prefill = dn / ds; task.prefillExact = true; this._setPrefill(st, task.prefill, now, true); }
          } catch { /* keep the estimate */ }
        }
      }
    }
    this._endUnseen(st, now, seen);
  }

  // ── Strata ─────────────────────────────────────────────────────────
  async _strata(def, st, now) {
    const base = def.url.replace(/\/+$/, '');
    const key = def.key_env ? this.env[def.key_env] : null;
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    if (!st.tasks.size) {
      const v = await getJson(`${base}/v1/status`, headers, this.timeoutMs);
      const M = Number(v?.concurrency?.serving);
      if (M >= 1) st.maxStreams = Math.min(M, MAX_STREAMS);
      this._strataTimings(st, v?.last_timings);
      // idle: /metrics only every 30 s, for what /v1/status lacks -- each idle slot's held
      // (cached) tokens, shown in the concurrency bar
      if (!(Number(v?.activity?.in_flight) > 0) && now - (st.idleMetricsAt || 0) < IDLE_METRICS_MS) { st.queued = 0; return; }
    }
    const m = await getJson(`${base}/metrics`, headers, this.timeoutMs);
    st.idleMetricsAt = now;
    const L = m?.live || {};
    if (Number(L.parallel) >= 1) st.maxStreams = Math.min(Number(L.parallel), MAX_STREAMS);
    const M = st.maxStreams;
    const slots = Array.isArray(L.slots) ? L.slots : [];
    const reqs = Array.isArray(m?.requests) ? m.requests : [];   // newest first
    st.held = Array.from({ length: M }, (_, i) => {
      const s = slots.find((x) => Number(x.slot) === i);
      return s && s.state === 'idle' ? int(s.held_tokens) : null;
    });
    const seen = new Set();
    let active = 0;
    for (const s of slots) {
      if (!s || s.state === 'idle') continue;
      const cell = Number(s.slot);
      if (!(cell >= 0 && cell < M)) continue;
      active += 1;
      this._observe(st, now, {
        key: `slot:${cell}`, cell, phase: s.state === 'reading' ? 'prefill' : 'decode',
        gen: Number(s.generated) || 0, prompt: int(s.prompt_tokens), read: int(s.prompt_read),
        max: null, elapsed: Number.isFinite(Number(s.elapsed_s)) ? Number(s.elapsed_s) : null,
      }, seen);
    }
    const running = Number.isFinite(Number(L.running)) ? Number(L.running) : (L.state === 'reading' || L.state === 'generating' ? 1 : 0);
    // nothing in a slot but a request in flight: the solo path (top-level live.*)
    if (!active && running > 0 && (L.state === 'reading' || L.state === 'generating')) {
      const used = new Set([...st.tasks.values()].filter((t) => t.key !== 'solo').map((t) => t.cell));
      let cell = 0; while (used.has(cell) && cell < M - 1) cell += 1;
      active = 1;
      this._observe(st, now, {
        key: 'solo', cell, phase: L.state === 'reading' ? 'prefill' : 'decode',
        gen: Number(L.generated) || 0, prompt: int(L.prompt_tokens), read: int(L.prompt_read),
        max: int(L.max_tokens), elapsed: Number.isFinite(Number(L.elapsed_s)) ? Number(L.elapsed_s) : null,
      }, seen);
    }
    st.queued = (Number(L.queued) || 0) + Math.max(0, running - active);
    // ended streams: match Strata's own record by start time (requests[].time = START)
    this._endUnseen(st, now, seen, (task) => reqs.find((r) => Math.abs(Number(r.time) * 1000 - task.start) < 5000) || null);
    // the newest finished request's exact prefill
    const r0 = reqs[0];
    if (r0) {
      const pr = Number(r0.prompt_read), pms = Number(r0.prompt_ms);
      const at = (Number(r0.time) + pms / 1000) * 1000;
      if (pr >= MIN_PREFILL_TOKENS && pms > 0 && at > st.lastRecAt) { st.lastRecAt = at; this._setPrefill(st, pr / (pms / 1000), at, true); }
    }
  }

  /** /v1/status last_timings: the last request's exact figures (also after a hub restart) */
  _strataTimings(st, lt) {
    if (!lt || !Number.isFinite(Number(lt.at))) return;
    const at = Number(lt.at) * 1000;
    if (at <= st.lastRecAt) return;
    st.lastRecAt = at;
    const pre = Number(lt.prompt_n) >= MIN_PREFILL_TOKENS ? Number(lt.prompt_per_second) : null;
    if (pre > 0) this._setPrefill(st, pre, at, true);
    const dec = Number(lt.predicted_per_second);
    if ((pre > 0 || dec > 0) && (!st.last || at >= st.last.at)) st.last = { prefill: round1(pre), decode: round1(dec > 0 ? dec : null), at };
  }

  // ── view ───────────────────────────────────────────────────────────
  view(now = Date.now()) {
    const nodes = {};
    let total = 0, anyDecode = false;
    for (const [id, { def, st }] of this.nodes) {
      const M = st.reachable === false ? (st.maxStreams || 1) : st.maxStreams || 1;
      const tasks = [...st.tasks.values()];
      const streams = Array.from({ length: M }, (_, i) => ({ n: i + 1, state: 'idle', tps: null, gen: null, max: null, prompt: null, read: null, held: st.held?.[i] ?? null }));
      for (const t of tasks) {
        const c = streams[t.cell];
        if (!c) continue;
        const prefillRate = t.phase === 'prefill' && t.pp.length >= 2 ? meanRate(t.pp) : null;
        Object.assign(c, {
          state: t.phase, tps: t.phase === 'decode' ? round1(windowRate(t.dec)) : round1(prefillRate),
          gen: t.gen ?? null, max: t.max ?? null, prompt: t.prompt ?? null, read: t.phase === 'prefill' ? t.read ?? null : null, held: null,
        });
      }
      const dec = streams.filter((s) => s.state === 'decode');
      const withRate = dec.filter((s) => s.tps != null);
      const decode = withRate.length ? withRate.reduce((a, s) => a + s.tps, 0) : null;
      if (decode != null) { total += decode; anyDecode = true; }
      const running = tasks.length;
      const lone = running === 1 ? tasks[0] : null;
      const lp = st.lastPrefill ? { ...st.lastPrefill, expired: now - st.lastPrefill.at > this.maxAgeMs } : null;
      const last = st.last ? { ...st.last, expired: now - st.last.at > this.maxAgeMs } : null;
      nodes[id] = {
        kind: def.kind, reachable: st.reachable, max_streams: M,
        busy: running, running, queued: st.queued,
        phase: running ? (dec.length ? 'decode' : 'prefill') : null,
        decoding: dec.length, decode_tps: round1(decode),
        decode_avg: withRate.length ? round1(decode / withRate.length) : null,
        // a lone request: its own prefill (exact when the server gave it) and progress
        prefill_tps: lone ? round1(lone.phase === 'prefill' ? (lone.pp.length >= 2 ? meanRate(lone.pp) : null) : lone.prefill) : null,
        prefill_exact: !!(lone && lone.phase === 'decode' && lone.prefillExact),
        prefill_read: lone && lone.phase === 'prefill' ? lone.read ?? null : null,
        prefilling: streams.filter((s) => s.state === 'prefill').map((s) => s.n),
        streams, last_prefill: lp, last,
        at: st.at || null, error: st.reachable === false ? st.err : null,
      };
    }
    return { at: now, nodes, decode_total: anyDecode && total > 0 ? round1(total) : null };
  }

  /** timeseries rows for the history: running streams, total and per-stream decode */
  historyRows(targetId, view) {
    const rows = [];
    for (const [id, n] of Object.entries(view.nodes || {})) {
      if (!n.reachable) continue;
      rows.push([targetId, `${id}_streams`, n.running]);
      rows.push([targetId, `${id}_tps`, n.decode_tps || 0]);
      for (const s of n.streams) rows.push([targetId, `${id}_s${s.n}_tps`, s.state === 'decode' && s.tps != null ? s.tps : 0]);
    }
    return rows;
  }
}
