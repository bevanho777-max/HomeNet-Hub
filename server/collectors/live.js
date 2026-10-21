// live.js (v2.25) — what each inference server is doing RIGHT NOW, read from the server
// itself every ~2 s. Not through Prometheus: the servers' token counters only move when a
// request ENDS, Prometheus scrapes on its own clock and a rate() needs two samples, so the
// Prometheus path is minutes late. That path stays, for history and reconciliation.
//
// One small GET per node per poll, 1 s timeout, exponential backoff while a node does not
// answer (m110 is switched off a lot), never more than one request in flight per node:
//   llama.cpp  GET /slots   (~1.3 KB, answered in ~2 ms even mid-prefill on this build)
//              per slot: is_processing, id_task, n_prompt_tokens_processed (moves per
//              batch), next_token[0].n_decoded (moves per token)
//              + GET /metrics twice per request: at its start and when decoding begins.
//              This build flushes prompt_tokens_total / prompt_seconds_total at the batch
//              that produces the first output, so the two readings give this request's
//              exact prefill speed the moment prefill ends.
//   Strata     idle: GET /status (bearer key; ~0.2 KB) -- busy or not. Its `tail` (the
//              text being generated) is dropped on arrival, never stored or sent anywhere.
//              busy: GET /metrics (~14 KB, a few ms) -- live.state / generated / running /
//              tok_s, and requests[] with each finished request's prompt_read / prompt_ms /
//              decode_tok_s. (/status alone is wrong on a Strata with parallel slots.)
//
// Decode speed = increase of the decoded-token count between readings ÷ the time between
// them, over the last ~10 s (summed across parallel requests). The value a finished request
// leaves behind ("last") is its mean over the whole observed decode -- the figure the
// server's own final timings report.
const WINDOW_MS = 10000;
const BACKOFF_MAX_MS = 30000;
const MIN_PREFILL_TOKENS = 32;      // a (nearly) fully cached prompt has no meaningful speed

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

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
  return { reachable: null, fails: 0, nextAt: 0, busy: 0, queued: 0, phase: null, tasks: new Map(), last: null, err: null, at: 0 };
}

