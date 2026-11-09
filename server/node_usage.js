// node_usage.js (v2.46 summary line; v2.47 THE ledger) — each inference node's usage per Beijing day,
// computed ONCE and read by everything that shows it: the Token Usage card (its per-node part), the
// 推理节点 card (today), the node detail's charts and its summary line.
//
// Today:        the inference_nodes target's live figures (collectors/nodes.js nodeFigures over
//               [midnight, now], every minute) -- the card, the chart's last point, the Token Usage card.
// A finished day: nodeFigures over the whole day, run at 00:10 (finalize), stored in node_day with
//               method 'v2.47'. The chart's line for that day then ends on a settled point at 23:59:59
//               holding exactly that figure (no sample of the day above it).
// Older days (backfill, once): recomputed the same way where the raw records still exist -- the
//               counters in Prometheus (15 days) and, where the figure needs them (a minute the counter
//               did not cover, a server restart), LiteLLM's per-request log (7 days); without the
//               per-request log a day whose counter covered it whole and never restarted is still exact.
//               Anything else keeps the figure the Token Usage card had stored (usage_ctr / usage_ll),
//               method 'legacy' -- drawn as 「旧口径」 on the charts, never silently mixed in.
//
// check(day) (00:10, after finalize): the same day as each place shows it -- the ledger, the chart's
// last point, the Token Usage card's per-node figure, the summary line -- must be equal; a difference is
// logged and stored (usage_check), and health-lite reports it (GET /api/usage-check).
import { dayOf, dayStart } from './usage.js';
import { nodeFigures, nodesOf, llRequestsWindow, KIND_KEYS, covered, promQuery } from './collectors/nodes.js';

export const METHOD = 'v2.47';
const KEYS = ['tokens', 'net', 'reqs', 'emb_tokens', 'emb_reqs', 'll_tokens', 'll_reqs', 'emb_ll_tokens', 'emb_ll_reqs'];
const CHECK_KEYS = ['tokens', 'reqs', 'll_tokens', 'll_reqs'];
const DAY = 86400;
const SETTLE_SEC = 600;
export const RANGE_DAYS = { '1d': 1, '24h': 1, '3d': 3, '7d': 7, '30d': 30 };
// usage_ctr kind -> ledger key (the Token Usage card's own day table)
const CTR_KEY = { tokens: 'tokens', net: 'net', requests: 'reqs', embed_tokens: 'emb_tokens', embed_requests: 'emb_reqs' };
export const LEDGER_TO_CTR = { tokens: 'tokens', net: 'net', reqs: 'requests', emb_tokens: 'embed_tokens', emb_reqs: 'embed_requests' };

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);

