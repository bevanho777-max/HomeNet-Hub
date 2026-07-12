// JSON Schema (ajv) validation for the three config files (§4, §2).
// Validation failure → caller keeps the previous good config and surfaces a
// structured error. The panel must never blow up on a bad edit.
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });

// ── metrics.yaml ─ metric templates (§4.1) ──────────────────────────
const metricsSchema = {
  type: 'object',
  required: ['metrics'],
  properties: {
    metrics: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          unit: { type: 'string' },
          format: { type: 'string' },
          higher_is_better: { type: 'boolean' },
          thresholds: {
            type: 'object',
            properties: {
              warn: { type: 'number' },
              danger: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

// ── targets.yaml ─ data sources (§4.2, §5.4, §5.5) ──────────────────
// A map entry is either a JSONPath string ("$.gpu") or an object of
// JSONPath strings ({ v: "$.x", max: "$.y" }). Validated loosely.
const mapEntry = {
  anyOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: { type: 'string' } },
  ],
};

const sourceSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { enum: ['http', 'http_push', 'sql', 'exec', 'demo'] },
    // http
    url: { type: 'string' },
    interval: { type: 'string' },     // duration string e.g. "1.5s", "8s", "30s"
    proxy: { type: 'string' },
    timeout: { type: 'string' },
    // http_push
    token_env: { type: 'string' },
    stale_after_s: { type: 'number', default: 10 }, // §7.3 失效窗口秒;有效默认在 push.js(ajv 未开 useDefaults)
    // sql
    driver: { type: 'string' },
    dsn_env: { type: 'string' },
    query_file: { type: 'string' },
    speed_query_file: { type: 'string' }, // B3 optional 2nd query → token_speed scalar
    speed_samples: { type: 'number', default: 10 }, // B3 whitelisted sample count
    total_query_file: { type: 'string' }, // B4 optional cumulative all-time query (slow-cycle cached)
    // exec
    command: { type: 'string' },
    args: { type: 'array', items: { type: ['string', 'number', 'boolean'] } },
  },
  additionalProperties: true,
  allOf: [
    { if: { properties: { type: { const: 'http' } } }, then: { required: ['url'] } },
    { if: { properties: { type: { const: 'http_push' } } }, then: { required: ['token_env'] } },
    { if: { properties: { type: { const: 'sql' } } }, then: { required: ['query_file', 'dsn_env'] } },
    { if: { properties: { type: { const: 'exec' } } }, then: { required: ['command'] } },
  ],
};

// classify block (§12-step1) — config-driven model classification for sql/token
// targets. Optional; when present it must be well-formed or the reload is
// rejected and the previous good config is kept (§2).
const classifySchema = {
  type: 'object',
  required: ['rules', 'fallback'],
  properties: {
    by: { type: 'string' },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'match', 'color'],
        properties: {
          name: { type: 'string' },
          color: { type: 'string' },
          match: {
            type: 'object',
            required: ['regex'],
            properties: { regex: { type: 'string' } },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
    fallback: {
      type: 'object',
      required: ['name', 'color'],
      properties: { name: { type: 'string' }, color: { type: 'string' } },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const targetsSchema = {
  type: 'object',
  required: ['targets'],
  properties: {
    defaults: { type: 'object', additionalProperties: true },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'source'],
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_]+$' },
          name: { type: 'string' },
          color: { type: 'string' },
          badge: { type: 'string' },
          enabled: { type: 'boolean' },
          source: sourceSchema,
          map: { type: 'object', additionalProperties: mapEntry },
          classify: classifySchema,
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

// ── layout.yaml ─ presentation (§4.3) ───────────────────────────────
const gridCard = {
  type: 'object',
  required: ['type'],
  properties: {
    target: { type: 'string' },
    type: { enum: ['machine', 'token', 'service', 'history', 'info', 'stack'] },
    children: { type: 'array', items: { type: 'string' } }, // B12: stack child target ids
    direction: { enum: ['row', 'column'] }, // B12: stack layout direction (default column)
    title: { type: 'string' },               // §12-step4: info card title (no target needed)
    rings: { type: 'array', items: { type: 'string' } },
    // metric-key strings (machine/service) OR {label,value,level} objects (info, §12-step4)
    items: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: { type: 'string' }, level: { type: 'string' } },
            additionalProperties: true,
          },
        ],
      },
    },
    header_right: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, // B13: single or combined
    clickable: { type: 'string' },
    // §12-step2: externalized card-local labels (all optional strings)
    hint: { type: 'string' },
    detail_title: { type: 'string' },
    columns: { type: 'object', additionalProperties: { type: 'string' } },
    // §12-step2 patch: token card front labels { today, requests_suffix, total }
    labels: { type: 'object', additionalProperties: { type: 'string' } },
    // §12-step6: max class boxes on the token card front (default 3); modal shows all
    front_max: { type: 'number' },
  },
  // data-bound cards need a target; info cards may be static (no target)
  allOf: [
    { if: { properties: { type: { enum: ['machine', 'token', 'service', 'history'] } } }, then: { required: ['target'] } },
    { if: { properties: { type: { const: 'stack' } } }, then: { required: ['children'] } }, // B12
  ],
  additionalProperties: true,
};

