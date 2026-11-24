// engine.js (v2.29) — which inference engine answers on each node, found by asking it.
//
// A node in the inference_nodes target may say how to FIND its engine instead of naming it:
//   engine: { host: 192.168.1.25, ports: [8080, 9878], key_env: STRATA_API_KEY,
//             logs: 9877 }      # optional: llama-log-exporter.py (request counter) on that port
// At start, every `probe_every` (3 min; 1 min while no port answers) and soon after the live
// reader loses the node, each
// candidate port is asked, in order:
//   GET /v1/status  (key sent)  a JSON object with concurrency / activity      -> Strata
//   GET /slots      (key sent)  a JSON array                                    -> llama.cpp
//   GET /props      (key sent)  total_slots / default_generation_settings       -> llama.cpp
//                                                                   (started with --no-slots)
// The first port that answers decides. A node that answers on no port KEEPS its last engine
// (switched off is not "changed"). A change of engine or port is logged -- console and the
// engine_log table -- with both sides, and the node column's title shows the current one.
//
// What follows from the engine, for the rest of the hub:
//   live        (live.js) Strata: /v1/status + /metrics; llama.cpp: /slots + /metrics
//   Prometheus  /api/prom/sd/<job> (http_sd_configs): job strata (/metrics/prometheus, bearer)
//               or llamacpp (/metrics) gets host:port; job llama_logs gets the exporter
//   counters    (nodes.js, usage.js) selectors over EVERY candidate port -- Strata exports the
//               llamacpp:* token families too, so a switch mid-day loses nothing -- plus a
//               request counter: Strata's own or the exporter's (llama.cpp has none)
//   speed       (node_speed targets) the same Prometheus query over every candidate port
//
// v2.50 a node whose machine takes turns running ComfyUI or an LLM (m110 / m136, BACKLOG 64) says
//   engine: { host: 192.168.1.110, ports: [8080], follow: m110 }
// `follow` = the machine target whose agent reports its LLM server (extra.llm, agents/homenet-agent.ps1: engine,
// listen, api_port, model -- found by process name, confirmed over loopback): the port it answers on is asked
// FIRST, before the configured ones (no config change when the engine moves to another port; a port bound to
// loopback only cannot be reached from the hub and is not tried). Such a node also knows the engines that have no
// counters -- Ollama (/api/version), LM Studio (/api/v0/models), any OpenAI-compatible server (/v1/models): status
// and model only. A port that wants a key the hub does not have (401 / 403) is taken as the engine the agent saw
// there (`auth`). The model ID is read from /v1/models (else the agent's) and shown on the card. A new port reported
// by the agent makes the node be looked at again at once (poke).
import Database from 'better-sqlite3';

const PROBE_EVERY_MS = 180000;
const PROBE_TIMEOUT_MS = 2500;
const POKE_MIN_MS = 30000;          // a re-probe asked for by the live reader: at most this often
const RETRY_MS = 60000;             // a node no port answered (switched off): look again this soon

