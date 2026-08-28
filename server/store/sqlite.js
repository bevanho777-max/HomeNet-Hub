// SQLite timeseries (§5.3).
// Two tiers. metrics(ts, target, metric, value) holds full-resolution samples for
// RAW_RETENTION_DAYS; metrics_5m holds 5-minute min/max/avg rollups for
// AGG_RETENTION_DAYS. A rollup job folds aged-out raw rows into buckets and deletes
// them in the same transaction, so raw rows are only ever dropped once their bucket
// is durably written. Writes are downsampled to >=5s per (target, metric).
// data/homenet.db lives on a mounted volume.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DOWNSAMPLE_SEC = 5;
// B22: retention is now per tier. RETENTION_DAYS (the old single knob) is still read
// as the aggregate default so an existing deployment that set it keeps its window.
// Raw rows are aggregated once they are AGG_AFTER_DAYS old but are not deleted until
// they are PURGE_AFTER_DAYS old. That gap is a deliberate safety band: for a full day
// a bucket and the samples it was built from coexist, so an aggregation defect that
// slipped past the in-transaction check is still recoverable from raw. The band costs
// one extra day of raw rows (~14MB) and nothing else -- reads never use it, because
// the read boundary is the PURGE watermark, not the aggregation one.
const AGG_AFTER_DAYS = Number(process.env.AGG_AFTER_DAYS || 3);
const PURGE_AFTER_DAYS = Number(process.env.PURGE_AFTER_DAYS || 4);
const AGG_RETENTION_DAYS = Number(process.env.AGG_RETENTION_DAYS || process.env.RETENTION_DAYS || 30);
// B19: read-side downsampling. A pane is a few hundred pixels wide, so returning one
// point per stored sample is pure waste (24h was ~14.5k points per metric). Bucket the
// window into this many slots and return each bucket's min and max, which keeps every
// spike — a plain "every Nth sample" would drop them.
const MAX_BUCKETS = 250;

// B22: rollup tier geometry.
const BUCKET_SEC = 300;
// One transaction per chunk, so a reader never observes half a chunk moved between
// tiers. CHUNK_SEC MUST be a whole number of buckets: a chunk boundary that split a
// bucket would write that bucket from the first half, then INSERT OR REPLACE it from
// the second half, silently dropping the first half's samples.
const CHUNK_SEC = 3600;
// Ceiling on how much backlog one tick drains. Steady state never reaches it (the
// watermark can only advance BUCKET_SEC per BUCKET_SEC of wall clock), so this only
// governs the initial backfill and recovery after downtime.
const MAX_CHUNKS_PER_RUN = 24;

