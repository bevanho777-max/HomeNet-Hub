// node_usage.js (v2.46) — the summary line at the top of an inference node's detail (the 推理节点
// column, or the machine card of the same id): the node's tokens / tokens via LiteLLM / requests
// over the window the modal shows, and its tokens since the hub began recording it.
//
// The numbers are the very series the modal's charts draw underneath: the inference_nodes
// target's <node>_tokens, _ll_tokens, _reqs, _ll_reqs -- each the running total of the Beijing
// day so far (nodes.js), so a day's figure is the top of its sawtooth. Days are Beijing calendar
// days: 1d (24h) = today, 3d = today and the two days before, 7d / 30d likewise.
//
// A finished day is read from the timeseries once (both tiers; the highest value of the day --
// a poll that started before midnight may be written up to LATE_SEC after it, so a sample is
// placed on the day of (its time - LATE_SEC)) and stored in node_usage_day, never recomputed: the
// 5-minute tier keeps 30 days, the stored days stay for the running total. Today is the target's
// current value (the line's last point), taken from the snapshot when it belongs to today.
import { dayOf, dayStart } from './usage.js';

const KINDS = ['tokens', 'll_tokens', 'reqs', 'll_reqs'];
const DAY = 86400;
const TZ = 8 * 3600;
const LATE_SEC = 120;
const SETTLE_SEC = 600;           // a day is final 10 min after it ends
export const RANGE_DAYS = { '1d': 1, '24h': 1, '3d': 3, '7d': 7, '30d': 30 };

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);
const dayOfNum = (dn) => new Date(dn * DAY * 1000).toISOString().slice(0, 10);

export class NodeUsageDays {
  /** @param tsdb  the Tsdb (its database holds the table too) */
  constructor(tsdb, { snapshot }) {
    this.tsdb = tsdb;
    this.db = tsdb.db;
    this.snapshot = snapshot;
    this.db.exec(`CREATE TABLE IF NOT EXISTS node_usage_day (
      node TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL,
      PRIMARY KEY (node, day, kind)) WITHOUT ROWID;`);
    this._days = this.db.prepare('SELECT day, kind, value FROM node_usage_day WHERE node = ? AND day >= ? AND day < ?');
    this._have = this.db.prepare('SELECT day FROM node_usage_day WHERE node = ? AND kind = ?');
    this._put = this.db.prepare('INSERT OR IGNORE INTO node_usage_day (node, day, kind, value) VALUES (?, ?, ?, ?)');
    this._all = this.db.prepare('SELECT kind, SUM(value) AS v, MIN(day) AS d FROM node_usage_day WHERE node = ? GROUP BY kind');
    // the top of each Beijing day, per tier (the day number = (ts - LATE_SEC + TZ) / DAY)
    this._rawDays = this.db.prepare(`SELECT CAST((ts - ${LATE_SEC} + ${TZ}) / ${DAY} AS INTEGER) AS dn, MAX(value) AS v
      FROM metrics WHERE target = ? AND metric = ? AND ts >= ? AND ts < ? GROUP BY dn`);
    this._aggDays = this.db.prepare(`SELECT CAST((tmax - ${LATE_SEC} + ${TZ}) / ${DAY} AS INTEGER) AS dn, MAX(vmax) AS v
      FROM metrics_5m WHERE target = ? AND metric = ? AND bucket >= ? AND bucket < ? GROUP BY dn`);
    this._store = this.db.transaction((rows) => { for (const r of rows) this._put.run(...r); });
    this.filledAt = 0;
  }

  /** the top of each day in [fromSec, toSec), from both tiers: Map day -> value */
  _dayTops(target, metric, fromSec, toSec) {
    const out = new Map();
    const add = (rows) => { for (const r of rows) { const d = dayOfNum(r.dn); if (!(out.get(d) >= r.v)) out.set(d, r.v); } };
    add(this._aggDays.all(target, metric, fromSec - 300, toSec));
    add(this._rawDays.all(target, metric, fromSec, toSec));
    return out;
  }

