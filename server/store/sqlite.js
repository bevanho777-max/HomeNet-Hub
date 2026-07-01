// SQLite timeseries (§5.3).
// Table metrics(ts, target, metric, value) with (target, metric, ts) index.
// Writes are downsampled to >=5s per (target, metric). Default 30d retention,
// cleaned hourly. data/homenet.db lives on a mounted volume.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DOWNSAMPLE_SEC = 5;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

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
      CREATE INDEX IF NOT EXISTS idx_target_metric_ts ON metrics(target, metric, ts);
    `);
    this._ins = this.db.prepare('INSERT INTO metrics (ts, target, metric, value) VALUES (?, ?, ?, ?)');
    this._insMany = this.db.transaction((ts, rows) => {
      for (const [target, metric, value] of rows) this._ins.run(ts, target, metric, value);
    });
    this._qOne = this.db.prepare(
      'SELECT ts, value FROM metrics WHERE target = ? AND metric = ? AND ts >= ? ORDER BY ts ASC'
    );
    this._qMetrics = this.db.prepare(
      'SELECT DISTINCT metric FROM metrics WHERE target = ?'
    );
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

  // Single series: [{ts, value}] (ts in seconds).
  history(target, metric, sinceSec) {
    return this._qOne.all(target, metric, sinceSec);
  }

  // All sampled metrics for a target: { metric: [{ts,value}] }.
  historyTarget(target, sinceSec) {
    const metrics = this._qMetrics.all(target).map((r) => r.metric);
    const out = {};
    for (const m of metrics) out[m] = this._qOne.all(target, m, sinceSec);
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
