// SQLite timeseries (§5.3).
// Table metrics(ts, target, metric, value) with (target, metric, ts) index.
// Writes are downsampled to >=5s per (target, metric). Default 30d retention,
// cleaned hourly. data/homenet.db lives on a mounted volume.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DOWNSAMPLE_SEC = 5;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
// B19: read-side downsampling. A pane is a few hundred pixels wide, so returning one
// point per stored sample is pure waste (24h was ~14.5k points per metric). Bucket the
// window into this many slots and return each bucket's min and max, which keeps every
// spike — a plain "every Nth sample" would drop them.
const MAX_BUCKETS = 250;

export class Tsdb {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        ts     INTEGER NOT NULL,
        target TEXT    NOT NULL,
        metric TEXT    NOT NULL,
        value  REAL    NOT NULL
      );
      -- B21: covering index. (target, metric, ts) located the rows fine, but "value"
      -- was not in it, so every matched row still cost a table lookup to fetch it --
      -- 418k lookups for a single metric at range=30d. That, not the scan, is what
      -- made a 30d pane take seconds. Trailing "value" lets the bucket queries read
      -- straight off the index (EXPLAIN now says COVERING INDEX) and never touch the
      -- table. Built here in the constructor, which runs before the scheduler starts
      -- and before we listen, so the ~25s first build cannot contend with a writer:
      -- handlePush() calls record() with no try/catch, and a SQLITE_BUSY from a
      -- concurrent build would surface as a 500 on /api/push and drop that sample.
      CREATE INDEX IF NOT EXISTS idx_target_metric_ts_value ON metrics(target, metric, ts, value);
      -- (target, metric, ts) is a strict prefix of the index above, so it can serve
      -- nothing the covering one cannot. Dropping it frees ~455MB and one B-tree
      -- update per INSERT. Ordered after the CREATE so there is never a window with
      -- neither index present.
      DROP INDEX IF EXISTS idx_target_metric_ts;
    `);
    this._ins = this.db.prepare('INSERT INTO metrics (ts, target, metric, value) VALUES (?, ?, ?, ?)');
    this._insMany = this.db.transaction((ts, rows) => {
      for (const [target, metric, value] of rows) this._ins.run(ts, target, metric, value);
    });
    this._qOne = this.db.prepare(
      'SELECT ts, value FROM metrics WHERE target = ? AND metric = ? AND ts >= ? ORDER BY ts ASC'
    );
    // B19: the index is (target, metric, ts), so `DISTINCT metric WHERE target=?` has
    // no way to skip to each metric's first row — it scanned every row the target ever
    // wrote (2.9M rows / ~250ms) just to name 7 metrics. This recursive form is the
    // classic loose index scan: one seek per distinct value, ~0.3ms.
    this._qMetrics = this.db.prepare(`
      WITH RECURSIVE m(x) AS (
        SELECT MIN(metric) FROM metrics WHERE target = :t
        UNION ALL
        SELECT (SELECT MIN(metric) FROM metrics WHERE target = :t AND metric > m.x)
          FROM m WHERE m.x IS NOT NULL
      )
      SELECT x AS metric FROM m WHERE x IS NOT NULL
    `);
    // Per bucket: the min and the max, each with the timestamp it actually occurred at.
    // Relies on SQLite's documented bare-column rule — with min()/max() as the only
    // aggregate, bare columns come from the matching row — so tmin/tmax are real
    // sample times, not bucket edges, and the two points can be emitted in true order.
    this._qBucket = this.db.prepare(`
      SELECT a.tmin, a.vmin, x.tmax, x.vmax FROM
        (SELECT CAST(ts / :w AS INTEGER) AS b, ts AS tmin, MIN(value) AS vmin
           FROM metrics WHERE target = :t AND metric = :m AND ts >= :s
           GROUP BY CAST(ts / :w AS INTEGER)) a
        JOIN
        (SELECT CAST(ts / :w AS INTEGER) AS b, ts AS tmax, MAX(value) AS vmax
           FROM metrics WHERE target = :t AND metric = :m AND ts >= :s
           GROUP BY CAST(ts / :w AS INTEGER)) x
        ON a.b = x.b
      ORDER BY a.b ASC
    `);
    this._lastWrite = new Map(); // "target|metric" -> ts(sec)
  }

  // Record a batch of [target, metric, value] tuples, downsampling per series.
  record(rows) {
    const tsSec = Math.floor(Date.now() / 1000);
    const keep = [];
    for (const r of rows) {
      const [target, metric, value] = r;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const key = target + '|' + metric;
      const last = this._lastWrite.get(key) || 0;
      if (tsSec - last < DOWNSAMPLE_SEC) continue;
      this._lastWrite.set(key, tsSec);
      keep.push([target, metric, value]);
    }
    if (keep.length) this._insMany(tsSec, keep);
    return keep.length;
  }

  // Bucket width for the requested window, or 0 when the window is already coarse
  // enough that bucketing would not drop a single point.
  _bucketWidth(sinceSec) {
    const span = Math.max(1, Math.floor(Date.now() / 1000) - sinceSec);
    const w = Math.ceil(span / MAX_BUCKETS);
    return w > DOWNSAMPLE_SEC ? w : 0;
  }

  // Single series: [{ts, value}] (ts in seconds), downsampled to <=2*MAX_BUCKETS points.
  history(target, metric, sinceSec) {
    const w = this._bucketWidth(sinceSec);
    if (!w) return this._qOne.all(target, metric, sinceSec);
    const out = [];
    for (const r of this._qBucket.all({ w, t: target, m: metric, s: sinceSec })) {
      // Flat bucket: one point is enough. Otherwise emit both extremes, earliest first,
      // so the series stays monotonic in ts and the spike keeps its real position.
      if (r.vmin === r.vmax) { out.push({ ts: r.tmin, value: r.vmin }); continue; }
      if (r.tmin <= r.tmax) out.push({ ts: r.tmin, value: r.vmin }, { ts: r.tmax, value: r.vmax });
      else                  out.push({ ts: r.tmax, value: r.vmax }, { ts: r.tmin, value: r.vmin });
    }
    return out;
  }

  // All sampled metrics for a target: { metric: [{ts,value}] }.
  historyTarget(target, sinceSec) {
    const metrics = this._qMetrics.all({ t: target }).map((r) => r.metric);
    const out = {};
    for (const m of metrics) out[m] = this.history(target, m, sinceSec);
    return out;
  }

  cleanup() {
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 24 * 3600;
    const info = this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
    if (info.changes) console.log(`[tsdb:cleanup] removed ${info.changes} rows older than ${RETENTION_DAYS}d`);
    return info.changes;
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

export const RANGE_SEC = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
