// In-memory latest snapshot (§2, §5.2).
// One entry per target: the most recent normalized metrics + online/stale flags.
// On collector failure we mark online:false and KEEP the last value (stale),
// never zeroing — the frontend can dim, not crash.

export class Snapshot {
  constructor() {
    this._state = new Map(); // targetId -> entry
  }

  // entry shape:
  // { online, stale, at, since, tried?, metrics: {k:{value,level,display}}, extra: {...}, error? }
  // v2.35: `since` = when the current online / offline spell began; `tried` (offline only) =
  // when the latest failed attempt started. A status pill for a service on a laptop needs both
  // to tell "the machine is off" from "the machine is up and the service is not" (web/app.js).
  update(targetId, { online, metrics, extra, error, tried }) {
    const prev = this._state.get(targetId);
    const now = Date.now();
    if (online) {
      this._state.set(targetId, {
        online: true,
        stale: false,
        at: now,
        since: prev?.online ? (prev.since ?? now) : now,
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
        since: prev && !prev.online ? (prev.since ?? now) : now,
        tried: tried ?? now,
        metrics: prev?.metrics || {},
        // (v2.41: a failed poll may say what it tried -- the followed ComfyUI port; nobody else passes extra here)
        extra: extra ?? prev?.extra ?? null,
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
        since: e.since,
        ...(e.tried ? { tried: e.tried } : {}),
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