export const ENGINE_NAMES = { strata: 'Strata', llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI API' };
// v2.50 engines the live reader can only check for an answer (no slots, no counters)
export const PLAIN_ENGINES = new Set(['ollama', 'lmstudio', 'openai']);
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;

/** v2.50 extra.llm of a live, fresh machine snapshot (null when off / stale / an agent that does not report it) */
export function llmInfo(m) {
  if (!m || m.online === false || m.stale) return null;
  const c = m.extra?.llm;
  return c && typeof c === 'object' && Number.isFinite(Number(c.procs)) ? c : null;
}

/** v2.50 the ports the agent says its LLM server answers on that the hub can reach: api_port first, then the rest */
export function llmPorts(c) {
  if (!c || !(Number(c.procs) > 0)) return [];
  const out = [];
  const add = (p) => { p = Number(p); if (Number.isInteger(p) && p > 0 && p < 65536 && !out.includes(p)) out.push(p); };
  const ls = Array.isArray(c.listen) ? c.listen : [];
  const api = Number(c.api_port);
  if (api && ls.some((l) => Number(l?.port) === api && !LOOPBACK.test(String(l?.addr ?? '')))) add(api);
  for (const l of ls) if (!LOOPBACK.test(String(l?.addr ?? ''))) add(l?.port);
  return out.slice(0, 6);
}
export const PROM_JOBS = ['strata', 'llamacpp', 'llama_logs'];

// a host inside a PromQL regex (in a PromQL string: the backslash itself is escaped)
const reHost = (h) => String(h).replace(/\./g, '\\\\.');
export const instanceRe = (e) => `${reHost(e.host)}:(${e.ports.join('|')})`;

/**
 * Counter selectors for a node. With `engine`: the same families on every candidate port, a
 * request counter from Strata or the log exporter; explicit `counters` kinds still win (the
 * embedding server on m26 is not the node's engine). Without: `counters` as configured.
 */
export function nodeCounters(n) {
  const e = n.engine;
  if (!e) return n.counters || {};
  // (v2.46 counter_ports: where the engine used to answer -- its old series, for recomputing old days)
  const all = { host: e.host, ports: [...new Set([...e.ports, ...(e.counter_ports || [])])] };
  // (v2.50 follow: the engine answers on whatever port the agent reports -- every port of the host; Prometheus only
  //  ever scrapes the one /api/prom/sd names, so no other series of the host carries these families)
  const fam = e.follow ? (m) => `${m}{instance=~"${reHost(e.host)}:[0-9]+"}` : (m) => `${m}{instance=~"${instanceRe(all)}"}`;
  const requests = [fam('strata:requests_total')];
  if (e.logs) requests.push(`homenet_llama_requests_total{instance="${e.host}:${e.logs}",${e.logs_unit ? `unit="${e.logs_unit}"` : 'role="chat"'}}`);
  return {
    tokens: [fam('llamacpp:prompt_tokens_total'), fam('llamacpp:prompt_tokens_cached_total'), fam('llamacpp:tokens_predicted_total')],
    net: [fam('llamacpp:prompt_tokens_total'), fam('llamacpp:tokens_predicted_total')],
    generated: [fam('llamacpp:tokens_predicted_total')],
    requests,
    ...(n.counters || {}),
  };
}

/** the Prefill / Decode query of a node_speed target: last non-idle 5 m rates + when */
export function speedQuery(e, lookback = '7d') {
  const sel = e.follow ? (m) => `${m}{instance=~"${reHost(e.host)}:[0-9]+"}` : (m) => `${m}{instance=~"${instanceRe(e)}"}`;
  const rate = (a, b) => `(sum(rate(${sel(a)}[5m])) / sum(rate(${sel(b)}[5m])) > 0)`;
  const pp = rate('llamacpp:prompt_tokens_total', 'llamacpp:prompt_seconds_total');
  const tg = rate('llamacpp:tokens_predicted_total', 'llamacpp:tokens_predicted_seconds_total');
  const lbl = (q, k) => `label_replace(${q}, "k", "${k}", "", "")`;
  return [
    lbl(`round(last_over_time(${pp}[${lookback}:1m]), 0.1)`, 'pp'),
    lbl(`round(last_over_time(${tg}[${lookback}:1m]), 0.1)`, 'tg'),
    lbl(`max_over_time(timestamp(${pp})[${lookback}:1m])`, 'pp_at'),
    lbl(`max_over_time(timestamp(${tg})[${lookback}:1m])`, 'tg_at'),
  ].join(' or ');
}

async function probeOne(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'error' });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  const j = await r.json().catch(() => { throw new Error('no JSON'); });
  return { j, mirror: r.headers.get('x-homenet-mirror') === '1' };
}

// v2.50 a model ID as shown: a path's leaf, at most 96 characters
const modelText = (m) => String(m).split(/[\\/]/).pop().slice(0, 96);

const errText = (e) => (e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e).slice(0, 80));

