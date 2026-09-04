// Collector registry + scheduler (§5.2).
// Each enabled target runs on its own interval. http/exec/sql are polled;
// http_push is fed by the POST route and swept for staleness. On config
// hot-reload we tear down all timers and rebuild from the new config.
import { collectHttp } from './http.js';
import { collectTcp, collectTls } from './net_probe.js';
import { collectPrometheus } from './prometheus.js';
import { collectSsh } from './ssh.js';
import { collectExec } from './exec.js';
import { collectSql, collectSqlScalar, collectSqlRows } from './sql.js';
import { collectDemo, demoTokenRows, demoTokenSpeed } from './demo.js';
import { markPush, isPushStale, checkPushToken } from './push.js';
import { normalize, samplableRows } from '../normalize.js';
import { pivotTokens } from '../token_detail.js';

const SNAPSHOT_TOKEN_DAYS = 30; // window for the token card day-trend + 5-day spark
const PUSH_SWEEP_MS = 5000;
const TOTALS_TTL_MS = 600000; // B4: cumulative all-time totals cache TTL (10 min)

export function parseDuration(s, fallbackMs = 5000) {
  if (typeof s === 'number') return s;
  if (typeof s !== 'string') return fallbackMs;
  const m = s.trim().match(/^([\d.]+)\s*(ms|s|m|h|d)?$/);
  if (!m) return fallbackMs;
  const v = Number(m[1]);
  const unit = m[2] || 's';
  // h/d added in slice 2c alongside tls_cert's hour-scale interval. ms/s/m unchanged,
  // and an unknown unit cannot reach here (the regex gates it).
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return v * (mult[unit] ?? 1000);
}

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;                 // { snapshot, tsdb, env, getMetrics }
    this.timers = [];
    this.pushTargets = new Map();   // id -> target (for token validation + sweep)
    this._totals = new Map();       // B4: id -> { at, rows } cumulative all-time cache
    this._inflight = new Set();     // target ids currently being polled
    this._sweep = null;
  }

  apply(config) {
    this._clear();
    const metrics = config.metrics.metrics || {};
    this.ctx.getMetrics = () => metrics;
    // §12-step2 patch: token card front labels (e.g. total) for the pivot
    this.tokenLabels = (config.layout?.grid || []).find((c) => c.type === 'token')?.labels || {};
    const enabled = (config.targets.targets || []).filter((t) => t.enabled !== false);
    this.ctx.snapshot.prune(enabled.map((t) => t.id));

    for (const target of enabled) {
      const type = target.source?.type;
      if (type === 'http_push') {
        this.pushTargets.set(target.id, target);
        continue;
      }
      // tls gets its own default: a certificate moves once a day at most, and the
      // generic 8s fallback would mean a handshake every 8 seconds forever if a
      // hand-written target omitted `interval`.
      const interval = parseDuration(target.source?.interval,
        type === 'http' ? 1500 : type === 'demo' ? 2000
          : type === 'tls' ? 3600000 : type === 'tcp' ? 10000
            : type === 'prometheus' ? 10000 : type === 'ssh' ? 10000 : 8000);
      const tick = () => {
        if (this._inflight.has(target.id)) return;
        this._inflight.add(target.id);
        Promise.resolve(this._poll(target, metrics))
          .catch(() => {})
          .finally(() => this._inflight.delete(target.id));
      };
      tick(); // immediate first sample
      this.timers.push(setInterval(tick, interval));
    }

    // single staleness sweep for push targets
    this._sweep = setInterval(() => {
      for (const [id, target] of this.pushTargets) {
        if (isPushStale(id, target.source?.stale_after_s)) this.ctx.snapshot.update(id, { online: false, error: 'no push (stale)' });
      }
    }, PUSH_SWEEP_MS);

    console.log(`[scheduler] scheduled ${this.timers.length} polled + ${this.pushTargets.size} push target(s)`);
  }

  async _poll(target, metrics) {
    const { snapshot, tsdb, env } = this.ctx;
    try {
      const type = target.source.type;
      // A `shape: table` sql target is the generic one: run its queries/ file and
      // hand the rows to the frontend as-is. No pivot, no per-purpose logic here —
      // which columns are shown, and under what labels, is a layout decision.
      // (pg returns bigint as a string; the renderer coerces.)
      if (type === 'sql' && target.source.shape === 'table') {
        const rows = await collectSqlRows(target.source, env, target.source.query_file);
        snapshot.update(target.id, { online: true, metrics: {}, extra: { rows } });
        return;
      }
      if (type === 'sql') {
        const rows = await collectSql(target.source, env, SNAPSHOT_TOKEN_DAYS);
        // B3: optional 2nd query → token_speed scalar (same security envelope).
        let speed = null;
        if (target.source.speed_query_file) {
          try {
            speed = await collectSqlScalar(target.source, env, target.source.speed_query_file, target.source.speed_samples ?? 10, 'speed');
          } catch { /* speed optional; leave null → "—" */ }
        }
        // B4: cumulative all-time totals for the "all"/requests columns, cached
        // ~10min (full-table scan kept off the poll cadence). Trend/today/spark
        // still come from the windowed `rows` above.
        let totals = null;
        if (target.source.total_query_file) {
          const cached = this._totals.get(target.id);
          if (cached && (Date.now() - cached.at) < TOTALS_TTL_MS) {
            totals = cached.rows;
          } else {
            try {
              totals = await collectSqlRows(target.source, env, target.source.total_query_file);
              this._totals.set(target.id, { at: Date.now(), rows: totals });
            } catch { totals = cached ? cached.rows : null; } // keep last good on error
          }
        }
        const pivot = pivotTokens(rows, { classify: target.classify, totalLabel: this.tokenLabels?.total, speed, totals });
        const raw = { token_speed: pivot.speed };
        const norm = normalize(raw, target, metrics);
        snapshot.update(target.id, { online: true, metrics: norm.metrics, extra: { token: pivot } });
        return;
      }
      // demo token target (synthetic rows → classify → pivot)
      if (type === 'demo' && target.classify) {
        const rows = demoTokenRows(target.classify, SNAPSHOT_TOKEN_DAYS);
        const pivot = pivotTokens(rows, { classify: target.classify, totalLabel: this.tokenLabels?.total });
        const raw = { token_speed: demoTokenSpeed(target.id) };
        const norm = normalize(raw, target, metrics);
        snapshot.update(target.id, { online: true, metrics: norm.metrics, extra: { token: pivot } });
        return;
      }
      const raw = type === 'http' ? await collectHttp(target.source, parseDuration(target.source.timeout, 3000))
        : type === 'exec' ? await collectExec(target.source)
        : type === 'tcp' ? await collectTcp(target.source, parseDuration(target.source.timeout, 3000))
        : type === 'tls' ? await collectTls(target.source, parseDuration(target.source.timeout, 4000))
        : type === 'prometheus' ? await collectPrometheus(target.source, parseDuration(target.source.timeout, 4000))
        : type === 'ssh' ? await collectSsh(target.source, {
          // The vault and the credential store reach the collector through ctx, not
          // through the target: a source row can name a credential, never carry one.
          vault: this.ctx.vault, credStore: this.ctx.credStore,
          timeoutMs: parseDuration(target.source.timeout, 6000),
        })
        : type === 'demo' ? collectDemo(target, metrics)
        : null;
      if (raw == null) throw new Error(`unsupported source type: ${type}`);
      const norm = normalize(raw, target, metrics);
      snapshot.update(target.id, { online: true, metrics: norm.metrics });
      const rows = samplableRows(target.id, norm, metrics);
      if (rows.length) tsdb.record(rows);
    } catch (e) {
      snapshot.update(target.id, { online: false, error: String(e?.message || e) });
    }
  }

  // Called by POST /api/push/:id after token check.
  handlePush(target, body) {
    const metrics = this.ctx.getMetrics();
    markPush(target.id);
    const norm = normalize(body || {}, target, metrics);
    // §7.5 原样保留原始 body.extra 到快照(缺省则 update 内部沿用上次)
    this.ctx.snapshot.update(target.id, { online: true, metrics: norm.metrics, extra: body.extra });
    const rows = samplableRows(target.id, norm, metrics);
    if (rows.length) this.ctx.tsdb.record(rows);
  }

  getPushTarget(id) { return this.pushTargets.get(id) || null; }
  validatePush(target, headerToken) { return checkPushToken(target, headerToken, this.ctx.env); }

  _clear() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearInterval(this._sweep);
    this._sweep = null;
    this.pushTargets.clear();
    this._totals.clear();
  }

  stop() { this._clear(); }
}
