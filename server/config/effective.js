// Effective configuration (slice 2) — file config ++ runtime user data.
//
// The panel has exactly one notion of "the config" downstream of here: the scheduler,
// publicConfig and the frontend all read the effective document and none of them know
// it has two sources. What this layer adds is the merge and the gate:
//
//   effective.targets.targets = fileTargets ++ userTargets
//   effective.layout.grid     = fileGrid    ++ userCards   (ordered by position)
//   everything else           = the file document, untouched
//
// THE HARD GUARANTEE: with an empty user store this returns the file config OBJECT
// ITSELF — same reference, same etag, no clone, no rehash. "Behaves exactly as before
// when nothing was added" is then true by construction rather than by testing, and the
// empty-store path cannot drift as this file grows.
//
// The gate is the same one watch.js applies to a bad YAML edit: a merge that fails
// validate/crossValidate is refused and the previous good effective config stays live.
// Callers preflight a proposed change BEFORE writing it, so invalid user data never
// reaches the database in the first place and there is nothing to roll back.
import { validate, crossValidate } from './schema.js';
import { applyDefaults, computeEtag } from './loader.js';
import { cardTargets } from '../store/user_store.js';

/**
 * Merge + validate. Pure: no I/O, no mutation of `fileCfg` or of the user docs.
 * @param {object} fileCfg  last good file config (from ConfigStore)
 * @param {{targets:object[], cards:object[]}} userCfg
 * @returns {{ok:true, config:object, empty?:boolean} | {ok:false, errors:string[]}}
 */
export function buildEffective(fileCfg, userCfg) {
  const userTargets = userCfg?.targets || [];
  const userCards = userCfg?.cards || [];
  if (!userTargets.length && !userCards.length) {
    return { ok: true, config: fileCfg, empty: true };
  }

  const fileTargets = fileCfg.targets?.targets || [];
  const fileGrid = fileCfg.layout?.grid || [];
  const errors = [];

  // ── id rules, checked before the schema so the message names the real problem ──
  const seen = new Set(fileTargets.map((t) => t.id));
  const cloned = [];
  for (const t of userTargets) {
    if (typeof t?.id !== 'string' || !/^[a-zA-Z0-9_]+$/.test(t.id)) {
      errors.push(`user target id "${t?.id}" must match ^[a-zA-Z0-9_]+$`);
      continue;
    }
    if (seen.has(t.id)) {
      // Shadowing a file target would let the database silently override the YAML —
      // the operator would edit targets.yaml and watch nothing happen.
      errors.push(`user target "${t.id}" collides with an existing target id`);
      continue;
    }
    seen.add(t.id);
    cloned.push(JSON.parse(JSON.stringify(t)));
  }

  // Runtime cards may only point at targets that exist somewhere in the merged set.
  // crossValidate catches this too, but its message is about layout.grid indices; this
  // one names the card, which is what the caller can act on.
  for (const c of userCards) {
    for (const ref of cardTargets(c)) {
      if (!seen.has(ref)) errors.push(`user card (type=${c?.type}) references unknown target "${ref}"`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // ── merge ──────────────────────────────────────────────────────────
  // applyDefaults mutates, so it only ever sees the clones.
  const withDefaults = applyDefaults({ defaults: fileCfg.targets?.defaults || {}, targets: cloned }).targets;
  const targetsDoc = { ...fileCfg.targets, targets: [...fileTargets, ...withDefaults] };
  const layoutDoc = { ...fileCfg.layout, grid: [...fileGrid, ...userCards.map((c) => ({ ...c }))] };

  // ── the same gate the YAML goes through ────────────────────────────
  for (const [kind, doc] of [['targets', targetsDoc], ['layout', layoutDoc]]) {
    const r = validate(kind, doc);
    if (!r.ok) errors.push(...r.errors);
  }
  if (errors.length) return { ok: false, errors };

  const cross = crossValidate({ metrics: fileCfg.metrics, targets: targetsDoc, layout: layoutDoc });
  if (!cross.ok) return { ok: false, errors: cross.errors };

  const merged = {
    metrics: fileCfg.metrics, targets: targetsDoc, layout: layoutDoc, theme: fileCfg.theme,
  };
  return {
    ok: true,
    config: {
      ...fileCfg,
      targets: targetsDoc,
      layout: layoutDoc,
      etag: computeEtag(merged),
      user: { targets: withDefaults.length, cards: userCards.length },
    },
  };
}

/**
 * Holds the current good effective config and rebuilds it from either source.
 * Mirrors ConfigStore's contract deliberately (get / getPublic / health / lastError)
 * so index.js reads one kind of thing.
 */
export class EffectiveStore {
  constructor({ userStore }) {
    this.userStore = userStore;
    this.current = null;
    this.lastError = null;      // { at, errors[] } of the most recent refused rebuild
  }

  get() { return this.current; }

  /**
   * Reassemble from the given file config plus whatever is in the store.
   * On failure the previous effective config stays current — including at boot, where
   * the file config alone is used rather than refusing to start. A row that was valid
   * when written can be invalidated later by a YAML edit (deleting the metric a user
   * card renders); a dark panel is the one outcome worse than ignoring that row.
   * @returns {{ok:true, changed:boolean} | {ok:false, errors:string[]}}
   */
  rebuild(fileCfg) {
    let userCfg;
    try {
      userCfg = this.userStore.getUserConfig();
    } catch (e) {
      userCfg = { targets: [], cards: [] };
      console.error(`[effective] user store unreadable, continuing file-only: ${e.message}`);
    }
    const r = buildEffective(fileCfg, userCfg);
    if (!r.ok) {
      this.lastError = { at: new Date().toISOString(), errors: r.errors };
      console.warn(`[effective:reject] keeping previous; ${r.errors.length} error(s):`);
      for (const e of r.errors) console.warn(`[effective:reject]   - ${e}`);
      if (!this.current) {
        this.current = fileCfg;   // boot with bad user data: file config alone
        console.warn('[effective:reject] booting file-only (user rows ignored)');
        return { ok: false, errors: r.errors, fellBackToFile: true };
      }
      return { ok: false, errors: r.errors };
    }
    const changed = this.current?.etag !== r.config.etag;
    this.current = r.config;
    this.lastError = null;
    return { ok: true, changed };
  }

  /** Validate a proposed user-data state without touching the store. */
  preflight(fileCfg, proposedUserCfg) {
    return buildEffective(fileCfg, proposedUserCfg);
  }

  health() {
    const counts = (() => {
      try { return this.userStore.countAll(); } catch { return null; }
    })();
    return { etag: this.current?.etag || null, user: counts, lastError: this.lastError };
  }
}