export class EngineDetector {
  constructor(dbPath, { env }) {
    this.env = env;
    this.nodes = new Map();          // id -> { def, cur, checked, error, probing, nextAt, pokeAt }
    if (dbPath) {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS engine_state (node TEXT PRIMARY KEY, engine TEXT NOT NULL, port INTEGER NOT NULL,
          mirror INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL, slots INTEGER);
        CREATE TABLE IF NOT EXISTS engine_log (at INTEGER NOT NULL, node TEXT NOT NULL, prev TEXT, next TEXT NOT NULL);
      `);
      // v2.50 the model the engine serves and whether it wants a key the hub does not have (follow nodes)
      const cols = new Set(this.db.prepare('PRAGMA table_info(engine_state)').all().map((c) => c.name));
      if (!cols.has('model')) this.db.exec('ALTER TABLE engine_state ADD COLUMN model TEXT');
      if (!cols.has('auth')) this.db.exec('ALTER TABLE engine_state ADD COLUMN auth INTEGER NOT NULL DEFAULT 0');
    }
    this.timer = null;
    this.machineOf = null;           // v2.50 id -> machine snapshot (set by the scheduler), for `follow`
  }

  /** (re)read the nodes; a node's last engine survives a config reload and a restart */
  configure(nodesTarget, { every } = {}) {
    this.every = every || PROBE_EVERY_MS;
    const stored = new Map((this.db ? this.db.prepare('SELECT * FROM engine_state').all() : []).map((r) => [r.node, r]));
    const next = new Map();
    for (const n of nodesTarget?.nodes || []) {
      if (!n.engine?.host || !Array.isArray(n.engine.ports) || !n.engine.ports.length) continue;
      const old = this.nodes.get(n.id);
      let cur = old?.cur || null;
      const s = stored.get(n.id);
      // (v2.50 a `follow` node's last port need not be a configured one: it is wherever the agent saw the engine)
      if (!cur && s && (n.engine.follow || n.engine.ports.includes(s.port))) cur = { engine: s.engine, port: s.port, mirror: !!s.mirror, since: s.since, slots: s.slots, model: s.model || null, auth: !!s.auth };
      next.set(n.id, { def: { id: n.id, ...n.engine }, cur, checked: old?.checked || 0, error: old?.error || null, probing: null, nextAt: 0, pokeAt: 0, seenPorts: old?.seenPorts || '' });
    }
    this.nodes = next;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 5000);
    this.ready = this.tick();
    return this.ready;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()) {
    // v2.50 a follow node whose agent reports another port: look again now (rate-limited like any poke)
    for (const n of this.nodes.values()) {
      if (!n.def.follow) continue;
      const ports = this.followPorts(n).join(',');
      if (ports !== n.seenPorts) { n.seenPorts = ports; if (ports) { n.pokeAt = 0; this.poke(n.def.id); } }
    }
    await Promise.all([...this.nodes.values()].filter((n) => now >= n.nextAt).map((n) => this.probe(n)));
  }

  /** v2.50 the reachable ports the follow machine's agent reports for its LLM server (api_port first) */
  followPorts(n) {
    if (!n.def.follow || !this.machineOf) return [];
    return llmPorts(llmInfo(this.machineOf(n.def.follow)));
  }

  /**
   * the ports to ask, in order: (follow) the agent's, then the configured ones. v2.50 a follow node is not asked
   * at all while its machine is off, or while its agent says no LLM server runs (it runs ComfyUI then: m136's
   * firewall drops a closed port, so every ask would wait out the timeout); an agent that does not report LLM
   * servers (older version) leaves the configured ports.
   */
  portsOf(n) {
    if (n.def.follow && this.machineOf) {
      const m = this.machineOf(n.def.follow);
      if (!m || m.online === false || m.stale) return [];
      const c = llmInfo(m);
      if (c && !(Number(c.procs) > 0)) return [];
    }
    return [...new Set([...this.followPorts(n), ...n.def.ports])];
  }

  /** the live reader lost this node: look again soon (not every 2 s) */
  poke(id) {
    const n = this.nodes.get(id);
    if (!n || n.probing) return;
    const now = Date.now();
    if (now - n.pokeAt < POKE_MIN_MS) return;
    n.pokeAt = now;
    n.nextAt = 0;
  }

  probe(n) {
    if (n.probing) return n.probing;
    n.probing = this._probe(n).finally(() => { n.probing = null; n.nextAt = Date.now() + (n.error ? Math.min(RETRY_MS, this.every) : this.every); });
    return n.probing;
  }

  async _probe(n) {
    const { def } = n;
    const key = def.key_env ? this.env[def.key_env] : null;
    const headers = { accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
    const tried = [];
    let found = null;
    const follow = !!def.follow;
    const agent = follow && this.machineOf ? llmInfo(this.machineOf(def.follow)) : null;
    for (const port of this.portsOf(n)) {
      const base = `http://${def.host}:${port}`;
      const errs = [];
      let locked = false;          // (v2.50) the port answered, but wants a key
      const fail = (what, e) => { if (e?.status === 401 || e?.status === 403) locked = true; errs.push(`${what} ${errText(e)}`); };
      try {
        const { j } = await probeOne(`${base}/v1/status`, headers);
        if (j && typeof j === 'object' && !Array.isArray(j) && (j.concurrency || j.activity)) {
          found = { engine: 'strata', port, mirror: false, slots: Number(j.concurrency?.serving) || null };
          break;
        }
        errs.push('/v1/status: not Strata');
      } catch (e) { fail('/v1/status', e); }
      try {
        const { j, mirror } = await probeOne(`${base}/slots`, headers);
        if (Array.isArray(j)) { found = { engine: 'llamacpp', port, mirror, slots: j.length || null }; break; }
        errs.push('/slots: not a list');
      } catch (e) { fail('/slots', e); }
      try {
        const { j, mirror } = await probeOne(`${base}/props`, headers);
        if (j && typeof j === 'object' && (Number.isFinite(Number(j.total_slots)) || j.default_generation_settings)) {
          found = { engine: 'llamacpp', port, mirror, slots: Number(j.total_slots) || null };
          break;
        }
        errs.push('/props: not llama.cpp');
      } catch (e) { fail('/props', e); }
      // v2.50 (follow nodes) engines without counters, and a port that wants a key: the agent's word for it
      if (follow) {
        const akind = agent && Number(agent.api_port) === port ? String(agent.engine || '') : '';
        if (locked && ENGINE_NAMES[akind] && !PLAIN_ENGINES.has(akind)) { found = { engine: akind, port, mirror: false, slots: Number(agent.slots) || null, auth: true }; break; }
        found = await this._plain(base, headers, port, fail, errs);
        if (found) break;
        if (locked && ENGINE_NAMES[akind]) { found = { engine: akind, port, mirror: false, slots: null, auth: true }; break; }
      }
      // (one line per port; the shortest reason that still tells the ports apart)
      tried.push(`${port}: ${errs[0]}${errs.length > 1 ? ` · ${errs[1]}` : ''}`);
    }
    const now = Date.now();
    n.checked = now;
    if (!found) { n.error = tried.join('; ') || 'no port to ask'; return; }
    n.error = null;
    const prev = n.cur;
    const changed = !prev || prev.engine !== found.engine || prev.port !== found.port;
    // v2.50 (follow) the model it serves: its /v1/models (public on llama.cpp even with a key), else the agent's
    if (follow) {
      if (!found.model) {
        try { const { j } = await probeOne(`http://${def.host}:${found.port}/v1/models`, headers); found.model = String(j?.data?.[0]?.id || '') || null; } catch { /* the agent's below */ }
      }
      if (!found.model && agent?.model && Number(agent.api_port) === found.port) found.model = String(agent.model);
      if (found.model) found.model = modelText(found.model);
    }
    n.cur = { ...found, since: changed ? now : prev.since };
    if (changed) {
      const a = prev ? `${ENGINE_NAMES[prev.engine]}@${prev.port}` : null;
      const b = `${ENGINE_NAMES[found.engine]}@${found.port}${found.mirror ? ' (mirror)' : ''}`;
      console.log(`[engine] ${def.id}: ${a ? `${a} -> ${b}` : `detected ${b}`}`);
      if (this.db) {
        this.db.prepare('INSERT INTO engine_log (at, node, prev, next) VALUES (?, ?, ?, ?)').run(Math.floor(now / 1000), def.id, a, b);
      }
    }
    if (this.db) {
      this.db.prepare(`INSERT INTO engine_state (node, engine, port, mirror, since, slots, model, auth) VALUES (@node, @engine, @port, @mirror, @since, @slots, @model, @auth)
        ON CONFLICT(node) DO UPDATE SET engine = excluded.engine, port = excluded.port, mirror = excluded.mirror, since = excluded.since, slots = excluded.slots,
          model = excluded.model, auth = excluded.auth`)
        .run({ node: def.id, engine: n.cur.engine, port: n.cur.port, mirror: n.cur.mirror ? 1 : 0, since: n.cur.since, slots: n.cur.slots ?? null,
          model: n.cur.model || null, auth: n.cur.auth ? 1 : 0 });
    }
  }

