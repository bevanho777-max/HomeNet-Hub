// v2.48.1 config tolerance: a config written for a NEWER hub must not stop this one.
//
// Before the strict checks (schema.js), three kinds of things this version does not know are set aside,
// each with a warning (logged, and in /healthz config.warnings):
//   - a target whose source type it has no collector for      -> the target is skipped
//   - a card of a type it cannot draw                          -> a small grey placeholder in its place
//                                                                 (type 'unsupported', web/renderers/unsupported.js)
//   - a field its schema does not know, where the schema forbids
//     unknown fields (additionalProperties: false)             -> the field is ignored
// and whatever pointed at a skipped target follows it: a card of a known type drawing that target becomes a
// placeholder too, a stack / nodes card loses that child / column, the status bar and the history pickers
// drop the id. Everything else that fails validation -- broken YAML, a required field missing, a wrong type,
// a target id that never existed -- is still an error: refused at start, the old config kept on a reload.
//
// Why: a rollback to an older release used to need the config edited by hand first (2026-11-13, v2.48.0 ->
// v2.47.1: the old hub exited at start on `type: kiwivm` / `type: vps`). From this version on, the hub starts
// and shows what it skipped. (Releases before this one still exit; homenet-deploy.sh --rollback handles those.)
import { validateDetailed } from './schema.js';

const MAX_ROUNDS = 6;

// the object at a JSON pointer ('/targets/3/source'), or undefined
function at(doc, pointer) {
  let x = doc;
  for (const raw of String(pointer || '').split('/').slice(1)) {
    if (x == null || typeof x !== 'object') return undefined;
    x = x[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return x;
}

const str = (v) => (typeof v === 'string' ? v : null);

// the placeholder a card becomes; keeps what the panel needs to say what it was
function placeholder(card, type) {
  const p = { type: 'unsupported', unsupported_type: String(type) };
  if (str(card?.target)) p.target = card.target;
  if (str(card?.title)) p.title = card.title;
  if (str(card?.title_en)) p.title_en = card.title_en;
  return p;
}

/** Targets whose source.type this version does not know: removed. Returns [{ id, type }]. */
function skipUnknownTargets(doc, warnings) {
  if (!Array.isArray(doc?.targets)) return [];
  const bad = new Set();
  for (const e of validateDetailed('targets', doc).errors) {
    const m = /^\/targets\/(\d+)\/source\/type$/.exec(e.instancePath || '');
    // (a string this version does not know; a non-string type is a malformed target, left to the strict check)
    if (m && e.keyword === 'enum' && str(doc.targets[Number(m[1])]?.source?.type)) bad.add(Number(m[1]));
  }
  const skipped = [];
  if (!bad.size) return skipped;
  doc.targets = doc.targets.filter((t, i) => {
    if (!bad.has(i)) return true;
    skipped.push({ id: str(t?.id), type: t.source.type });
    warnings.push(`targets/targets/${i}: target "${t?.id}" skipped -- source type "${t.source.type}" is not supported by this version`);
    return false;
  });
  return skipped;
}

/** Cards whose type this version does not know: replaced by a placeholder. Returns [{ index, type, target }]. */
function placeholderUnknownCards(doc, warnings) {
  const out = [];
  if (!Array.isArray(doc?.grid)) return out;
  for (const e of validateDetailed('layout', doc).errors) {
    const m = /^\/grid\/(\d+)\/type$/.exec(e.instancePath || '');
    if (!m || e.keyword !== 'enum') continue;
    const i = Number(m[1]);
    const c = doc.grid[i];
    if (!str(c?.type) || c.type === 'unsupported') continue;
    doc.grid[i] = placeholder(c, c.type);
    out.push({ index: i, type: c.type, target: str(c.target) });
    warnings.push(`layout/grid/${i}: card type "${c.type}" is not supported by this version -- shown as a placeholder`);
  }
  return out;
}

/** Fields the schema does not allow (additionalProperties: false): removed, until none is left. */
function stripUnknownFields(kind, doc, warnings) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const e of validateDetailed(kind, doc).errors) {
      if (e.keyword !== 'additionalProperties') continue;
      const parent = at(doc, e.instancePath);
      const key = e.params?.additionalProperty;
      if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !(key in parent)) continue;
      delete parent[key];
      changed = true;
      warnings.push(`${kind}${e.instancePath}: unknown field "${key}" ignored (not supported by this version)`);
    }
    if (!changed) return;
  }
}

/** Whatever pointed at a skipped target follows it (see the header). */
function followSkipped(layout, skipped, unsupported, warnings) {
  const gone = new Map(skipped.filter((s) => s.id).map((s) => [s.id, s.type]));
  if (!gone.size || !layout || typeof layout !== 'object') return;
  (Array.isArray(layout.grid) ? layout.grid : []).forEach((c, i) => {
    if (!c || typeof c !== 'object' || c.type === 'unsupported') return;
    if (str(c.target) && gone.has(c.target)) {
      layout.grid[i] = placeholder(c, gone.get(c.target));
      unsupported.push({ index: i, type: gone.get(c.target), target: c.target });
      warnings.push(`layout/grid/${i}: card (type ${c.type}) draws skipped target "${c.target}" -- shown as a placeholder`);
      return;
    }
    if (Array.isArray(c.children)) {
      const keep = c.children.filter((id) => !gone.has(id));
      if (keep.length !== c.children.length) {
        warnings.push(`layout/grid/${i}: stack child(ren) ${c.children.filter((id) => gone.has(id)).join(', ')} dropped (skipped target)`);
        if (keep.length) c.children = keep;
        else {
          const type = gone.get(c.children[0]);
          layout.grid[i] = placeholder(c, type);
          unsupported.push({ index: i, type, target: null });
        }
      }
    }
    if (Array.isArray(c.nodes)) {
      const keep = c.nodes.filter((n) => !(gone.has(n?.probe) || gone.has(n?.speed)));
      if (keep.length !== c.nodes.length) {
        warnings.push(`layout/grid/${i}: ${c.nodes.length - keep.length} column(s) dropped (probe / speed target skipped)`);
        c.nodes = keep;
      }
    }
  });
  const prune = (obj, key, where) => {
    if (!obj || !Array.isArray(obj[key])) return;
    const keep = obj[key].filter((id) => !gone.has(id));
    if (keep.length === obj[key].length) return;
    warnings.push(`${where}: ${obj[key].filter((id) => gone.has(id)).join(', ')} dropped (skipped target)`);
    obj[key] = keep;
  };
  prune(layout.status_bar, 'targets', 'layout.status_bar');
  for (const k of ['selectable_targets', 'default', 'panes']) prune(layout.history, k, `layout.history.${k}`);
}

/**
 * Set aside what this version does not know, in place (the docs are freshly parsed for every load).
 * @param {{metrics:object, targets:object, layout:object, theme?:object, themeMissing?:boolean}} docs
 * @returns {{ warnings: string[], skipped_targets: {id,type}[], unsupported_cards: {index,type,target}[] }}
 */
export function tolerate({ metrics, targets, layout, theme, themeMissing = false }) {
  const warnings = [];
  const skipped = skipUnknownTargets(targets, warnings);
  const unsupported = placeholderUnknownCards(layout, warnings);
  stripUnknownFields('metrics', metrics, warnings);
  stripUnknownFields('targets', targets, warnings);
  stripUnknownFields('layout', layout, warnings);
  if (!themeMissing && theme) stripUnknownFields('theme', theme, warnings);
  followSkipped(layout, skipped, unsupported, warnings);
  return { warnings, skipped_targets: skipped, unsupported_cards: unsupported.sort((a, b) => a.index - b.index) };
}
