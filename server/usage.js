// usage.js (v2.24) — ALL token usage by Beijing day, for the Token Usage card, its detail
// modal, the Per-Project table and the Clients panel.
//
// Two sources, never added on top of each other:
//   • the inference servers' own counters (Prometheus, the inference_nodes target's
//     `counters`): everything a machine computed, direct traffic included;
//   • LiteLLM (LiteLLM_SpendLogs, one row per request, real timestamp + backend api_base):
//     the only source for the days before a counter existed, and the source of the
//     per-key split (only LiteLLM knows which API key a request came in on).
// A request that went through LiteLLM to a node is ALSO in that node's counter. So for
// every (node, kind) there is a switch instant T -- when its counter started being
// collected. A LiteLLM row is "covered" (already in a counter, so not added again) iff it
// reached one of that node's endpoints at or after T. Uncovered rows (before T, an
// endpoint with no counter, no backend at all) count as they are. The LiteLLM share of a
// figure ("of which via LiteLLM") is every row, covered or not.
//
// "Day" is the Beijing calendar day everywhere. LiteLLM's daily tables are bucketed by UTC
// date, so they are only used for the days before `logs_since` (the first instant the
// per-request log is used; it keeps ~7 days and older rows are pruned): those old days
// keep their UTC-date label, which is said in the modal. To keep the per-request detail
// after the log is pruned, every completed Beijing day is aggregated once into the hub's
// own database (usage_ll / usage_ctr) and never recomputed.
//
// Today is live: the counter part is read from the inference_nodes snapshot (the very
// numbers the 推理节点 card shows, so the two cards agree by construction), the LiteLLM part
// from SpendLogs since Beijing midnight (indexed on startTime; grouped per minute, so even
// an embedding retry storm returns at most 1440 rows per key/model/backend).
import Database from 'better-sqlite3';
import { collectSqlRowsInts } from './collectors/sql.js';
import { promIncreaseRange, promFirstSample, promQuery, hostPort, TZ_OFFSET_SEC } from './collectors/nodes.js';

const DAY = 86400;
const SETTLE_SEC = 600;            // a day is final 10 min after it ends (late log rows, last scrape)
const LEGACY_TTL_MS = 6 * 3600 * 1000;

// counter kinds per node: [config key, snapshot metric suffix, class kind]
const KINDS = [
  ['tokens', 'tokens', 'chat'], ['net', 'net', 'chat'], ['requests', 'reqs', 'chat'],
  ['embed_tokens', 'emb_tokens', 'embed'], ['embed_requests', 'emb_reqs', 'embed'],
];
// which counter kind covers which measure of a LiteLLM row
const COVER = { chat: { tok: 'tokens', req: 'requests' }, embed: { tok: 'embed_tokens', req: 'embed_requests' } };

export const dayOf = (sec) => new Date((Math.floor(sec) + TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
export const dayStart = (day) => Date.parse(`${day}T00:00:00Z`) / 1000 - TZ_OFFSET_SEC;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const netOf = (prompt, cached, completion) => Math.max(prompt - cached, 0) + completion;

// v2.27: K / M / G with at most three significant digits (copy of web/fmt.js si3)
export function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n), a = Math.abs(x), sg = x < 0 ? '-' : '';
  if (a < 999.5) return sg + String(Math.round(a));
  const units = [['G', 1e9], ['M', 1e6], ['K', 1e3]];
  for (let i = 0; i < units.length; i++) {
    const [u, d] = units[i];
    if (a >= d * 0.9995) {   // (999.6 is "1K", not "1000")
      const v = Number((a / d).toPrecision(3));
      if (v >= 1000 && i > 0) { const [u2, d2] = units[i - 1]; return sg + String(Number((a / d2).toPrecision(3))) + u2; }
      return sg + String(v) + u;
    }
  }
  return sg + String(Math.round(a));
}

function safeRegex(src) { try { return src ? new RegExp(src, 'i') : null; } catch { return null; } }

/** LiteLLM's api_key column -> the label the Per-Project table shows (same rules as before). */
export function keyLabel(raw) {
  if (raw === 'litellm_proxy_master_key') return '(master key)';
  if (/^[0-9a-f]{64}$/.test(raw)) return `key:${raw.slice(0, 8)}`;
  if (!raw) return '(unattributed)';
  return raw.slice(0, 16);
}

