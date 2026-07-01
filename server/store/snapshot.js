// In-memory latest snapshot (§2, §5.2).
// One entry per target: the most recent normalized metrics + online/stale flags.
// On collector failure we mark online:false and KEEP the last value (stale),
// never zeroing — the frontend can dim, not crash.

export class Snapshot {
  constructor() {
    this._state = new Map(); // targetId -> entry
  }

  // entry shape:
  // { online, stale, at, metrics: {k:{value,level,display}}, extra: {...}, error? }
  update(targetId, { online, metrics, extra, error }) {
    const prev = this._state.get(targetId);
    if (online) {
      this._state.set(targetId, {
        online: true,
        stale: false,
        at: Date.now(),
        metrics: metrics || {},
        extra: extra || (prev?.extra ?? null),
        error: null,
      });
    } else {
      // keep last good metrics, mark offline+stale
      this._state.set(targetId, {
        online: false,
        stale: true,
        at: prev?.at ?? null,
        metrics: prev?.metrics || {},
        extra: prev?.extra ?? null,
        error: error || prev?.error || 'unreachable',
      });
    }
  }

  get(targetId) { return this._state.get(targetId) || null; }

  // Full snapshot for GET /api/snapshot, filtered to the given enabled ids.
  toJSON(enabledIds) {
    const out = {};
    const ids = enabledIds || [...this._state.keys()];
    for (const id of ids) {
      const e = this._state.get(id);
      if (!e) { out[id] = { online: false, stale: true, metrics: {} }; continue; }
      out[id] = {
        online: e.online,
        stale: e.stale,
        at: e.at,
        metrics: e.metrics,
        ...(e.extra ? { extra: e.extra } : {}),
        ...(e.error ? { error: e.error } : {}),
      };
    }
    return out;
  }

  // Drop targets no longer present in config (after a hot-reload).
  prune(validIds) {
    const valid = new Set(validIds);
    for (const id of this._state.keys()) if (!valid.has(id)) this._state.delete(id);
  }
}