/** decode speed over the readings in the last WINDOW_MS (needs two of them) */
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
      st.reachable = false; st.busy = 0; st.queued = 0; st.phase = null; st.tasks.clear();
      st.err = String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 120);
      st.nextAt = now + Math.min(2000 * 2 ** st.fails, BACKOFF_MAX_MS);
    }
  }

  // ── llama.cpp ──────────────────────────────────────────────────────
  async _llamacpp(def, st, now) {
    const base = def.url.replace(/\/+$/, '');
    const slots = await getJson(`${base}/slots`, {}, this.timeoutMs);
    const busy = (Array.isArray(slots) ? slots : []).filter((s) => s && s.is_processing);
    const metrics = async () => promText(await (await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(this.timeoutMs) })).text());
    const seen = new Set();
    for (const s of busy) {
      const key = `${s.id}:${s.id_task}`;
      seen.add(key);
      let task = st.tasks.get(key);
      if (!task) {
        task = { first: now, pp: [], dec: [], prefill: null, base: null };
        st.tasks.set(key, task);
        // baseline for the exact prefill: the prompt counters before this prompt is flushed
        if (busy.length === 1) { try { task.base = await metrics(); } catch { /* exact prefill unavailable */ } }
      }
      const dec = Number(s.next_token?.[0]?.n_decoded) || 0;
      const pp = Number(s.n_prompt_tokens_processed) || 0;
      if (dec === 0) {
        if (!task.pp.length || task.pp[task.pp.length - 1].n !== pp) task.pp.push({ t: now, n: pp });
        task.progress = pp;
      } else {
        task.dec.push({ t: now, n: dec });
        if (task.dec.length > 400) task.dec.splice(0, task.dec.length - 400);
        if (!task.prefillDone) {
          task.prefillDone = true;
          if (task.base && busy.length === 1) {
            try {
              const m = await metrics();
              const dn = m['llamacpp:prompt_tokens_total'] - task.base['llamacpp:prompt_tokens_total'];
              const ds = m['llamacpp:prompt_seconds_total'] - task.base['llamacpp:prompt_seconds_total'];
              if (dn >= MIN_PREFILL_TOKENS && ds > 0) task.prefill = dn / ds;
            } catch { /* keep the estimate */ }
          }
          if (task.prefill == null && task.pp.length >= 2) task.prefill = meanRate(task.pp);
        }
      }
    }
    // tasks that are no longer processing finished: their means become "last"
    for (const [key, task] of st.tasks) {
      if (seen.has(key)) continue;
      this._finish(st, task, now);
      st.tasks.delete(key);
    }
    st.busy = busy.length;
    st.queued = 0;
    st.phase = busy.length ? ([...st.tasks.values()].some((t) => t.dec.length) ? 'decode' : 'prefill') : null;
  }

  // ── Strata ─────────────────────────────────────────────────────────
  // Idle: GET /status (small) only says busy or not. Busy: GET /metrics and read its
  // `live` block -- on a Strata with parallel slots (m25) /status keeps saying "reading the
  // prompt" with generated=0 while the request is in fact decoding; live.state /
  // live.generated / live.running are right on both. The same response carries
  // requests[] (each finished request's prompt_read, prompt_ms, decode_tok_s), so the
  // request that just ended is recorded without another call. One GET per poll, except
  // on the poll that sees a node go busy (then /status and /metrics).
  async _strata(def, st, now) {
    const base = def.url.replace(/\/+$/, '');
    const key = def.key_env ? this.env[def.key_env] : null;
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    if (!st.busy) {
      const s = await getJson(`${base}/status`, headers, this.timeoutMs);
      if (s && typeof s === 'object') delete s.tail;   // generated text: never kept
      if (!s?.busy) { this._strataIdle(st, now, null); return; }
    }
    const m = await getJson(`${base}/metrics`, headers, this.timeoutMs);
    const L = m?.live || {};
    const running = Number(L.running) || 0;
    const busy = running > 0 || L.state === 'generating' || L.state === 'reading';
    const reqs = Array.isArray(m?.requests) ? m.requests : [];
    if (!busy) { this._strataIdle(st, now, reqs); return; }
    const gen = Number(L.generated) || 0;
    const elapsed = Number(L.elapsed_s) || 0;
    let task = st.tasks.get('cur');
    if (task && (gen < task.lastGen || elapsed + 0.5 < task.lastElapsed)) {   // a new request began
      this._strataEnd(st, task, now, reqs);
      task = null;
    }
    if (!task) { task = { first: now, pp: [], dec: [], prefill: null }; st.tasks.set('cur', task); }
    task.lastGen = gen; task.lastElapsed = elapsed;
    const read = Number(L.prompt_read);
    if (gen === 0 && Number.isFinite(read) && read > 0 && (!task.pp.length || task.pp[task.pp.length - 1].n !== read)) {
      task.pp.push({ t: now, n: read });
      task.progress = read;
    }
    if (gen > 0) {
      task.dec.push({ t: now, n: gen });
      if (task.dec.length > 400) task.dec.splice(0, task.dec.length - 400);
    }
    st.busy = Math.max(running, 1);
    st.queued = (Number(L.queued) || 0) + (Number(L.waiting) || 0);
    st.phase = gen > 0 ? 'decode' : 'prefill';
    st.parallelGen = running > 1;
  }

  _strataIdle(st, now, reqs) {
    const task = st.tasks.get('cur');
    if (task) this._strataEnd(st, task, now, reqs);
    st.busy = 0; st.queued = 0; st.phase = null; st.parallelGen = false;
  }

  /** a Strata request ended: Strata's own record of it when there is one (exact prefill =
   *  tokens read / prompt time, its decode rate), else the hub's own measurement */
  _strataEnd(st, task, now, reqs) {
    st.tasks.delete('cur');
    let rec = null;
    for (const r of [...(reqs || [])].reverse()) {
      // requests[].time is the request's START; it ended duration_s later
      const end = (Number(r?.time) + (Number(r?.duration_s) || 0)) * 1000;
      if (Math.abs(end - now) < 30000 && Number(r.time) * 1000 >= task.first - 120000) { rec = r; break; }
    }
    if (rec) {
      const pr = Number(rec.prompt_read), pms = Number(rec.prompt_ms);
      task.prefill = pr >= MIN_PREFILL_TOKENS && pms > 0 ? pr / (pms / 1000) : null;
    }
    this._finish(st, task, now, rec && Number(rec.decode_tok_s) > 0 ? Number(rec.decode_tok_s) : null);
  }

  _finish(st, task, now, serverDecode = null) {
    const decode = serverDecode ?? meanRate(task.dec);
    if (decode == null && task.prefill == null) return;
    st.last = { prefill: round1(task.prefill), decode: round1(decode), at: now, tokens: task.dec.length ? task.dec[task.dec.length - 1].n : 0 };
  }

  // ── view ───────────────────────────────────────────────────────────
  view(now = Date.now()) {
    const nodes = {};
    let total = 0, anyDecode = false;
    for (const [id, { def, st }] of this.nodes) {
      const tasks = [...st.tasks.values()];
      const decoding = tasks.filter((t) => t.dec.length);
      let decode = null;
      for (const t of decoding) {
        // the same formula on every node: two readings of the decoded count. (Strata's own
        // 2 s rate on the very first reading was tried: it catches the ramp-up and read 11%
        // low on a short request, so the first figure now waits one more poll.)
        const r = windowRate(t.dec);
        if (r != null) decode = (decode || 0) + r;
      }
      const prefilling = tasks.filter((t) => !t.dec.length);
      const pre = prefilling[0];
      const prefill = decoding.length === 1 && prefilling.length === 0 ? decoding[0].prefill
        : (pre && pre.pp.length >= 2 ? meanRate(pre.pp) : null);
      if (decode != null) { total += decode; anyDecode = true; }
      const last = st.last ? { ...st.last, expired: now - st.last.at > this.maxAgeMs } : null;
      nodes[id] = {
        kind: def.kind, reachable: st.reachable, busy: st.busy, queued: st.queued, phase: st.phase,
        decoding: st.parallelGen ? st.busy : decoding.length, decode_tps: round1(decode),
        prefill_tps: round1(prefill), prefill_exact: !!(decoding.length === 1 && decoding[0].prefill != null && !prefilling.length),
        prefill_read: pre?.progress ?? null,
        last, at: st.at || null, error: st.reachable === false ? st.err : null,
      };
    }
    return { at: now, nodes, decode_total: anyDecode && total > 0 ? round1(total) : null };
  }
}
