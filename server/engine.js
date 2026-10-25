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
import Database from 'better-sqlite3';

const PROBE_EVERY_MS = 180000;
const PROBE_TIMEOUT_MS = 2500;
const POKE_MIN_MS = 30000;          // a re-probe asked for by the live reader: at most this often
const RETRY_MS = 60000;             // a node no port answered (switched off): look again this soon

export const ENGINE_NAMES = { strata: 'Strata', llamacpp: 'llama.cpp' };
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
  const fam = (m) => `${m}{instance=~"${instanceRe(e)}"}`;
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
  const sel = (m) => `${m}{instance=~"${instanceRe(e)}"}`;
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
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json().catch(() => { throw new Error('no JSON'); });
  return { j, mirror: r.headers.get('x-homenet-mirror') === '1' };
}

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
    }
    this.timer = null;
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
      if (!cur && s && n.engine.ports.includes(s.port)) cur = { engine: s.engine, port: s.port, mirror: !!s.mirror, since: s.since, slots: s.slots };
      next.set(n.id, { def: { id: n.id, ...n.engine }, cur, checked: old?.checked || 0, error: old?.error || null, probing: null, nextAt: 0, pokeAt: 0 });
    }
    this.nodes = next;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 5000);
    this.ready = this.tick();
    return this.ready;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()) {
    await Promise.all([...this.nodes.values()].filter((n) => now >= n.nextAt).map((n) => this.probe(n)));
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
    for (const port of def.ports) {
      const base = `http://${def.host}:${port}`;
      const errs = [];
      try {
        const { j } = await probeOne(`${base}/v1/status`, headers);
        if (j && typeof j === 'object' && !Array.isArray(j) && (j.concurrency || j.activity)) {
          found = { engine: 'strata', port, mirror: false, slots: Number(j.concurrency?.serving) || null };
          break;
        }
        errs.push('/v1/status: not Strata');
      } catch (e) { errs.push(`/v1/status ${errText(e)}`); }
      try {
        const { j, mirror } = await probeOne(`${base}/slots`, headers);
        if (Array.isArray(j)) { found = { engine: 'llamacpp', port, mirror, slots: j.length || null }; break; }
        errs.push('/slots: not a list');
      } catch (e) { errs.push(`/slots ${errText(e)}`); }
      try {
        const { j, mirror } = await probeOne(`${base}/props`, headers);
        if (j && typeof j === 'object' && (Number.isFinite(Number(j.total_slots)) || j.default_generation_settings)) {
          found = { engine: 'llamacpp', port, mirror, slots: Number(j.total_slots) || null };
          break;
        }
        errs.push('/props: not llama.cpp');
      } catch (e) { errs.push(`/props ${errText(e)}`); }
      // (one line per port; the shortest reason that still tells the ports apart)
      tried.push(`${port}: ${errs[0]}${errs.length > 1 ? ` · ${errs[1]}` : ''}`);
    }
    const now = Date.now();
    n.checked = now;
    if (!found) { n.error = tried.join('; '); return; }
    n.error = null;
    const prev = n.cur;
    const changed = !prev || prev.engine !== found.engine || prev.port !== found.port;
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
      this.db.prepare(`INSERT INTO engine_state (node, engine, port, mirror, since, slots) VALUES (@node, @engine, @port, @mirror, @since, @slots)
        ON CONFLICT(node) DO UPDATE SET engine = excluded.engine, port = excluded.port, mirror = excluded.mirror, since = excluded.since, slots = excluded.slots`)
        .run({ node: def.id, engine: n.cur.engine, port: n.cur.port, mirror: n.cur.mirror ? 1 : 0, since: n.cur.since, slots: n.cur.slots ?? null });
    }
  }

  has(id) { return this.nodes.has(id); }

  /** where the live reader reads this node now (null until an engine was found) */
  liveDef(id) {
    const n = this.nodes.get(id);
    if (!n?.cur) return null;
    const kind = n.cur.engine;
    return { id, kind, url: `http://${n.def.host}:${n.cur.port}`, key_env: kind === 'strata' || !n.cur.mirror ? n.def.key_env : undefined };
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
      candidates: n.def.ports, error: n.error,
    };
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
      } else if (n.cur?.engine === job) {
        out.push({ targets: [`${n.def.host}:${n.cur.port}`], labels });
      }
    }
    // (an empty list leaves Prometheus scraping whatever it had before -- an empty group
    // replaces it)
    return out.length ? out : [{ targets: [], labels: {} }];
  }
}