  /** v2.50 Ollama / LM Studio / any OpenAI-compatible server on a port (follow nodes): status and model only */
  async _plain(base, headers, port, fail, errs) {
    try {
      const { j } = await probeOne(`${base}/api/version`, headers);
      if (j && typeof j === 'object' && j.version) {
        let model = null;
        try { const { j: ps } = await probeOne(`${base}/api/ps`, headers); model = ps?.models?.[0]?.name || null; } catch { /* none loaded */ }
        return { engine: 'ollama', port, mirror: false, slots: null, model };
      }
      errs.push('/api/version: not Ollama');
    } catch (e) { fail('/api/version', e); }
    try {
      const { j } = await probeOne(`${base}/api/v0/models`, headers);
      if (j && Array.isArray(j.data)) {
        const m = j.data.find((x) => x?.state === 'loaded' && x?.type !== 'embeddings');
        return { engine: 'lmstudio', port, mirror: false, slots: null, model: m?.id || null };
      }
      errs.push('/api/v0/models: not LM Studio');
    } catch (e) { fail('/api/v0/models', e); }
    try {
      const { j } = await probeOne(`${base}/v1/models`, headers);
      if (j && Array.isArray(j.data)) return { engine: 'openai', port, mirror: false, slots: null, model: j.data[0]?.id || null };
      errs.push('/v1/models: not a model list');
    } catch (e) { fail('/v1/models', e); }
    return null;
  }