if (CHUNK_SEC % BUCKET_SEC !== 0) throw new Error('CHUNK_SEC must be a multiple of BUCKET_SEC');
// The band must be a real gap, or purge could overtake aggregation and delete rows
// whose bucket was never written.
if (PURGE_AFTER_DAYS <= AGG_AFTER_DAYS) throw new Error('PURGE_AFTER_DAYS must exceed AGG_AFTER_DAYS');

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

      -- B22: the 5-minute tier. WITHOUT ROWID makes the primary key the table itself,
      -- so there is no second copy of the key and every read here is covered.
      -- tmin/tmax are the instants the extremes actually occurred at, exactly as the
      -- raw tier reports them, so both tiers feed the same _expand() below.
      CREATE TABLE IF NOT EXISTS metrics_5m (
        target TEXT    NOT NULL,
        metric TEXT    NOT NULL,
        bucket INTEGER NOT NULL,
        vmin   REAL    NOT NULL,
        vmax   REAL    NOT NULL,
        vavg   REAL    NOT NULL,
        n      INTEGER NOT NULL,
        tmin   INTEGER NOT NULL,
        tmax   INTEGER NOT NULL,
        PRIMARY KEY (target, metric, bucket)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS tsdb_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    this._ins = this.db.prepare('INSERT INTO metrics (ts, target, metric, value) VALUES (?, ?, ?, ?)');
    this._insMany = this.db.transaction((ts, rows) => {
      for (const [target, metric, value] of rows) this._ins.run(ts, target, metric, value);
    });
    this._qOne = this.db.prepare(
      'SELECT ts, value FROM metrics WHERE target = ? AND metric = ? AND ts >= ? ORDER BY ts ASC'
    );
    // B19: the index leads with (target, metric), so `DISTINCT metric WHERE target=?`
    // has no way to skip to each metric's first row — it scanned every row the target
    // ever wrote (2.9M rows / ~250ms) just to name 7 metrics. This recursive form is
    // the classic loose index scan: one seek per distinct value, ~0.3ms.
    const looseMetrics = (table) => `
      WITH RECURSIVE m(x) AS (
        SELECT MIN(metric) FROM ${table} WHERE target = :t
        UNION ALL
        SELECT (SELECT MIN(metric) FROM ${table} WHERE target = :t AND metric > m.x)
          FROM m WHERE m.x IS NOT NULL
      )
      SELECT x AS metric FROM m WHERE x IS NOT NULL`;
    this._qMetrics = this.db.prepare(looseMetrics('metrics'));
    // B22: a metric whose raw rows have all aged out still has history in the 5m tier
    // (m24's litellm metrics stopped being pushed and would otherwise vanish from the
    // pane the moment the rollup passed them). Both tiers are enumerated and unioned.
    this._qMetrics5m = this.db.prepare(looseMetrics('metrics_5m'));
    // B22: same trick one level deeper, to enumerate (target, metric) pairs for the
    // rollup without a full scan. Plain `SELECT DISTINCT target, metric FROM metrics
    // WHERE ts >= ?` cannot use the index at all and would scan every row each tick.
    this._qSeries = this.db.prepare(`
      WITH RECURSIVE
        t(x) AS (
          SELECT MIN(target) FROM metrics
          UNION ALL
          SELECT (SELECT MIN(target) FROM metrics WHERE target > t.x) FROM t WHERE t.x IS NOT NULL
        ),
        tm(tg, me) AS (
          SELECT x, (SELECT MIN(metric) FROM metrics WHERE target = x) FROM t WHERE x IS NOT NULL
          UNION ALL
          SELECT tg, (SELECT MIN(metric) FROM metrics WHERE target = tg AND metric > me)
            FROM tm WHERE me IS NOT NULL
        )
      SELECT tg AS target, me AS metric FROM tm WHERE me IS NOT NULL
    `);
    // B22: oldest raw sample, for seeding the watermark on a database that has never
    // been rolled up. Plain `SELECT MIN(ts) FROM metrics` cannot use an index that
    // leads with target -- it degrades to a scan and cost 1172ms on the 14.6M-row
    // production table. Taking each series' first entry (an index seek apiece) and
    // minimising over those returns the identical value in under a millisecond.
    this._qOldest = this.db.prepare(`
      WITH RECURSIVE
        t(x) AS (
          SELECT MIN(target) FROM metrics
          UNION ALL
          SELECT (SELECT MIN(target) FROM metrics WHERE target > t.x) FROM t WHERE t.x IS NOT NULL
        ),
        tm(tg, me) AS (
          SELECT x, (SELECT MIN(metric) FROM metrics WHERE target = x) FROM t WHERE x IS NOT NULL
          UNION ALL
          SELECT tg, (SELECT MIN(metric) FROM metrics WHERE target = tg AND metric > me)
            FROM tm WHERE me IS NOT NULL
        )
      SELECT MIN((SELECT MIN(ts) FROM metrics WHERE target = tg AND metric = me)) AS ts
        FROM tm WHERE me IS NOT NULL
    `);
    // Per bucket: the min and the max, each with the timestamp it actually occurred at.
    // Relies on SQLite's documented bare-column rule — with min()/max() as the only
    // aggregate, bare columns come from the matching row — so tmin/tmax are real
    // sample times, not bucket edges, and the two points can be emitted in true order.
    // Each subquery therefore carries exactly ONE aggregate; the rule is not documented
    // to survive a second one sharing the SELECT.
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
    // B22: the 5m tier's equivalent, re-bucketed to the same read width and returning
    // the same four columns, so _expand() below is shared verbatim between the tiers.
    // min-of-mins and max-of-maxes are exact, so a spike survives both downsamplings.
    this._qBucket5m = this.db.prepare(`
      SELECT a.tmin, a.vmin, x.tmax, x.vmax FROM
        (SELECT CAST(bucket / :w AS INTEGER) AS b, tmin, MIN(vmin) AS vmin
           FROM metrics_5m WHERE target = :t AND metric = :m AND bucket >= :s AND bucket < :e
           GROUP BY CAST(bucket / :w AS INTEGER)) a
        JOIN
        (SELECT CAST(bucket / :w AS INTEGER) AS b, tmax, MAX(vmax) AS vmax
           FROM metrics_5m WHERE target = :t AND metric = :m AND bucket >= :s AND bucket < :e
           GROUP BY CAST(bucket / :w AS INTEGER)) x
        ON a.b = x.b
      ORDER BY a.b ASC
    `);
    // B22: rollup statements. Three subqueries, one aggregate each, for the same
    // bare-column reason as _qBucket — avg/count cannot share a SELECT with the
    // min/max whose row we are reading ts off.
    this._qRollupIns = this.db.prepare(`
      INSERT OR REPLACE INTO metrics_5m (target, metric, bucket, vmin, vmax, vavg, n, tmin, tmax)
      SELECT :t, :m, a.b * ${BUCKET_SEC}, a.vmin, x.vmax, s.vavg, s.n, a.tmin, x.tmax FROM
        (SELECT ts / ${BUCKET_SEC} AS b, ts AS tmin, MIN(value) AS vmin
           FROM metrics WHERE target = :t AND metric = :m AND ts >= :lo AND ts < :hi
           GROUP BY ts / ${BUCKET_SEC}) a
        JOIN
        (SELECT ts / ${BUCKET_SEC} AS b, ts AS tmax, MAX(value) AS vmax
           FROM metrics WHERE target = :t AND metric = :m AND ts >= :lo AND ts < :hi
           GROUP BY ts / ${BUCKET_SEC}) x ON a.b = x.b
        JOIN
        (SELECT ts / ${BUCKET_SEC} AS b, AVG(value) AS vavg, COUNT(*) AS n
           FROM metrics WHERE target = :t AND metric = :m AND ts >= :lo AND ts < :hi
           GROUP BY ts / ${BUCKET_SEC}) s ON a.b = s.b
    `);
    this._qRollupDel = this.db.prepare(
      'DELETE FROM metrics WHERE target = :t AND metric = :m AND ts >= :lo AND ts < :hi'
    );
    this._qRawCount = this.db.prepare(
      'SELECT COUNT(*) AS n FROM metrics WHERE target = :t AND metric = :m AND ts >= :lo AND ts < :hi'
    );
    this._qAggCount = this.db.prepare(
      'SELECT COALESCE(SUM(n), 0) AS n FROM metrics_5m WHERE target = :t AND metric = :m AND bucket >= :lo AND bucket < :hi'
    );
    this._qMetaGet = this.db.prepare('SELECT v FROM tsdb_meta WHERE k = ?');
    this._qMetaSet = this.db.prepare('INSERT OR REPLACE INTO tsdb_meta (k, v) VALUES (?, ?)');
    this._lastWrite = new Map(); // "target|metric" -> ts(sec)

    // B22: two cursors, one day apart.
    //   _aggWm   — everything below this has been folded into the 5m tier.
    //   _purgeWm — everything below this has additionally been deleted from raw.
    // _purgeWm <= _aggWm always. The READ path keys off _purgeWm, because that is the
    // point below which raw no longer answers: between the two watermarks both tiers
    // hold the data and raw wins. This is also what keeps a query correct mid-backfill
    // — until a region is actually purged the boundary is still behind it and the read
    // goes to raw, where it still lives. 0 on a fresh database means nothing has moved
    // yet and every read goes to raw.
    this._aggWm = Number(this._qMetaGet.get('agg_watermark')?.v || 0);
    this._purgeWm = Number(this._qMetaGet.get('purge_watermark')?.v || 0);
    this._rollupFails = 0;

    // Verify one series' chunk: every raw sample in [lo,hi) must be accounted for by
    // the bucket counters covering it. Used by BOTH phases — once right after writing
    // the buckets, and again a day later immediately before the rows are deleted.
    this._verify = (target, metric, lo, hi) => {
      const p = { t: target, m: metric, lo, hi };
      const raw = this._qRawCount.get(p).n;
      const agg = this._qAggCount.get(p).n;
      if (raw !== agg) {
        throw new Error(`verify failed ${target}/${metric} [${lo},${hi}): raw=${raw} agg=${agg}`);
      }
    };

    // Phase A — write buckets. Deletes nothing, so a defect here is recoverable for a
    // whole day. better-sqlite3 rolls the transaction back if the function throws.
    this._aggChunk = this.db.transaction((lo, hi) => {
      let buckets = 0;
      for (const { target, metric } of this._qSeries.all()) {
        buckets += this._qRollupIns.run({ t: target, m: metric, lo, hi }).changes;
        this._verify(target, metric, lo, hi);
      }
      // Advancing the cursor inside the same transaction is what makes a crash safe:
      // either the buckets landed and the watermark moved with them, or neither did and
      // the next tick retries this chunk (INSERT OR REPLACE makes that idempotent).
      this._qMetaSet.run('agg_watermark', String(hi));
      return { buckets };
    });

    // Phase 0 — raw older than the aggregate window is past saving: a bucket written
    // for it is already expired and cleanup() sweeps it immediately, after which the
    // purge check would (correctly) refuse to delete the rows it no longer covers.
    // Drop such rows outright instead of routing them through a tier that cannot hold
    // them. No verification, because there is nothing left to verify against — this is
    // data both tiers have agreed to forget.
    this._dropChunk = this.db.transaction((lo, hi) => {
      let removed = 0;
      for (const { target, metric } of this._qSeries.all()) {
        removed += this._qRollupDel.run({ t: target, m: metric, lo, hi }).changes;
      }
      if (hi > this._aggWm) this._qMetaSet.run('agg_watermark', String(hi));
      this._qMetaSet.run('purge_watermark', String(hi));
      return { removed };
    });

    // Phase B — drop the raw rows, a day after their buckets were written. The chunk is
    // re-verified here rather than trusted: this is the last moment the source data
    // still exists, so it is the right place to check. The DELETE's WHERE is identical
    // to the aggregating INSERT's, so it cannot reach a row that was never aggregated.
    this._purgeChunk = this.db.transaction((lo, hi) => {
      let removed = 0;
      for (const { target, metric } of this._qSeries.all()) {
        // Re-aggregate before verifying rather than trusting the buckets Phase A left
        // a day ago. INSERT OR REPLACE is idempotent, the raw rows are still right
        // here, and it makes the tier self-healing: a bucket lost in the meantime (an
        // over-eager retention sweep did exactly this once) is simply rebuilt instead
        // of wedging the purge forever. It also guarantees that what we verify is what
        // exists at the instant of deletion, not what existed yesterday.
        this._qRollupIns.run({ t: target, m: metric, lo, hi });
        this._verify(target, metric, lo, hi);
        removed += this._qRollupDel.run({ t: target, m: metric, lo, hi }).changes;
      }
      this._qMetaSet.run('purge_watermark', String(hi));
      return { removed };
    });
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

  // B22: shared by both tiers so there is exactly one definition of how a bucket
  // becomes points. Rows are {tmin, vmin, tmax, vmax} whichever tier produced them.
  static _expand(rows, out) {
    for (const r of rows) {
      // Flat bucket: one point is enough. Otherwise emit both extremes, earliest first,
      // so the series stays monotonic in ts and the spike keeps its real position.
      if (r.vmin === r.vmax) { out.push({ ts: r.tmin, value: r.vmin }); continue; }
      if (r.tmin <= r.tmax) out.push({ ts: r.tmin, value: r.vmin }, { ts: r.tmax, value: r.vmax });
      else                  out.push({ ts: r.tmax, value: r.vmax }, { ts: r.tmin, value: r.vmin });
    }
    return out;
  }

  // Single series: [{ts, value}] (ts in seconds), downsampled to <=2*MAX_BUCKETS points.
  // B22: the boundary is the PURGE watermark, not the aggregation one — raw answers
  // for everything at or above it, the 5m tier for everything below. Inside the safety
  // band both tiers hold the data and raw is preferred, so the band is invisible here.
  // The two ranges are disjoint and adjacent, so no sample is counted twice and none is
  // skipped, and concatenating keeps ts monotonic. The one read-bucket straddling the
  // boundary draws from both tiers and so can emit up to four points instead of two —
  // a bounded, deliberate imprecision at exactly one bucket, invisible in a polyline.
  history(target, metric, sinceSec) {
    const w = this._bucketWidth(sinceSec);
    if (!w) return this._qOne.all(target, metric, sinceSec);
    const out = [];
    if (sinceSec < this._purgeWm) {
      Tsdb._expand(this._qBucket5m.all({ w, t: target, m: metric, s: sinceSec, e: this._purgeWm }), out);
    }
    const rawFrom = Math.max(sinceSec, this._purgeWm);
    Tsdb._expand(this._qBucket.all({ w, t: target, m: metric, s: rawFrom }), out);
    return out;
  }

  // All sampled metrics for a target: { metric: [{ts,value}] }.
  historyTarget(target, sinceSec) {
    const names = new Set(this._qMetrics.all({ t: target }).map((r) => r.metric));
    for (const r of this._qMetrics5m.all({ t: target })) names.add(r.metric);
    const out = {};
    for (const m of [...names].sort()) out[m] = this.history(target, m, sinceSec);
    return out;
  }

  // B22: fold raw rows older than the raw window into 5m buckets and drop them.
  // Called on a timer. Returns what it moved, so the caller can log a backfill.
  // Async purely to yield between chunks: better-sqlite3 is synchronous, so the only
  // way collection and /api/history stay responsive through a long backfill is to
  // hold the database for one chunk (~35ms) at a time and release the event loop in
  // between, rather than running the whole MAX_CHUNKS_PER_RUN budget back to back.
  async rollup() {
    if (this._rollupBusy) return { chunks: 0, buckets: 0, removed: 0, done: false, busy: true };
    this._rollupBusy = true;
    try {
      return await this._rollup();
    } finally {
      this._rollupBusy = false;
    }
  }

  async _rollup() {
    const now = Math.floor(Date.now() / 1000);
    const align = (t) => Math.floor(t / BUCKET_SEC) * BUCKET_SEC;
    // Only whole buckets entirely older than the window are eligible, so a bucket is
    // never written while samples could still land in it.
    const aggTarget = align(now - AGG_AFTER_DAYS * 86400);
    const purgeTarget = align(now - PURGE_AFTER_DAYS * 86400);

    // A fresh database has no cursors; start both at the oldest raw row so the first
    // run begins the backfill rather than trying to aggregate from the epoch.
    if (!this._aggWm || !this._purgeWm) {
      const first = this._qOldest.get()?.ts;
      if (first == null) return { chunks: 0, buckets: 0, removed: 0, done: true };
      if (!this._aggWm) this._aggWm = align(first);
      if (!this._purgeWm) this._purgeWm = align(first);
    }

    let chunks = 0;
    let buckets = 0;
    let removed = 0;

    // Phase 0 — discard raw below the aggregate retention floor. Only ever has work to
    // do when the rollup has fallen a month behind, or on the very first run over a
    // database whose oldest rows are already at the retention edge (which is exactly
    // where this one started).
    const floorTs = align(now - AGG_RETENTION_DAYS * 86400);
    while (this._purgeWm < floorTs && chunks < MAX_CHUNKS_PER_RUN) {
      const lo = this._purgeWm;
      const hi = Math.min(lo + CHUNK_SEC, floorTs);
      try {
        removed += this._dropChunk(lo, hi).removed;
        this._purgeWm = hi;
        if (hi > this._aggWm) this._aggWm = hi;
        this._rollupFails = 0;
      } catch (e) {
        this._rollupFails += 1;
        console.error(`[tsdb:rollup] drop [${lo},${hi}) failed (${this._rollupFails}x): ${e?.message || e}`);
        break;
      }
      chunks += 1;
      if (this._purgeWm < floorTs && chunks < MAX_CHUNKS_PER_RUN) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Phase A — aggregate. Writes buckets only; raw is untouched for another day.
    while (this._aggWm < aggTarget && chunks < MAX_CHUNKS_PER_RUN) {
      const lo = this._aggWm;
      const hi = Math.min(lo + CHUNK_SEC, aggTarget);
      try {
        buckets += this._aggChunk(lo, hi).buckets;
        this._aggWm = hi;                 // only after the transaction committed
        this._rollupFails = 0;
      } catch (e) {
        // Nothing was written. Leave the cursor and retry the same chunk next tick.
        this._rollupFails += 1;
        console.error(`[tsdb:rollup] agg [${lo},${hi}) failed (${this._rollupFails}x): ${e?.message || e}`);
        break;
      }
      chunks += 1;
      // Hand the loop back before taking the database again, so a push landing mid
      // backfill is served between chunks instead of queueing behind all of them.
      if (this._aggWm < aggTarget && chunks < MAX_CHUNKS_PER_RUN) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Phase B — purge, never past what Phase A has actually aggregated. Clamping to
    // _aggWm is what enforces the band's invariant even if the two targets were
    // misconfigured or the clock jumped.
    const purgeLimit = Math.min(purgeTarget, this._aggWm);
    let pchunks = 0;
    while (this._purgeWm < purgeLimit && pchunks < MAX_CHUNKS_PER_RUN) {
      const lo = this._purgeWm;
      const hi = Math.min(lo + CHUNK_SEC, purgeLimit);
      try {
        removed += this._purgeChunk(lo, hi).removed;
        this._purgeWm = hi;
        this._rollupFails = 0;
      } catch (e) {
        // Nothing was deleted. Raw simply keeps growing until this clears, which is
        // the safe direction to fail in.
        this._rollupFails += 1;
        console.error(`[tsdb:rollup] purge [${lo},${hi}) failed (${this._rollupFails}x): ${e?.message || e}`);
        break;
      }
      pchunks += 1;
      if (this._purgeWm < purgeLimit && pchunks < MAX_CHUNKS_PER_RUN) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return {
      chunks: chunks + pchunks,
      buckets,
      removed,
      done: this._purgeWm >= floorTs && this._aggWm >= aggTarget && this._purgeWm >= purgeLimit,
    };
  }

  // B22: raw rows are deleted only by rollup(), after their bucket is durably written,
  // so this now handles the aggregate tier alone. A plain range delete here is fine:
  // the 5m table tops out around 390k rows (45 series x 288 buckets x 30 days) and the
  // sweep runs hourly, unlike the raw table where the same shape of query was scanning
  // 14.6M rows every hour to remove a few thousand.
  //
  // The cutoff is clamped to the purge watermark, not just the retention age. Ageing
  // alone raced the rollup: an unaligned `now - 30d` sits partway into a bucket, so it
  // swept the bucket straddling it while that bucket was still inside the range the
  // purge phase was about to verify — which then found 413 samples where raw had 450
  // and (correctly) refused to delete. Below _purgeWm nothing looks back: the raw rows
  // are already gone and the read path only reads buckets under that line, so this is
  // race-free by construction rather than by timing.
  cleanup() {
    const now = Math.floor(Date.now() / 1000);
    const aged = Math.floor((now - AGG_RETENTION_DAYS * 24 * 3600) / BUCKET_SEC) * BUCKET_SEC;
    const cutoff = Math.min(aged, this._purgeWm);
    if (cutoff <= 0) return 0;
    const info = this.db.prepare('DELETE FROM metrics_5m WHERE bucket < ?').run(cutoff);
    if (info.changes) console.log(`[tsdb:cleanup] removed ${info.changes} buckets older than ${AGG_RETENTION_DAYS}d`);
    return info.changes;
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

export const RANGE_SEC = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
