// token_detail.js (§5.1, §8, §12-step1) — pivot read-only SQL rows into the
// by-model view. Model classification is CONFIG-DRIVEN: the token target's
// `classify` block (targets.yaml) supplies the rules (name/regex/color) and a
// fallback. No model names or class labels are hardcoded here (CLAUDE.md).
// Used by:
//   • the sql collector -> snapshot token card (columns + 5-day spark)
//   • GET /api/token_detail -> modal (stacked bars + per-model table)

export const TOKEN_RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30 };

function compact(n) {
  if (n == null) return '—';
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function dayStr(d) {
  if (d == null) return '';
  if (d instanceof Date) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d).slice(0, 10);
}

function safeRegex(src) {
  try { return src ? new RegExp(src, 'i') : null; } catch { return null; }
}

// Compile the config `classify` block into an ordered class list + fallback.
// classify: { by, rules: [{ name, match: { regex }, color }], fallback: { name, color } }
function compileClassify(classify) {
  const rules = (classify?.rules || []).map((r, i) => ({
    key: `c${i}`,
    label: r.name,
    color: r.color,
    re: safeRegex(r.match?.regex),
  }));
  const fb = classify?.fallback || {};
  const fallback = { key: 'fallback', label: fb.name || '其他', color: fb.color || '#8b93a3' };
  return { rules, fallback };
}

// Classify one record by its model field (rules in order, case-insensitive).
function classOf(model, compiled) {
  const m = String(model ?? '');
  for (const r of compiled.rules) if (r.re && r.re.test(m)) return r;
  return compiled.fallback;
}

/**
 * Pivot raw rows into the by-model view, using config-driven classification.
 * Each row is classified by `row.model` (falls back to `row.model_class` for
 * backward compatibility with pre-bucketed queries).
 * @param {object[]} rows   [{ model|model_class, day, tokens, requests }]
 * @param {object}   opts   { speed, classify }
 * @returns { columns, spark, series, table, speed }
 */
export function pivotTokens(rows, { speed = null, classify = null, totalLabel = null, totals = null } = {}) {
  const compiled = compileClassify(classify);
  const classList = [...compiled.rules, compiled.fallback]; // ordered, display order

  const days = [...new Set((rows || []).map((r) => dayStr(r.day)))].sort();
  const today = days[days.length - 1] || null;
  const dayIdx = new Map(days.map((d, i) => [d, i]));

  // per-class aggregates + per-day matrix
  const byClass = new Map(classList.map((c) => [c.key, { all: 0, today: 0, requests: 0 }]));
  const matrix = {};
  for (const c of classList) matrix[c.key] = days.map(() => 0);

  for (const r of rows || []) {
    const cls = classOf(r.model ?? r.model_class, compiled);
    const agg = byClass.get(cls.key);
    const tok = Number(r.tokens) || 0;
    agg.all += tok;
    agg.requests += Number(r.requests) || 0;
    const d = dayStr(r.day);
    if (d === today) agg.today += tok;
    const i = dayIdx.get(d);
    if (i != null) matrix[cls.key][i] += tok;
  }

  // B4: cumulative all-time aggregates for the "all"/requests columns. When the
  // caller supplies `totals` (per-model all-time rows), classify + sum those;
  // otherwise fall back to the windowed byClass sums (previous behavior).
  const useTotals = Array.isArray(totals) && totals.length > 0;
  const cumByClass = new Map(classList.map((c) => [c.key, { all: 0, requests: 0 }]));
  if (useTotals) {
    for (const r of totals) {
      const agg = cumByClass.get(classOf(r.model ?? r.model_class, compiled).key);
      agg.all += Number(r.tokens) || 0;
      agg.requests += Number(r.requests) || 0;
    }
  }
  const allOf = (key) => (useTotals ? cumByClass.get(key).all : byClass.get(key).all);
  const reqOf = (key) => (useTotals ? cumByClass.get(key).requests : byClass.get(key).requests);

  const columns = classList.map((c) => {
    const a = byClass.get(c.key);
    return {
      key: c.key, label: c.label, color: c.color,
      all: compact(allOf(c.key)), today: compact(a.today), requests: reqOf(c.key),
      all_raw: allOf(c.key), today_raw: a.today,
    };
  });
  // total column — label is config-driven (token card labels.total), generic fallback
  const totAll = columns.reduce((s, c) => s + c.all_raw, 0);
  const totToday = columns.reduce((s, c) => s + c.today_raw, 0);
  const totReq = columns.reduce((s, c) => s + c.requests, 0);
  columns.push({
    key: 'total', label: totalLabel || 'Total', color: '#eef3fb',
    all: compact(totAll), today: compact(totToday), requests: totReq,
    all_raw: totAll, today_raw: totToday,
  });

  // daily totals (across classes), last 5 days → spark
  const dailyTotal = new Map();
  for (const r of rows || []) {
    const d = dayStr(r.day);
    dailyTotal.set(d, (dailyTotal.get(d) || 0) + (Number(r.tokens) || 0));
  }
  const last5 = days.slice(-5);
  const spark = last5.map((d) => ({
    label: d.slice(5),
    value: dailyTotal.get(d) || 0,
    display: compact(dailyTotal.get(d) || 0),
  }));

  // per-model table: always show the rule classes; show fallback only if used.
  const table = classList
    .filter((c) => c.key !== 'fallback' || (allOf(c.key) || 0) > 0)
    .map((c) => {
      return {
        label: c.label, color: c.color,
        tokens: compact(allOf(c.key)), requests: reqOf(c.key),
        share: totAll > 0 ? Math.round((allOf(c.key) / totAll) * 100) : 0,
      };
    });

  return {
    columns,
    spark,
    series: {
      days: days.map((d) => d.slice(5)),
      classes: classList.map((c) => ({ key: c.key, label: c.label, color: c.color })),
      matrix,
    },
    table,
    speed,
  };
}