  has(id) { return this.nodes.has(id); }

  /** where the live reader reads this node now (null until an engine was found) */
  liveDef(id) {
    const n = this.nodes.get(id);
    if (!n?.cur) return null;
    const kind = n.cur.engine;
    return { id, kind, url: `http://${n.def.host}:${n.cur.port}`, key_env: kind === 'strata' || !n.cur.mirror ? n.def.key_env : undefined,
      ...(n.cur.auth ? { auth: true } : {}),
      // v2.46 llama.cpp: the log exporter's /requests (each finished request's own timings)
      ...(kind === 'llamacpp' && n.def.logs ? { logs: `http://${n.def.host}:${n.def.logs}`, logs_unit: n.def.logs_unit || undefined } : {}) };
  }

  /** the scrape address Prometheus should have for the node's engine, and the exporter's */
  instances(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    return { engine: n.cur ? `${n.def.host}:${n.cur.port}` : null, job: n.cur?.engine || null, logs: n.def.logs ? `${n.def.host}:${n.def.logs}` : null };
  }

  /** for the node column's title */
  info(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    const c = n.cur;
    return {
      engine: c?.engine || null, name: c ? ENGINE_NAMES[c.engine] : null, host: n.def.host, port: c?.port ?? null,
      mirror: !!c?.mirror, slots: c?.slots ?? null, since: c?.since ?? null, checked: n.checked || null,
      candidates: this.portsOf(n), error: n.error,
      // v2.50 (follow nodes) the model it serves, a key the hub does not have, the configured ports
      ...(n.def.follow ? { follow: n.def.follow, model: c?.model || null, auth: !!c?.auth, configured: n.def.ports } : {}),
    };
  }

  /**
   * v2.51 (BACKLOG 66) whether Prometheus should scrape a node's engine now. Always, for a fixed node (its engine runs
   * all the time; a failed scrape there is a real fault). A `follow` node (m110 / m136) only while its engine runs:
   * the machine is on, its agent reports an LLM server, and the port the engine was found on is one the agent reports.
   * Off, or running ComfyUI: not listed -- Prometheus does not scrape it at all, so there is no failed scrape to count
   * or alert on (the node keeps its last engine for the card; the counters' last values stay in Prometheus).
   */
  scrapable(n) {
    if (!n.def.follow) return true;
    return !!n.cur && this.followPorts(n).includes(n.cur.port);
  }

  /** Prometheus http_sd_configs answer for one job */
  sd(job, nodesTarget) {
    const out = [];
    for (const nd of nodesTarget?.nodes || []) {
      const n = this.nodes.get(nd.id);
      if (!n) continue;
      const labels = Object.fromEntries(Object.entries(nd.prom_labels || {}).map(([k, v]) => [k, String(v)]));
      if (job === 'llama_logs') {
        if (n.def.logs) out.push({ targets: [`${n.def.host}:${n.def.logs}`], labels });
      } else if (n.cur?.engine === job && !(n.def.follow && n.cur.auth) && this.scrapable(n)) {   // (v2.50 a key the hub lacks: nothing to scrape with)
        out.push({ targets: [`${n.def.host}:${n.cur.port}`], labels });
      }
    }
    // (an empty list leaves Prometheus scraping whatever it had before -- an empty group
    // replaces it)
    return out.length ? out : [{ targets: [], labels: {} }];
  }
}
