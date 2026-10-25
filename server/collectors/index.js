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
import { collectNodes } from './nodes.js';
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
    // v2.24 usage: one engine, configured from the usage target + the inference_nodes
    // target it names (nodes, endpoints, counters, Prometheus).
    const usageT = enabled.find((t) => t.source?.type === 'usage');
    if (usageT && this.ctx.usage) this.ctx.usage.configure(usageT, enabled.find((t) => t.id === usageT.source.nodes_target) || null);
    this.usageProjects = enabled.filter((t) => t.source?.type === 'usage_projects');
    this.usageTarget = usageT || null;
    // v2.25 live inference state (2 s, straight from the servers)
    const liveT = enabled.find((t) => t.source?.type === 'inference_live');
    if (liveT && this.ctx.live) {
      this.ctx.live.configure(liveT, enabled.find((t) => t.id === liveT.source.nodes_target) || null, {
        timeoutMs: parseDuration(liveT.source.timeout, 1000), maxAgeMs: parseDuration(liveT.source.last_max_age, 600000),
      });
    }
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
        type === 'inference_live' ? 2000
          : type === 'usage' || type === 'usage_projects' ? 30000
          : type === 'http' ? 1500 : type === 'demo' ? 2000
          : type === 'tls' ? 3600000 : type === 'tcp' ? 10000
            : type === 'prometheus' ? 10000 : type === 'ssh' ? 10000
              : type === 'inference_nodes' ? 60000 : 8000);
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

  /**
   * 'litellm_keys': map each row's `raw_key` (a sha256 key digest, which is what
   * LiteLLM's spend table stores) to the alias the key was minted under, and write it
   * over the row's `project` label. Rows whose digest has no alias — a key that was
   * deleted since, or one minted without a name — keep whatever label the query already
   * produced, which is a short hash. That fallback is the point: usage from a revoked
   * key must stay visible rather than vanish because its name is gone.
   *
   * `raw_key` is ALWAYS deleted afterwards, resolved or not. The board is public by
   * default; a full key digest has no business on it, and it is only in the row so this
   * function can read it.
   */
  async _resolveNames(target, rows) {
    if (target.source?.resolve_names !== 'litellm_keys' || !Array.isArray(rows)) return;
    const names = this.ctx.litellmKeys ? await this.ctx.litellmKeys.aliasMap() : new Map();
    for (const row of rows) {
      const digest = row?.raw_key;
      if (typeof digest === 'string' && names.has(digest)) row.project = names.get(digest);
      if (row && 'raw_key' in row) delete row.raw_key;
    }
  }

  async _poll(target, metrics) {
    const { snapshot, tsdb, env } = this.ctx;
    try {
      const type = target.source.type;
      // A `shape: table` sql target is the generic one: run its queries/ file and
      // hand the rows to the frontend as-is. No pivot, no per-purpose logic here —
      // which columns are shown, and under what labels, is a layout decision.
      // (pg returns bigint as a string; the renderer coerces.)
      // v2.20 推理节点: today's usage split by node + which litellm instance routes to it.
      if (type === 'inference_nodes') {
        const { metrics: m, extra } = await collectNodes(target, env);
        snapshot.update(target.id, { online: true, metrics: m, extra });
        const rows = samplableRows(target.id, { metrics: m }, metrics);
        if (rows.length) tsdb.record(rows);
        // v2.24: the Token Usage card takes today's counters from this snapshot -- refresh it
        // now, so the two cards never show different "today" figures for a whole poll
        const ut = this.usageTarget;
        if (ut && ut.source.nodes_target === target.id && !this._inflight.has(ut.id)) {
          this._inflight.add(ut.id);
          Promise.resolve(this._poll(ut, metrics)).catch(() => {}).finally(() => this._inflight.delete(ut.id));
        }
        return;
      }
      // v2.25: live state, pushed to the browsers (SSE) the moment it is read. Speeds and
      // tokens history keeps coming from Prometheus.
      if (type === 'inference_live') {
        const view = await this.ctx.live.poll();
        snapshot.update(target.id, { online: true, metrics: {}, extra: { live: view } });
        this.ctx.liveBus?.emit(view);
        // v2.26: per node the running streams, the total and each stream's decode go into
        // the timeseries (the node modal's concurrency chart); the store keeps one sample
        // per 5 s per series, so a 2 s poll does not triple the writes.
        const rows = this.ctx.live.historyRows(target.id, view);
        if (rows.length) tsdb.record(rows);
        return;
      }
      // v2.24: all usage (counters + LiteLLM) by Beijing day -- see server/usage.js
      if (type === 'usage') {
        const u = this.ctx.usage;
        if (!u) throw new Error('usage engine not available');
        await u.refresh();
        // Right after a start the inference_nodes target has not been polled yet: today
        // would read as LiteLLM only. Publish nothing for up to 3 minutes rather than a
        // figure that is about to jump; after that, publish with the "partial" note.
        if (u.nodesPending && process.uptime() < 180) return;
        const card = u.card(this.tokenLabels?.total);
        const norm = normalize({ token_speed: card.speed }, target, metrics);
        snapshot.update(target.id, { online: true, metrics: norm.metrics, extra: { token: card } });
        // the Per-Project table(s) from the SAME refresh, so its rows always add up to the
        // Chat figure on screen (on its own timer it could be one refresh behind)
        for (const pt of this.usageProjects || []) {
          if (pt.source.usage_target !== target.id) continue;
          const rows = u.projects().map((r) => ({ ...r }));
          await this._resolveNames(pt, rows);
          snapshot.update(pt.id, { online: true, metrics: {}, extra: { rows } });
        }
        return;
      }
      // Normally published by the usage poll above; this poll only covers the first moments
      // after a (re)start and a usage target that is not the one it names.
      if (type === 'usage_projects') {
        const u = this.ctx.usage;
        if (!u || !u.ready || snapshot.get(target.id)?.online) return;
        const rows = u.projects().map((r) => ({ ...r }));
        await this._resolveNames(target, rows);
        snapshot.update(target.id, { online: true, metrics: {}, extra: { rows } });
        return;
      }
      if (type === 'sql' && target.source.shape === 'table') {
        const rows = await collectSqlRows(target.source, env, target.source.query_file);
        // `resolve_names` is the one decoration this generic path performs, and it is
        // config-gated by an enum so it stays a named capability rather than
        // per-target logic. Everything else about the row still reaches the frontend
        // exactly as the query wrote it.
        await this._resolveNames(target, rows);
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
        //
        // total_excludes_window: the cached query covers only the days BEFORE the live
        // window, and the window (fetched every poll) is added on top. Past days do not
        // change, so "all" is exact on every poll instead of trailing "today" by up to
        // TTL + interval. The cache is re-keyed when the UTC day rolls (LiteLLM buckets
        // by UTC date), because that is when a day leaves the window.
        let totals = null;
        const split = target.source.total_excludes_window === true;
        if (target.source.total_query_file) {
          const epoch = split ? new Date().toISOString().slice(0, 10) : null;
          const cached = this._totals.get(target.id);
          if (cached && cached.epoch === epoch && (Date.now() - cached.at) < TOTALS_TTL_MS) {
            totals = cached.rows;
          } else {
            try {
              totals = await collectSqlRows(target.source, env, target.source.total_query_file,
                split ? SNAPSHOT_TOKEN_DAYS : undefined);
              this._totals.set(target.id, { at: Date.now(), rows: totals, epoch });
            } catch { totals = cached && cached.epoch === epoch ? cached.rows : null; } // keep last good on error
          }
        }
        const pivot = pivotTokens(rows, { classify: target.classify, totalLabel: this.tokenLabels?.total, speed, totals,
          totalsExcludeWindow: split });
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
      const raw = type === 'http' ? await collectHttp(target.source, parseDuration(target.source.timeout, 3000), env)
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
      this._rememberModel(target, norm.metrics.model);
      const rows = samplableRows(target.id, norm, metrics);
      if (rows.length) tsdb.record(rows);
    } catch (e) {
      snapshot.update(target.id, { online: false, error: String(e?.message || e) });
      this._recallModel(target);
    }
  }

  // v2.20: a node that is often switched off (always_on: false — m110) shows the last model
  // it was seen serving, greyed, instead of a blank. The snapshot already keeps the last
  // good metrics while the hub runs; this carries the name across a hub restart too, via
  // the timeseries' small key/value table. Written only when the name changes.
  _rememberModel(target, m) {
    if (target.always_on !== false || typeof m?.value !== 'string' || !m.value) return;
    const k = `last_model:${target.id}`;
    if (this.ctx.tsdb.metaGet?.(k) !== m.value) this.ctx.tsdb.metaSet?.(k, m.value);
  }

  _recallModel(target) {
    if (target.always_on !== false) return;
    const e = this.ctx.snapshot.get(target.id);
    if (!e || e.metrics?.model) return;
    const v = this.ctx.tsdb.metaGet?.(`last_model:${target.id}`);
    if (v) e.metrics = { ...(e.metrics || {}), model: { value: v, level: null, display: v, last_seen: true } };
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