  /**
   * Store every finished day of every node and kind not stored yet (the first run: every day
   * the timeseries still has). Cheap: one indexed range per series.
   */
  fill(target, nodes, now = Date.now() / 1000) {
    if (!target) return 0;
    const today = dayOf(now);
    // the newest day that is final: yesterday, once today is SETTLE_SEC old
    const lastFinal = now - dayStart(today) >= SETTLE_SEC ? addDays(today, -1) : addDays(today, -2);
    const rows = [];
    for (const node of nodes) {
      for (const kind of KINDS) {
        const have = new Set(this._have.all(node, kind).map((r) => r.day));
        const tops = this._dayTops(target, `${node}_${kind}`, now - 40 * DAY, dayStart(addDays(lastFinal, 1)) + LATE_SEC);
        for (const [day, v] of tops) if (day <= lastFinal && !have.has(day)) rows.push([node, day, kind, v]);
      }
    }
    if (rows.length) this._store(rows);
    this.filledAt = now;
    return rows.length;
  }

  /** today's figures: the target's current values when they belong to today, else the timeseries */
  _today(target, node, now) {
    const today = dayOf(now), t0 = dayStart(today);
    const snap = this.snapshot?.get?.(target);
    const out = {};
    for (const kind of KINDS) {
      const m = `${node}_${kind}`;
      if (Number(snap?.extra?.day_start) === t0 && typeof snap?.metrics?.[m]?.value === 'number') { out[kind] = snap.metrics[m].value; continue; }
      const tops = this._dayTops(target, m, t0, now + 60);
      if (tops.has(today)) out[kind] = tops.get(today);
    }
    return out;
  }

  /**
   * { range, days, from, to, tokens, ll_tokens, reqs, ll_reqs, missing: [days without data],
   *   total: { tokens, ll_tokens, reqs, ll_reqs, since } }; a kind the node never recorded is null
   */
  summary(target, node, range, nodes = [node], now = Date.now() / 1000) {
    if (now - this.filledAt > 3600) this.fill(target, nodes, now);
    const n = RANGE_DAYS[range] || 1;
    const today = dayOf(now), from = addDays(today, -(n - 1));
    const sums = Object.fromEntries(KINDS.map((k) => [k, null]));
    const seen = new Set();
    const add = (kind, day, v) => { if (typeof v !== 'number' || !Number.isFinite(v)) return; sums[kind] = (sums[kind] || 0) + v; seen.add(day); };
    for (const r of this._days.all(node, from, today)) add(r.kind, r.day, r.value);
    const td = this._today(target, node, now);
    for (const kind of KINDS) add(kind, today, td[kind]);
    // days of the window the finished table does not have yet (the last 10 min of a day) or
    // never had (the hub was not recording): read now, not stored
    const missing = [];
    for (let d = from; d < today; d = addDays(d, 1)) {
      if (seen.has(d)) continue;
      let any = false;
      for (const kind of KINDS) {
        const tops = this._dayTops(target, `${node}_${kind}`, dayStart(d), dayStart(addDays(d, 1)) + LATE_SEC);
        if (tops.has(d)) { add(kind, d, tops.get(d)); any = true; }
      }
      if (!any) missing.push(d);
    }
    const total = { since: null };
    for (const r of this._all.all(node)) {
      total[r.kind] = r.v;
      if (r.kind === 'tokens') total.since = r.d;
    }
    // (in the first SETTLE_SEC of a day yesterday is not stored yet: read it for the total too)
    const yday = addDays(today, -1);
    const yStored = new Set(this._days.all(node, yday, today).map((r) => r.kind));
    for (const kind of KINDS) {
      let v = typeof td[kind] === 'number' ? td[kind] : 0, any = typeof td[kind] === 'number';
      if (!yStored.has(kind)) {
        const tops = this._dayTops(target, `${node}_${kind}`, dayStart(yday), dayStart(today) + LATE_SEC);
        if (tops.has(yday)) {
          v += tops.get(yday); any = true;
          if (kind === 'tokens' && (!total.since || yday < total.since)) total.since = yday;
        }
      }
      if (any) total[kind] = (total[kind] || 0) + v;
      else if (total[kind] == null) total[kind] = null;
    }
    if (!total.since && typeof td.tokens === 'number') total.since = today;
    return { node, range, days: n, from, to: today, ...sums, missing, total };
  }
}