export class UsageEngine {
  constructor(dbPath, { snapshot, env }) {
    this.snapshot = snapshot;
    this.env = env;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ll (
        day TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
        cov_tok INTEGER NOT NULL, cov_req INTEGER NOT NULL,
        tokens INTEGER NOT NULL, net INTEGER NOT NULL, requests INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_ll_day ON usage_ll(day);
      CREATE TABLE IF NOT EXISTS usage_ctr (
        day TEXT NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY (day, node, kind));
      CREATE TABLE IF NOT EXISTS usage_done (day TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS usage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    this._metaGet = this.db.prepare('SELECT v FROM usage_meta WHERE k = ?');
    this._metaSet = this.db.prepare('INSERT INTO usage_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    this._legacy = null;           // { at, rows }
    this._state = null;            // last computed view
    this._busy = null;
  }

  // ── configuration ─────────────────────────────────────────────────
  configure(target, nodesTarget) {
    this.target = target;
    this.src = target.source;
    this.nodesTarget = nodesTarget;
    this.prom = nodesTarget?.source?.prometheus || null;
    this.logsSince = Math.floor(Date.parse(this.src.logs_since) / 1000);
    this.nodes = (nodesTarget?.nodes || []).map((n) => ({
      id: n.id, counters: n.counters || {}, chat: new Set(n.endpoints || []), emb: new Set(n.embed_endpoints || []),
    }));
    const rules = (target.classify?.rules || []).map((r, i) => ({
      key: `c${i}`, label: r.name, color: r.color, re: safeRegex(r.match?.regex), counters: r.counters || null,
    }));
    const fb = target.classify?.fallback || {};
    this.classes = [...rules, { key: 'fallback', label: fb.name || 'Other', color: fb.color || '#8b93a3', re: null, counters: null }];
    this.classByCounters = { chat: rules.find((r) => r.counters === 'chat')?.key || null, embed: rules.find((r) => r.counters === 'embed')?.key || null };
    this.chatKey = this.classByCounters.chat;
  }

  classOf(model) {
    const m = String(model ?? '');
    for (const c of this.classes) if (c.re && c.re.test(m)) return c.key;
    return 'fallback';
  }

  endpointOf(apiBase) { return apiBase ? hostPort(String(apiBase).replace(/\/v1.*$/, '')) || '' : ''; }

  /** node + endpoint type (chat|embed) an endpoint belongs to */
  nodeOf(endpoint) {
    for (const n of this.nodes) {
      if (n.chat.has(endpoint)) return { node: n, type: 'chat' };
      if (n.emb.has(endpoint)) return { node: n, type: 'embed' };
    }
    return null;
  }

  // ── switch instants: when each (node, kind) counter started being collected ──
  async switchPoints(nowSec) {
    const out = {};
    for (const n of this.nodes) {
      for (const [kind] of KINDS) {
        const sels = n.counters[kind];
        if (!sels || !sels.length) continue;
        const mk = `switch:${n.id}:${kind}:${JSON.stringify(sels)}`;
        const saved = this._metaGet.get(mk);
        if (saved) { out[`${n.id}:${kind}`] = Number(saved.v); continue; }
        if (!this.prom) continue;
        try {
          const first = await promFirstSample(this.prom, sels, nowSec);
          if (first == null) continue;           // counter not collected yet: no switch, LiteLLM only
          // Before logs_since a LiteLLM row cannot be told apart by backend (the daily
          // table has no api_base), so a counter older than that switches at logs_since.
          const t = Math.max(first, this.logsSince);
          this._metaSet.run(mk, String(t));       // fixed once found: retention must not move it
          out[`${n.id}:${kind}`] = t;
        } catch { /* Prometheus down: try again next refresh */ }
      }
    }
    return out;
  }

  // ── LiteLLM rows ──────────────────────────────────────────────────
  /** SpendLogs for [start, end), grouped per minute, already tagged with coverage. */
  async llWindow(start, end, T) {
    const rows = await collectSqlRowsInts(this.src, this.env, this.src.rows_query_file, [Math.floor(start), Math.ceil(end)]);
    const acc = new Map();
    for (const r of rows) {
      const minute = num(r.minute);
      const endpoint = this.endpointOf(r.api_base);
      const nd = endpoint ? this.nodeOf(endpoint) : null;
      const cov = (measure) => {
        if (!nd) return 0;
        const t = T[`${nd.node.id}:${COVER[nd.type][measure]}`];
        return t != null && minute >= t - 59 ? 1 : 0;   // minute bucket containing T counts as after
      };
      const row = {
        day: dayOf(minute), api_key: String(r.api_key ?? ''), model: String(r.model ?? ''), endpoint,
        cov_tok: cov('tok'), cov_req: cov('req'),
        tokens: num(r.prompt) + num(r.completion), net: netOf(num(r.prompt), num(r.cached), num(r.completion)), requests: num(r.requests),
      };
      const k = [row.day, row.api_key, row.model, row.endpoint, row.cov_tok, row.cov_req].join('\u0001');
      const a = acc.get(k);
      if (a) { a.tokens += row.tokens; a.net += row.net; a.requests += row.requests; } else acc.set(k, row);
    }
    return [...acc.values()];
  }

  async legacyRows() {
    if (this._legacy && Date.now() - this._legacy.at < LEGACY_TTL_MS) return this._legacy.rows;
    const rows = (await collectSqlRowsInts(this.src, this.env, this.src.legacy_query_file, [this.logsSince])).map((r) => ({
      day: String(r.day).slice(0, 10), api_key: String(r.api_key ?? ''), model: String(r.model ?? ''), endpoint: '',
      cov_tok: 0, cov_req: 0, legacy: true,
      tokens: num(r.prompt) + num(r.completion), net: netOf(num(r.prompt), num(r.cached), num(r.completion)), requests: num(r.requests),
    }));
    this._legacy = { at: Date.now(), rows };
    return rows;
  }

  // ── counters ──────────────────────────────────────────────────────
  /** counter increases for one Beijing day, each (node, kind) clipped to its switch. */
  async ctrDay(day, T, endCap) {
    const out = [];
    const d0 = dayStart(day), d1 = Math.min(d0 + DAY, endCap);
    for (const n of this.nodes) {
      for (const [kind] of KINDS) {
        const t = T[`${n.id}:${kind}`];
        if (t == null || t >= d1) continue;
        const v = await promIncreaseRange(this.prom, n.counters[kind], Math.max(d0, t), d1);
        out.push({ day, node: n.id, kind, value: v });
      }
    }
    return out;
  }

  /** today's counter values = the inference_nodes snapshot (same numbers as that card) */
  ctrToday(day, T) {
    const snap = this.snapshot.get(this.nodesTarget?.id);
    this.nodesPending = !snap;      // inference_nodes not polled yet (hub just started)
    const out = [];
    const missing = new Set();
    for (const n of this.nodes) {
      for (const [kind, suffix] of KINDS) {
        if (T[`${n.id}:${kind}`] == null) continue;
        const v = snap && snap.online !== false ? snap.metrics?.[`${n.id}_${suffix}`]?.value : null;
        if (typeof v === 'number') out.push({ day, node: n.id, kind, value: v });
        else missing.add(`${n.id}:${kind}`);
      }
    }
    return { rows: out, missing };
  }

  // ── refresh: finalize completed days, then build the live view ────
  async refresh(nowSec = Math.floor(Date.now() / 1000)) {
    if (this._busy) return this._busy;
    this._busy = this._refresh(nowSec).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _refresh(nowSec) {
    const T = await this.switchPoints(nowSec);
    const today = dayOf(nowSec);
    const firstDay = dayOf(this.logsSince);
    const done = new Set(this.db.prepare('SELECT day FROM usage_done').all().map((r) => r.day));
    const live = { ll: [], ctr: [] };
    const partial = new Set();

    // completed days that are not stored yet (one-time backfill, then one per day)
    const insLl = this.db.prepare('INSERT INTO usage_ll (day, api_key, model, endpoint, cov_tok, cov_req, tokens, net, requests) VALUES (@day, @api_key, @model, @endpoint, @cov_tok, @cov_req, @tokens, @net, @requests)');
    const insCtr = this.db.prepare('INSERT OR REPLACE INTO usage_ctr (day, node, kind, value) VALUES (@day, @node, @kind, @value)');
    const markDone = this.db.prepare('INSERT OR REPLACE INTO usage_done (day) VALUES (?)');
    for (let d = firstDay; d < today; d = addDays(d, 1)) {
      if (done.has(d)) continue;
      const d0 = dayStart(d), d1 = d0 + DAY;
      const settled = nowSec >= d1 + SETTLE_SEC;
      try {
        const ll = await this.llWindow(Math.max(d0, this.logsSince), d1, T);
        const ctr = this.prom ? await this.ctrDay(d, T, d1) : [];
        // SpendLogs keeps ~7 days. An old day that comes back empty was most likely pruned
        // while the hub was not running: never store that as a real zero.
        if (!ll.length && nowSec - d1 > 6 * DAY) { partial.add(d); live.ctr.push(...ctr); continue; }
        if (settled) {
          this.db.transaction(() => {
            this.db.prepare('DELETE FROM usage_ll WHERE day = ?').run(d);
            this.db.prepare('DELETE FROM usage_ctr WHERE day = ?').run(d);
            for (const r of ll) insLl.run(r);
            for (const r of ctr) insCtr.run(r);
            markDone.run(d);
          })();
        } else { live.ll.push(...ll); live.ctr.push(...ctr); }
      } catch (e) {
        // A day whose sources failed is neither stored nor guessed: shown from LiteLLM
        // only (nothing covered) until the next refresh succeeds.
        partial.add(d);
        this.lastError = String(e?.message || e);
      }
    }

    // today
    let llToday = [];
    try { llToday = await this.llWindow(Math.max(dayStart(today), this.logsSince), nowSec + 60, T); }
    catch (e) { this.lastError = String(e?.message || e); partial.add(today); }
    const ct = this.ctrToday(today, T);
    // a counter that is due but missing from the snapshot (inference_nodes not polled
    // yet, Prometheus down): its LiteLLM rows are not covered today, so nothing is lost
    if (ct.missing.size) {
      partial.add(today);
      for (const r of llToday) {
        const nd = r.endpoint ? this.nodeOf(r.endpoint) : null;
        if (!nd) continue;
        if (ct.missing.has(`${nd.node.id}:${COVER[nd.type].tok}`)) r.cov_tok = 0;
        if (ct.missing.has(`${nd.node.id}:${COVER[nd.type].req}`)) r.cov_req = 0;
      }
    }
    live.ll.push(...llToday);
    live.ctr.push(...ct.rows);

    const stored = {
      ll: this.db.prepare('SELECT * FROM usage_ll').all(),
      ctr: this.db.prepare('SELECT * FROM usage_ctr').all(),
    };
    let legacy = [];
    try { legacy = await this.legacyRows(); } catch (e) { this.lastError = String(e?.message || e); }

    const speed = await this.speed(nowSec);
    this._state = this.build({ ll: [...legacy, ...stored.ll, ...live.ll], ctr: [...stored.ctr, ...live.ctr] }, {
      today, T, partial: [...partial], speed,
    });
    return this._state;
  }

  /** live generation throughput: Σ rate(generated tokens[1m]) per node */
  async speed(nowSec) {
    if (!this.prom) return { total: null, nodes: [] };
    const nodes = [];
    let total = 0, any = false;
    for (const n of this.nodes) {
      const sels = n.counters.generated;
      if (!sels || !sels.length) continue;
      let v = 0, ok = false;
      for (const sel of sels) {
        try {
          const r = await promQuery(this.prom, `sum(rate(${sel}[1m]))`, nowSec);
          if (r.length) { v += Number(r[0].value?.[1]) || 0; ok = true; }
        } catch { /* leave this node unknown */ }
      }
      nodes.push({ node: n.id, tps: ok ? Math.round(v * 10) / 10 : null });
      if (ok) { any = true; total += v; }
    }
    const t = Math.round(total * 10) / 10;
    return { total: any && t > 0 ? t : null, nodes };
  }

  // ── the view ──────────────────────────────────────────────────────
  build({ ll, ctr }, { today, T, partial, speed }) {
    const zero = () => ({ tok: 0, net: 0, req: 0, llTok: 0, llNet: 0, llReq: 0 });
    const days = new Map();          // day -> Map(classKey -> agg)
    const keys = new Map();          // api_key -> Map(day -> {tok, net, req})
    const at = (day, cls) => {
      if (!days.has(day)) days.set(day, new Map());
      const m = days.get(day);
      if (!m.has(cls)) m.set(cls, zero());
      return m.get(cls);
    };
    for (const r of ll) {
      const regex = this.classOf(r.model);
      const nd = r.cov_tok || r.cov_req ? this.nodeOf(r.endpoint) : null;
      const counterCls = nd ? this.classByCounters[nd.type] || regex : regex;
      const effTok = r.cov_tok ? counterCls : regex;   // where this row's tokens show up
      const effReq = r.cov_req ? counterCls : regex;
      const a = at(r.day, effTok);
      a.llTok += r.tokens; a.llNet += r.net;
      if (!r.cov_tok) { a.tok += r.tokens; a.net += r.net; }
      const b = at(r.day, effReq);
      b.llReq += r.requests;
      if (!r.cov_req) b.req += r.requests;
      // Per-Project / Clients: the chat share of each key (tokens and requests separately,
      // each by its own effective class)
      if (effTok === this.chatKey || effReq === this.chatKey) {
        if (!keys.has(r.api_key)) keys.set(r.api_key, new Map());
        const km = keys.get(r.api_key);
        if (!km.has(r.day)) km.set(r.day, { tok: 0, net: 0, req: 0 });
        const k = km.get(r.day);
        if (effTok === this.chatKey) { k.tok += r.tokens; k.net += r.net; }
        if (effReq === this.chatKey) k.req += r.requests;
      }
    }
    // A chat counter with tokens but no `net` selectors: its net is unknown, so it counts
    // as all-new rather than leaving the class short.
    const hasNet = new Set(ctr.filter((c) => c.kind === 'net').map((c) => `${c.day}|${c.node}`));
    for (const c of ctr) {
      if (c.kind === 'tokens' && !hasNet.has(`${c.day}|${c.node}`)) { const cls = this.classByCounters.chat; if (cls) at(c.day, cls).net += c.value; }
      const kindDef = KINDS.find(([k]) => k === c.kind);
      const cls = kindDef ? this.classByCounters[kindDef[2]] : null;
      if (!cls) continue;
      const a = at(c.day, cls);
      if (c.kind === 'tokens') a.tok += c.value;
      else if (c.kind === 'net') a.net += c.value;
      else if (c.kind === 'requests' || c.kind === 'embed_requests') a.req += c.value;
      else if (c.kind === 'embed_tokens') { a.tok += c.value; a.net += c.value; }   // embedding: no cache
    }
    // every calendar day from the first one with data to today, gaps as zeros
    const allDays = [...days.keys()].sort();
    const first = allDays[0] || today;
    const dayList = [];
    for (let d = first; d <= today; d = addDays(d, 1)) dayList.push(d);

    this._view = { days, keys, dayList, today, T, partial, speed };
    return this._view;
  }

  // ── outputs ───────────────────────────────────────────────────────
  get ready() { return !!this._view; }

  sum(dayFilter, cls) {
    const v = this._view;
    const s = { tok: 0, net: 0, req: 0, llTok: 0, llNet: 0, llReq: 0 };
    for (const [d, m] of v.days) {
      if (!dayFilter(d)) continue;
      for (const [k, a] of m) {
        if (cls && k !== cls) continue;
        for (const f of Object.keys(s)) s[f] += a[f];
      }
    }
    return s;
  }

  coverage() {
    const v = this._view;
    return Object.entries(v.T).map(([k, t]) => { const [node, kind] = k.split(':'); return { node, kind, since: t }; })
      .sort((a, b) => a.since - b.since);
  }

  /** the Token Usage card (same shape the token renderer always took, plus v2.24 fields) */
  card(totalLabel) {
    const v = this._view;
    const isToday = (d) => d === v.today;
    const all = () => true;
    const columns = this.classes.map((c) => {
      const a = this.sum(all, c.key), t = this.sum(isToday, c.key);
      return {
        key: c.key, label: c.label, color: c.color,
        all: compact(a.tok), all_raw: a.tok, today: compact(t.tok), today_raw: t.tok,
        net_today: compact(t.net), net_today_raw: t.net,
        requests: t.req, requests_all: a.req,
        ll_today: compact(t.llTok), ll_today_raw: t.llTok,
      };
    });
    const A = this.sum(all), Tt = this.sum(isToday);
    columns.push({
      key: 'total', label: totalLabel || 'Total', color: '#eef3fb',
      all: compact(A.tok), all_raw: A.tok, today: compact(Tt.tok), today_raw: Tt.tok,
      net_today: compact(Tt.net), net_today_raw: Tt.net, requests: Tt.req, requests_all: A.req,
      ll_today: compact(Tt.llTok), ll_today_raw: Tt.llTok,
    });
    const last5 = v.dayList.slice(-5);
    const spark = last5.map((d) => { const s = this.sum((x) => x === d); return { label: d.slice(5), value: s.tok, display: compact(s.tok) }; });
    return {
      columns, spark, today: v.today,
      speed: v.speed.total, speed_nodes: v.speed.nodes,
      coverage: this.coverage(), legacy_before: dayOf(this.logsSince), partial: v.partial,
    };
  }

  /** the detail modal: last `n` Beijing days (24h = today) */
  detail(n, totalLabel) {
    const v = this._view;
    const dl = v.dayList.slice(-n);
    const inRange = new Set(dl);
    const matrix = {};
    for (const c of this.classes) matrix[c.key] = dl.map((d) => v.days.get(d)?.get(c.key)?.tok || 0);
    const tot = this.sum((d) => inRange.has(d));
    const table = this.classes.map((c) => {
      const s = this.sum((d) => inRange.has(d), c.key);
      return {
        label: c.label, color: c.color, tokens: compact(s.tok), requests: s.req,
        share: tot.tok > 0 ? Math.round((s.tok / tot.tok) * 100) : 0,
        net: compact(s.net), net_pct: s.tok > 0 ? Math.round((s.net / s.tok) * 100) : null,
        ll: compact(s.llTok), raw: s.tok,
      };
    }).filter((r, i) => this.classes[i].key !== 'fallback' || r.raw > 0 || r.requests > 0);
    table.push({ label: totalLabel || 'Total', color: '#eef3fb', tokens: compact(tot.tok), requests: tot.req, share: 100,
      net: compact(tot.net), net_pct: tot.tok > 0 ? Math.round((tot.net / tot.tok) * 100) : null, ll: compact(tot.llTok), total: true });
    return {
      series: { days: dl.map((d) => d.slice(5)), classes: this.classes.map((c) => ({ key: c.key, label: c.label, color: c.color })), matrix },
      table, coverage: this.coverage(), legacy_before: dayOf(this.logsSince), today: v.today,
    };
  }

  /** per api_key chat usage, plus the direct row; Σ rows + direct = the Chat class total */
  projects() {
    const v = this._view;
    const d7 = new Set(v.dayList.slice(-7)), d30 = new Set(v.dayList.slice(-30));
    const rows = [];
    for (const [raw, m] of v.keys) {
      const r = { project: keyLabel(raw), raw_key: raw, tokens_total: 0, net_total: 0, requests_total: 0, tokens_7d: 0, tokens_30d: 0, tokens_today: 0, requests_today: 0, first_day: null, last_day: null };
      for (const [d, a] of [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        r.tokens_total += a.tok; r.net_total += a.net; r.requests_total += a.req;
        if (d7.has(d)) r.tokens_7d += a.tok;
        if (d30.has(d)) r.tokens_30d += a.tok;
        if (d === v.today) { r.tokens_today += a.tok; r.requests_today += a.req; }
        if (a.tok || a.req) { r.first_day = r.first_day || d; r.last_day = d; }
      }
      if (r.tokens_total || r.requests_total) rows.push(r);
    }
    // direct = what the counters saw minus what LiteLLM delivered, per day
    const dr = { project: '直连（未经 LiteLLM）', project_en: 'Direct (not via LLM)', direct: true, tokens_total: 0, net_total: 0, requests_total: 0, tokens_7d: 0, tokens_30d: 0, tokens_today: 0, requests_today: 0, first_day: null, last_day: null };
    for (const d of v.dayList) {
      const a = v.days.get(d)?.get(this.chatKey);
      if (!a) continue;
      const tok = a.tok - a.llTok, net = a.net - a.llNet, req = a.req - a.llReq;
      dr.tokens_total += tok; dr.net_total += net; dr.requests_total += req;
      if (d7.has(d)) dr.tokens_7d += tok;
      if (d30.has(d)) dr.tokens_30d += tok;
      if (d === v.today) { dr.tokens_today += tok; dr.requests_today += req; }
      if (tok || req) { dr.first_day = dr.first_day || d; dr.last_day = d; }
    }
    rows.push(dr);
    rows.sort((a, b) => b.tokens_total - a.tokens_total);
    return rows;
  }

  /** api_key -> usage, for the Clients panel (same numbers as the Per-Project rows) */
  clientUsage() {
    const m = new Map();
    for (const r of this.projects()) {
      if (r.direct) continue;
      m.set(r.raw_key, { tokens_total: r.tokens_total, net_total: r.net_total, requests_total: r.requests_total,
        tokens_today: r.tokens_today, requests_today: r.requests_today, last_day: r.last_day });
    }
    return m;
  }
}
