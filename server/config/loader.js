// Read + merge + validate the three YAML config files (§3, §4).
// Real config lives in config/ (bind-mounted, .gitignored). For a fresh
// checkout with an empty config/, we transparently fall back to
// config.example/ so `npm start` / `docker compose up` boots out of the box.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { validate, crossValidate } from './schema.js';
import { VERSION } from '../version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
export const CONFIG_DIR = process.env.CONFIG_DIR || join(ROOT, 'config');
export const EXAMPLE_DIR = join(ROOT, 'config.example');

const FILES = { metrics: 'metrics.yaml', targets: 'targets.yaml', layout: 'layout.yaml' };
const OPTIONAL_FILES = { theme: 'theme.yaml' }; // §12-step6: optional, absent → {}

// Resolve a config file, preferring config/ then falling back to config.example/.
function resolveFile(name) {
  const primary = join(CONFIG_DIR, name);
  if (existsSync(primary)) return { path: primary, fallback: false };
  const fallback = join(EXAMPLE_DIR, name);
  if (existsSync(fallback)) return { path: fallback, fallback: true };
  return null;
}

function readYaml(name) {
  const r = resolveFile(name);
  if (!r) throw new Error(`config file not found: ${name} (looked in config/ and config.example/)`);
  let text;
  try {
    text = readFileSync(r.path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${name}: ${e.message}`);
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error(`YAML syntax error in ${name}: ${e.message}`);
  }
  return { doc: doc || {}, fallback: r.fallback, path: r.path };
}

// Like readYaml but returns an empty doc if the file is absent (optional files).
function readYamlOptional(name) {
  if (!resolveFile(name)) return { doc: {}, fallback: false, path: null, missing: true };
  return readYaml(name);
}

// Apply targets.defaults onto each target's source where unset.
// Exported so the effective-config layer can put runtime-added targets through the
// SAME defaults the file ones get — a user target that skipped them would poll on a
// different interval than an identical YAML one.
export function applyDefaults(targets) {
  const defaults = targets.defaults || {};
  for (const t of targets.targets || []) {
    t.enabled = t.enabled !== false; // default enabled:true
    t.source = t.source || {};
    for (const [k, v] of Object.entries(defaults)) {
      if (t.source[k] === undefined && k !== 'http_proxy') t.source[k] = v;
    }
    if (defaults.http_proxy && t.source.type === 'http' && t.source.proxy === undefined) {
      t.source.proxy = defaults.http_proxy || '';
    }
  }
  return targets;
}

/**
 * Empty out the SHIPPED DEMO CONTENT of a fallback document, in place.
 *
 * Only ever applied to a document that actually came from config.example/ — a real
 * config/targets.yaml is the operator's own work and dismissing the demo must never
 * touch it. That is why each half checks its own `fallback` flag rather than a single
 * global one: an install with a real targets.yaml but no layout.yaml gets its demo grid
 * cleared and its own targets left alone.
 *
 * What is removed is the demo BOARD: the example targets, the example cards, the status
 * bar that names them, and the history pane that selects them. `header` and `text` stay,
 * because they are page chrome and a title-less panel just looks broken.
 *
 * `history` in particular MUST go rather than be left as-is: it carries
 * selectable_targets naming demo targets that no longer exist, and crossValidate refuses
 * exactly that. Blanking the grid but keeping history would produce a config that fails
 * its own validation gate on the next load — a panel that dismisses the demo and then
 * refuses to start.
 */
function stripDemoContent(targets, layout) {
  if (targets.fallback) {
    targets.doc = { ...targets.doc, targets: [] };
  }
  if (layout.fallback) {
    const { header, text } = layout.doc || {};
    layout.doc = {
      ...(header ? { header } : {}),
      ...(text ? { text } : {}),
      grid: [],
      status_bar: { targets: [] },
      // Not `null`: the layout schema has no `history` requirement, and omitting it is
      // how "there is no history pane" is already spelled everywhere else.
    };
  }
}

/**
 * Load + validate the full config.
 * @param {{demoDismissed?: boolean}} [opts]  when demoDismissed, the SHIPPED example
 *   targets/layout are loaded and then emptied (see stripDemoContent). metrics and
 *   theme still fall back in full — without metric templates and colors there is
 *   nothing to render a user's own card WITH.
 * @throws Error with `.errors: string[]` on validation failure (caller keeps old config).
 * @returns {{ metrics, targets, layout, etag, sources: Record<string,string> }}
 */
export function loadConfig({ demoDismissed = false } = {}) {
  const metrics = readYaml(FILES.metrics);
  const targets = readYaml(FILES.targets);
  const layout = readYaml(FILES.layout);
  const theme = readYamlOptional(OPTIONAL_FILES.theme); // §12-step6

  // The demo board is the fallback content, so "is this install still on the demo" is
  // "did targets or layout come from config.example". Computed BEFORE stripping, since
  // stripping is what makes the answer stop being visible in the document.
  const onExampleBoard = targets.fallback || layout.fallback;
  if (demoDismissed) stripDemoContent(targets, layout);

  const errors = [];
  for (const [kind, m] of [['metrics', metrics], ['targets', targets], ['layout', layout]]) {
    const r = validate(kind, m.doc);
    if (!r.ok) errors.push(...r.errors);
  }
  if (!theme.missing) {
    const r = validate('theme', theme.doc);
    if (!r.ok) errors.push(...r.errors);
  }
  if (errors.length) {
    const err = new Error('config validation failed');
    err.errors = errors;
    throw err;
  }

  applyDefaults(targets.doc);

  const cross = crossValidate({ metrics: metrics.doc, targets: targets.doc, layout: layout.doc });
  if (!cross.ok) {
    const err = new Error('config cross-validation failed');
    err.errors = cross.errors;
    throw err;
  }

  const merged = { metrics: metrics.doc, targets: targets.doc, layout: layout.doc, theme: theme.doc };
  const etag = computeEtag(merged);

  return {
    ...merged,
    etag,
    sources: { metrics: metrics.path, targets: targets.path, layout: layout.path, theme: theme.path },
    usingFallback: metrics.fallback || targets.fallback || layout.fallback || theme.fallback,
    // Two separate facts, deliberately not collapsed into one:
    //   onExampleBoard — this install has never had its own targets/layout;
    //   demoDismissed  — the operator has cleared the demo for good.
    // The banner is offered on the first AND NOT the second; health reporting wants
    // both, and a single boolean would make "dismissed" indistinguishable from
    // "the operator wrote a real config".
    onExampleBoard,
    demoDismissed: !!demoDismissed,
  };
}

/**
 * The etag recipe, in one place. The effective-config layer recomputes it over the
 * merged document, and a drift between the two recipes would show as a frontend that
 * never notices a change — or one that reloads forever.
 *
 * VERSION is folded in here rather than at the call sites, for both correctness and
 * safety. Correctness: the etag identifies the PAYLOAD /api/config serves, and that
 * payload now carries `version` — without this, a tab polling with If-None-Match keeps
 * getting 304 after a deploy and shows the old version until someone reloads. Safety:
 * one place means the two call sites cannot drift apart again.
 * @param {{metrics:object,targets:object,layout:object,theme:object}} merged
 */
export function computeEtag(merged) {
  const payload = JSON.stringify({ ...merged, version: VERSION });
  return '"' + createHash('sha1').update(payload).digest('hex').slice(0, 16) + '"';
}

/**
 * Strip secrets/internals for the public /api/config payload (§5.1).
 * Frontend gets metric templates, sanitized target meta, and the full layout —
 * never urls, dsns, or token env names.
 */
export function publicConfig(cfg) {
  const targets = (cfg.targets.targets || []).map((t) => ({
    id: t.id,
    name: t.name || t.id,
    color: t.color || null,
    badge: t.badge || null,
    enabled: t.enabled !== false,
    type: t.source?.type || null,
  }));
  return {
    // no hardcoded brand: the frontend supplies a generic bottom-line title
    header: cfg.layout.header || { clock: true },
    version: VERSION,                     // product version for the page footer
    theme: cfg.theme || {},               // §12-step6: appearance (visual only, no secrets)
    metrics: cfg.metrics.metrics || {},
    targets,
    layout: {
      text: cfg.layout.text || {},
      status_bar: cfg.layout.status_bar || { targets: [] },
      grid: cfg.layout.grid || [],
      history: cfg.layout.history || null,
    },
    // P2: the frontend offers the "this is demo data" banner on this and nothing else.
    // A boolean, and only ever true while BOTH halves hold — still on the shipped
    // example board, and not yet dismissed. An install with a real config/ has never
    // been on the example board and so never sees it.
    demo_mode: !!cfg.onExampleBoard && !cfg.demoDismissed,
    etag: cfg.etag,
  };
}
