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
function applyDefaults(targets) {
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
 * Load + validate the full config.
 * @throws Error with `.errors: string[]` on validation failure (caller keeps old config).
 * @returns {{ metrics, targets, layout, etag, sources: Record<string,string> }}
 */
export function loadConfig() {
  const metrics = readYaml(FILES.metrics);
  const targets = readYaml(FILES.targets);
  const layout = readYaml(FILES.layout);
  const theme = readYamlOptional(OPTIONAL_FILES.theme); // §12-step6

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
  const etag = '"' + createHash('sha1').update(JSON.stringify(merged)).digest('hex').slice(0, 16) + '"';

  return {
    ...merged,
    etag,
    sources: { metrics: metrics.path, targets: targets.path, layout: layout.path, theme: theme.path },
    usingFallback: metrics.fallback || targets.fallback || layout.fallback || theme.fallback,
  };
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
    theme: cfg.theme || {},               // §12-step6: appearance (visual only, no secrets)
    metrics: cfg.metrics.metrics || {},
    targets,
    layout: {
      text: cfg.layout.text || {},
      status_bar: cfg.layout.status_bar || { targets: [] },
      grid: cfg.layout.grid || [],
      history: cfg.layout.history || null,
    },
    etag: cfg.etag,
  };
}
