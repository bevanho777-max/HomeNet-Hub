// Collector registry + scheduler (§5.2).
// Each enabled target runs on its own interval. http/exec/sql are polled;
// http_push is fed by the POST route and swept for staleness. On config
// hot-reload we tear down all timers and rebuild from the new config.
import { collectHttp } from './http.js';
import { collectExec } from './exec.js';
import { collectSql } from './sql.js';
import { collectDemo, demoTokenRows, demoTokenSpeed } from './demo.js';
import { markPush, isPushStale, checkPushToken } from './push.js';
import { normalize, samplableRows } from '../normalize.js';
import { pivotTokens } from '../token_detail.js';

const SNAPSHOT_TOKEN_DAYS = 30; // window for the token card "all" + 5-day spark
const PUSH_SWEEP_MS = 5000;

export function parseDuration(s, fallbackMs = 5000) {
  if (typeof s === 'number') return s;
  if (typeof s !== 'string') return fallbackMs;
  const m = s.trim().match(/^([\d.]+)\s*(ms|s|m)?$/);
  if (!m) return fallbackMs;
  const v = Number(m[1]);
  const unit = m[2] || 's';
  return unit === 'ms' ? v : unit === 'm' ? v * 60000 : v * 1000;
}

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;                 // { snapshot, tsdb, env, getMetrics }
    this.timers = [];
    this.pushTargets = new Map();   // id -> target (for token validation + sweep)
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
      const interval = parseDuration(target.source?.interval, type === 'http' ? 1500 : type === 'demo' ? 2000 : 8000);
      const tick = () => this._poll(target, metrics);
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
      if (type === 'sql') {
        const rows = await collectSql(target.source, env, SNAPSHOT_TOKEN_DAYS);
        const pivot = pivotTokens(rows, { classify: target.classify, totalLabel: this.tokenLabels?.total });
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
        : type === 'demo' ? collectDemo(target, metrics)
        : null;
      if (raw == null) throw new Error(`unsupported source type: ${type}`);
      const norm = normalize(raw, target, metrics);
      snapshot.update(target.id, { online: true, metrics: norm.metrics });
      const rows = samplableRows(target.id, norm);
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
    const rows = samplableRows(target.id, norm);
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
  }

  stop() { this._clear(); }
}