const layoutSchema = {
  type: 'object',
  required: ['grid'],
  properties: {
    header: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        clock: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    // §12-step2: externalized global UI chrome labels (all optional strings)
    text: { type: 'object', additionalProperties: { type: 'string' } },
    status_bar: {
      type: 'object',
      properties: { targets: { type: 'array', items: { type: 'string' } } },
      additionalProperties: true,
    },
    grid: { type: 'array', items: gridCard },
    history: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        ranges: { type: 'array', items: { type: 'string' } },
        default_range: { type: 'string' },
        selectable_targets: { type: 'array', items: { type: 'string' } },
        default: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

// ── theme.yaml ─ appearance, visual-only (§12-step6) ────────────────
const themeSchema = {
  type: 'object',
  properties: {
    font_family: { type: 'string' },
    subtitle: { type: 'string' },
    card_bg: { type: 'string' },
    background: {
      type: 'object',
      properties: { base0: { type: 'string' }, base1: { type: 'string' }, base2: { type: 'string' } },
      additionalProperties: true,
    },
    status: {
      type: 'object',
      properties: { ok: { type: 'string' }, warn: { type: 'string' }, danger: { type: 'string' }, cool: { type: 'string' } },
      additionalProperties: true,
    },
    accent: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: true,
};

const validators = {
  metrics: ajv.compile(metricsSchema),
  targets: ajv.compile(targetsSchema),
  layout: ajv.compile(layoutSchema),
  theme: ajv.compile(themeSchema),
};

/**
 * Validate one config kind.
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validate(kind, data) {
  const v = validators[kind];
  if (!v) return { ok: false, errors: [`unknown config kind: ${kind}`] };
  const ok = v(data);
  if (ok) return { ok: true };
  const errors = (v.errors || []).map(
    (e) => `${kind}${e.instancePath || ''} ${e.message}` +
      (e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : '')
  );
  return { ok: false, errors };
}

// ── cross-file referential checks (§2: catch dangling target ids) ───
export function crossValidate({ metrics, targets, layout }) {
  const errors = [];
  const metricKeys = new Set(Object.keys(metrics?.metrics || {}));
  const targetIds = new Set((targets?.targets || []).map((t) => t.id));

  const refTarget = (id, where) => {
    if (id && !targetIds.has(id)) errors.push(`${where}: unknown target id "${id}"`);
  };
  const refMetric = (key, where) => {
    if (key && !metricKeys.has(key)) errors.push(`${where}: unknown metric "${key}"`);
  };

  for (const c of layout?.grid || []) {
    refTarget(c.target, `layout.grid[type=${c.type}]`);
    (c.rings || []).forEach((m) => refMetric(m, `layout.grid[${c.target}].rings`));
    // only string items are metric keys (machine/service); info items are
    // {label,value} objects and are not metric references.
    (c.items || []).forEach((m) => { if (typeof m === 'string') refMetric(m, `layout.grid[${c.target}].items`); });
    (c.children || []).forEach((id) => refTarget(id, `layout.grid[type=stack].children`)); // B12
  }
  for (const id of layout?.status_bar?.targets || []) refTarget(id, 'layout.status_bar');
  for (const id of layout?.history?.selectable_targets || []) refTarget(id, 'layout.history.selectable_targets');

  return errors.length ? { ok: false, errors } : { ok: true };
}