export class NodeLedger {
  constructor(tsdb, { snapshot, env }) {
    this.tsdb = tsdb;
    this.db = tsdb.db;
    this.snapshot = snapshot;
    this.env = env;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_day (
        node TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL,
        method TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (node, day, kind)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS usage_check (day TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, report TEXT NOT NULL);
      DROP TABLE IF EXISTS node_usage_day;
    `);
    this._day = this.db.prepare('SELECT kind, value, method FROM node_day WHERE node = ? AND day = ?');
    this._range = this.db.prepare('SELECT day, kind, value, method FROM node_day WHERE node = ? AND day >= ? AND day < ?');
    this._all = this.db.prepare("SELECT kind, SUM(value) AS v FROM node_day WHERE node = ? GROUP BY kind");
    this._first = this.db.prepare("SELECT MIN(day) AS d FROM node_day WHERE node = ? AND kind = 'tokens'");
    this._legacyDays = this.db.prepare("SELECT DISTINCT day FROM node_day WHERE node = ? AND method <> ? AND day >= ? AND day < ? ORDER BY day");
    this._put = this.db.prepare('INSERT OR REPLACE INTO node_day (node, day, kind, value, method, at) VALUES (?, ?, ?, ?, ?, ?)');
    this._store = this.db.transaction((rows) => { for (const r of rows) this._put.run(...r); });
    this._checkPut = this.db.prepare('INSERT OR REPLACE INTO usage_check (day, at, ok, report) VALUES (?, ?, ?, ?)');
    this._checkGet = this.db.prepare('SELECT * FROM usage_check WHERE day = ?');
    this._checkLast = this.db.prepare('SELECT * FROM usage_check ORDER BY day DESC LIMIT 1');
    this._lastRaw = this.db.prepare('SELECT ts, value FROM metrics WHERE target = ? AND metric = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1');
    this._last5m = this.db.prepare('SELECT tmax AS ts, vmax AS value FROM metrics_5m WHERE target = ? AND metric = ? AND bucket >= ? AND bucket < ? ORDER BY bucket DESC, tmax DESC LIMIT 1');
    this._clampRaw = this.db.prepare('UPDATE metrics SET value = ? WHERE target = ? AND metric = ? AND ts >= ? AND ts < ? AND value > ?');
    this._clamp5m = this.db.prepare(`UPDATE metrics_5m SET vmax = MIN(vmax, :v), vmin = MIN(vmin, :v), vavg = MIN(vavg, :v)
      WHERE target = :t AND metric = :m AND bucket >= :a AND bucket < :b AND vmax > :v`);
    this._dropAt = this.db.prepare('DELETE FROM metrics WHERE target = ? AND metric = ? AND ts = ?');
    this.target = null;
    this.busy = null;
  }

  /** the inference_nodes target (re-read on every config reload) */
  configure(target) {
    this.target = target || null;
    this.nodes = target ? nodesOf(target) : [];
  }

  get ids() { return this.nodes.map((n) => n.id); }

  /** does the ledger have this (finished) day for any node */
  hasDay(day) { return this.ids.some((id) => !!this.stored(id, day)); }

  // ── reading ───────────────────────────────────────────────────────
  /** a stored day: { figures: { key: value }, method } or null */
  stored(node, day) {
    const rows = this._day.all(node, day);
    if (!rows.length) return null;
    const figures = {};
    for (const r of rows) figures[r.kind] = r.value;
    return { figures, method: rows[0].method };
  }

  /** today's figures: the live ones the card shows, when the snapshot belongs to today */
  today(node, nowSec = Date.now() / 1000) {
    const snap = this.target ? this.snapshot?.get?.(this.target.id) : null;
    if (!snap || Number(snap.extra?.day_start) !== dayStart(dayOf(nowSec))) return null;
    const figures = {};
    for (const k of KEYS) { const v = snap.metrics?.[`${node}_${k}`]?.value; if (typeof v === 'number') figures[k] = v; }
    return Object.keys(figures).length ? { figures, method: 'live' } : null;
  }

  /** a day as everything shows it: stored when finished, live today */
  dayFigures(node, day, nowSec = Date.now() / 1000) {
    return day === dayOf(nowSec) ? this.today(node, nowSec) : this.stored(node, day);
  }

  /** the summary line: the window (Beijing days) and the node's total since recording began */
  summary(node, range, nowSec = Date.now() / 1000) {
    const n = RANGE_DAYS[range] || 1;
    const today = dayOf(nowSec), from = addDays(today, -(n - 1));
    const sums = Object.fromEntries(KEYS.map((k) => [k, null]));
    const seen = new Set(), methods = new Map();
    const add = (day, k, v, method) => { if (typeof v !== 'number') return; sums[k] = (sums[k] || 0) + v; seen.add(day); methods.set(day, method); };
    for (const r of this._range.all(node, from, today)) add(r.day, r.kind, r.value, r.method);
    const td = this.today(node, nowSec);
    if (td) for (const [k, v] of Object.entries(td.figures)) add(today, k, v, 'live');
    const missing = [];
    for (let d = from; d < today; d = addDays(d, 1)) if (!seen.has(d)) missing.push(d);
    const legacy = [...methods].filter(([, m]) => m !== METHOD && m !== 'live').map(([d]) => d).sort();
    const total = { since: this._first.get(node)?.d || (td ? today : null) };
    for (const r of this._all.all(node)) total[r.kind] = r.v;
    if (td) for (const [k, v] of Object.entries(td.figures)) total[k] = (total[k] || 0) + v;
    for (const k of KEYS) if (total[k] == null) total[k] = null;
    total.legacy_days = this._legacyDays.all(node, METHOD, '0000', today).map((r) => r.day);
    return { node, range, days: n, from, to: today, ...sums, missing, legacy, total };
  }

  /** the chart's last point of a day (both tiers) */
  chartLast(node, key, day) {
    const t = this.target?.id;
    const a = dayStart(day), b = a + DAY;
    return this._lastRaw.get(t, `${node}_${key}`, a, b) || this._last5m.get(t, `${node}_${key}`, a, b) || null;
  }

  // ── computing ─────────────────────────────────────────────────────
  /** when Prometheus' and LiteLLM's raw records begin (to know which days can be recomputed) */
  async sources() {
    const out = { prom: null, logs: null };
    const p = this.target?.source?.prometheus;
    if (p) {
      try {
        // (the oldest sample Prometheus still keeps of anything: its retention edge)
        const r = await promQuery(p, 'min(min_over_time(timestamp(up)[40d:10m]))', Math.floor(Date.now() / 1000));
        const v = Number(r[0]?.value?.[1]);
        if (Number.isFinite(v)) out.prom = v;
      } catch { /* unknown: treated as not available */ }
    }
    try { out.logs = await this._firstLog(); } catch { /* no LiteLLM: no per-request rows */ }
    return out;
  }

  async _firstLog() {
    // the oldest row LiteLLM still keeps: a 1-row window search from the epoch would scan everything,
    // so ask day by day backwards from 10 days ago (the log keeps ~7)
    const now = Math.floor(Date.now() / 1000);
    let first = null;
    for (let d = 10; d >= 0; d--) {
      const a = dayStart(dayOf(now - d * DAY));
      const rows = await llRequestsWindow(this.target.source, this.env, this.nodes, a + 3600, a + DAY);
      if (rows.length) { first = Math.min(...rows.map((r) => r.st)); break; }
    }
    return first;
  }

  /**
   * nodeFigures for every node over a finished day. `full`: LiteLLM's per-request rows cover the
   * day. Without them a node-day is exact only when its counters covered the whole day and never
   * restarted (the rows add nothing then); such a day takes LiteLLM's shares from usage_ll.
   */
  async computeDay(day, { full = true } = {}) {
    const a = dayStart(day), b = a + DAY;
    const p = this.target?.source?.prometheus;
    if (!p) throw new Error('no prometheus');
    const rows = full ? await llRequestsWindow(this.target.source, this.env, this.nodes, a, b) : [];
    const out = {};
    for (const n of this.nodes) {
      const f = await nodeFigures(p, n, a, b, rows, { nowSec: b + SETTLE_SEC });
      const figures = {}, notes = [];
      let exact = true;
      for (const [, key] of KIND_KEYS) {
        const k = f.kinds[key];
        if (!k) continue;
        if (k.error?.code === 'read' && !k.error.soft) { exact = false; notes.push(`${key}: ${k.error.detail}`); continue; }
        figures[key] = f.metrics[key];
        // (no per-request rows: exact only when nothing needed them)
        if (!full && (k.drops.some(([q]) => q >= a && q < b) || !(k.cover.length === 1 && k.cover[0][0] <= a + 60 && k.cover[0][1] >= b - 60))) {
          exact = false; notes.push(`${key}: counter restarted or did not cover the day, and LiteLLM's per-request log is gone`);
        }
        // a counter with no series at all that day (its selectors changed since): cannot be recomputed
        if (!k.cover.length && !k.raw) { exact = false; notes.push(`${key}: no counter series that day`); }
      }
      if (full) {
        figures.ll_tokens = f.ll.tokens; figures.ll_reqs = f.ll.reqs;
        if (n.emb.size) { figures.emb_ll_tokens = f.ll.emb_tokens; figures.emb_ll_reqs = f.ll.emb_reqs; }
      }
      out[n.id] = { figures, exact, notes, kinds: f.kinds };
    }
    return out;
  }

  /** the Token Usage card's own stored figure of a node-day (its v2.24-v2.46 rules), or null */
  legacyDay(node, day) {
    const n = this.nodes.find((x) => x.id === node);
    if (!n) return null;
    const ctr = this.db.prepare('SELECT kind, value FROM usage_ctr WHERE node = ? AND day = ?').all(node, day);
    const ll = this.db.prepare('SELECT endpoint, cov_tok, cov_req, tokens, net, requests FROM usage_ll WHERE day = ?').all(day)
      .filter((r) => n.chat.has(r.endpoint) || n.emb.has(r.endpoint));
    if (!ctr.length && !ll.length) return null;
    const f = {};
    for (const c of ctr) if (CTR_KEY[c.kind]) f[CTR_KEY[c.kind]] = c.value;
    for (const type of ['chat', 'embed']) {
      const mine = ll.filter((r) => (type === 'chat' ? n.chat : n.emb).has(r.endpoint));
      const pre = type === 'chat' ? '' : 'emb_';
      const covTok = mine.filter((r) => r.cov_tok).reduce((x, r) => x + r.tokens, 0);
      const tokKey = `${pre}tokens`, reqKey = `${pre}reqs`;
      // (v2.29 rule: a counter below the LiteLLM tokens it covered -> that node-day is LiteLLM's)
      const broken = typeof f[tokKey] === 'number' && f[tokKey] < covTok;
      const sum = (rows, k) => rows.reduce((x, r) => x + r[k], 0);
      if (broken || typeof f[tokKey] !== 'number') {
        f[tokKey] = sum(mine, 'tokens'); f[reqKey] = sum(mine, 'requests');
        if (!pre) f.net = sum(mine, 'net');
      } else {
        f[tokKey] += sum(mine.filter((r) => !r.cov_tok), 'tokens');
        // (a day before the request counter existed -- m26 until 10-21 --: the card counted LiteLLM's requests)
        f[reqKey] = (typeof f[reqKey] === 'number' ? f[reqKey] : 0) + sum(mine.filter((r) => !r.cov_req), 'requests');
        if (!pre && typeof f.net === 'number') f.net += sum(mine.filter((r) => !r.cov_tok), 'net');
      }
      if (mine.length || type === 'chat') { f[`${pre}ll_tokens`] = sum(mine, 'tokens'); f[`${pre}ll_reqs`] = sum(mine, 'requests'); }
    }
    return f;
  }

  /** store a node-day and make its chart end on it */
  _save(node, day, figures, method) {
    const at = Math.floor(Date.now() / 1000);
    this._store(Object.entries(figures).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([k, v]) => [node, day, k, v, method, at]));
    this.alignChart(node, day, figures);
  }

  /** the day's line ends on a settled point (23:59:59) = the figure, and nothing of that day above it */
  alignChart(node, day, figures) {
    const t = this.target?.id;
    if (!t) return;
    const a = dayStart(day), end = a + DAY - 1;
    const rows = [];
    for (const [k, v] of Object.entries(figures)) {
      if (typeof v !== 'number') continue;
      const m = `${node}_${k}`;
      this._dropAt.run(t, m, end);
      this._clampRaw.run(v, t, m, a, end, v);
      this._clamp5m.run({ v, t, m, a, b: a + DAY });
      rows.push([end, t, m, v]);
    }
    if (rows.length) this.tsdb.recordAt(rows);
  }

  /** 00:10: yesterday, from the raw records (LiteLLM's per-request log covers it) */
  async finalize(day) {
    const res = await this.computeDay(day, { full: true });
    for (const [node, r] of Object.entries(res)) {
      if (!Object.keys(r.figures).length) continue;
      this._save(node, day, r.figures, METHOD);
    }
    return res;
  }

  /**
   * once (and after downtime): every node-day with any record that the ledger does not have yet --
   * recomputed where the raw records allow it, else the Token Usage card's stored figure ('legacy')
   */
  async backfill(nowSec = Math.floor(Date.now() / 1000)) {
    if (!this.target) return { days: 0 };
    const today = dayOf(nowSec);
    const lastFinal = nowSec - dayStart(today) >= SETTLE_SEC ? addDays(today, -1) : addDays(today, -2);
    const src = await this.sources();
    const have = new Set(this.db.prepare('SELECT DISTINCT node || \'|\' || day AS k FROM node_day').all().map((r) => r.k));
    // the days anything recorded for these nodes: the Token Usage card's tables and the chart
    const days = new Set(this.db.prepare('SELECT DISTINCT day FROM usage_ctr').all().map((r) => r.day));
    for (const r of this.db.prepare("SELECT DISTINCT date(tmax + 28800, 'unixepoch') AS d FROM metrics_5m WHERE target = ?").all(this.target.id)) days.add(r.d);
    const list = [...days].filter((d) => d && d <= lastFinal).sort();
    let n = 0;
    const report = [];
    for (const day of list) {
      const todo = this.ids.filter((id) => !have.has(`${id}|${day}`));
      if (!todo.length) continue;
      const a = dayStart(day);
      const promOk = src.prom != null && src.prom <= a - 3600;
      const full = src.logs != null && src.logs <= a;
      let res = null;
      if (promOk) { try { res = await this.computeDay(day, { full }); } catch (e) { report.push(`${day}: ${e?.message || e}`); } }
      for (const node of todo) {
        const r = res?.[node];
        const leg = this.legacyDay(node, day);
        if (r && r.exact && Object.keys(r.figures).length) {
          // without the per-request log, LiteLLM's shares come from the card's stored day
          if (!full && leg) for (const k of ['ll_tokens', 'll_reqs', 'emb_ll_tokens', 'emb_ll_reqs']) if (typeof leg[k] === 'number') r.figures[k] = leg[k];
          this._save(node, day, r.figures, METHOD);
          report.push(`${node} ${day}: recomputed${full ? '' : ' (counters; LiteLLM shares stored)'}`);
        } else if (leg) {
          this._save(node, day, leg, 'legacy');
          report.push(`${node} ${day}: legacy${r ? ` (${r.notes.join('; ')})` : promOk ? '' : ' (Prometheus no longer has the day)'}`);
        } else continue;
        n += 1;
      }
    }
    return { days: n, report, sources: src };
  }

  // ── the check ─────────────────────────────────────────────────────
  /**
   * every place's figure for a finished day: ledger, chart last point, Token Usage card (usage engine),
   * summary line. ok = all equal for every node and key; `info` lists what is worth knowing but is not a
   * mismatch (LiteLLM above the node's total: a request across midnight, or a counter that lost counts).
   */
  check(day, usage, nowSec = Date.now() / 1000) {
    const rows = [], info = [];
    let ok = true;
    // (today: the live figures -- the 推理节点 card's -- against the chart's newest point, the summary
    //  line's 1d and the Token Usage card's today; not stored)
    const isToday = day === dayOf(nowSec);
    for (const node of this.ids) {
      const led = this.dayFigures(node, day, nowSec);
      const sumLine = isToday ? this.summary(node, '1d', nowSec) : this.summaryOfDay(node, day);
      const card = usage?.nodeDay?.(day, node) || null;
      for (const key of CHECK_KEYS) {
        const L = led?.figures?.[key] ?? null;
        const C = this.chartLast(node, key, day)?.value ?? null;
        const S = sumLine?.[key] ?? null;
        const T = key === 'tokens' || key === 'reqs' ? (card ? card[key] ?? null : null) : undefined;
        const vals = [L, C, S, ...(T === undefined ? [] : [T])];
        const same = vals.every((v) => v != null && Math.round(v) === Math.round(L));
        if (!same && !(L == null && vals.every((v) => v == null || v === 0))) ok = false;
        rows.push({ node, key, ledger: L, chart: C, summary: S, token_card: T ?? null, same, method: led?.method || null });
      }
      const f = led?.figures || {};
      if (typeof f.ll_tokens === 'number' && typeof f.tokens === 'number' && f.ll_tokens > f.tokens) {
        info.push({ node, note: 'll_above_total', ll_tokens: f.ll_tokens, tokens: f.tokens });
      }
    }
    const report = { day, ok, rows, info, live: isToday };
    if (!isToday) this._checkPut.run(day, Math.floor(Date.now() / 1000), ok ? 1 : 0, JSON.stringify(report));
    return report;
  }

  /** the summary line's figures for one finished day (the same reading the line uses) */
  summaryOfDay(node, day) {
    const out = {};
    for (const r of this._range.all(node, day, addDays(day, 1))) out[r.kind] = r.value;
    return Object.keys(out).length ? out : null;
  }

  lastCheck(day = null) {
    const r = day ? this._checkGet.get(day) : this._checkLast.get();
    return r ? { ...JSON.parse(r.report), at: r.at } : null;
  }
}

export { covered };
