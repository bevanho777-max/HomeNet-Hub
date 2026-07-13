// normalize.js (§5.2) — raw collector JSON -> standard metrics.
// For each target.map entry we resolve JSONPath(s), then apply the metric
// template (metrics.yaml) to produce { value, level, display }.
//
// Status rules (§4.1):
//   value === null            -> level "cool", display "—"  (NEVER 0%)
//   has thresholds            -> ok/warn/danger (inverted if higher_is_better)
//   format-only / no threshold-> level null (neutral, no status color)
import { JSONPath } from 'jsonpath-plus';

// Composite {v,max} ratio metrics with no explicit thresholds get this default
// (mirrors the old UI's byte-bar coloring intent).
const DEFAULT_RATIO = { warn: 80, danger: 92 };

function jp(raw, path) {
  if (typeof path !== 'string') return undefined;
  try {
    const r = JSONPath({ path, json: raw, wrap: false });
    return r === undefined ? undefined : r;
  } catch {
    return undefined;
  }
}

function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Network rate: input is BYTES/sec (§4.2 rx_bps/tx_bps), auto B->K->M->G.
function fmtNet(bps) {
  let v = num(bps);
  if (v == null) return '—';
  let u = 'B';
  if (v >= 1000) { v /= 1000; u = 'K'; }
  if (v >= 1000) { v /= 1000; u = 'M'; }
  if (v >= 1000) { v /= 1000; u = 'G'; }
  const n = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return n + u;
}

function computeLevel(value, metric) {
  if (value == null) return 'cool';
  const th = metric?.thresholds;
  if (!th) return null;
  const { warn, danger } = th;
  if (metric.higher_is_better) {
    if (danger != null && value <= danger) return 'danger';
    if (warn != null && value <= warn) return 'warn';
    return 'ok';
  }
  if (danger != null && value >= danger) return 'danger';
  if (warn != null && value >= warn) return 'warn';
  return 'ok';
}

function fmtScalar(value, metric) {
  if (value == null) return '—';
  if (typeof value === 'string') return value; // status/model/role pass-through
  const unit = metric?.unit || '';
  if (unit === '%' || unit === '°C' || unit === 'W' || unit === 'ms') {
    return Math.round(value) + unit;
  }
  // generic number (e.g. token_speed, counts)
  const n = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return unit ? `${n}${unit}` : String(n);
}

// Substitute {placeholders} in a metric.format string with formatted subfields.
function applyFormat(format, fields, metricKey) {
  return format.replace(/\{(\w+)\}/g, (_, k) => {
    const raw = fields[k];
    if (raw == null) return '—';
    if (metricKey === 'net') return fmtNet(raw);
    if (metricKey === 'loadavg') { const n = num(raw); return n == null ? '—' : n.toFixed(2); }
    if (metricKey.endsWith('_bytes')) { const n = num(raw); return n == null ? '—' : n.toFixed(1); }
    if (metricKey === 'uptime') { const n = num(raw); return n == null ? '—' : String(Math.round(n)); }
    const n = num(raw);
    return n == null ? String(raw) : String(n);
  });
}

// Normalize one metric given its map entry (string or object) + template.
function normMetric(raw, mapEntry, metric, metricKey) {
  // composite (object of subpaths) -> use format
  if (mapEntry && typeof mapEntry === 'object') {
    const fields = {};
    let anyPresent = false;
    for (const [k, path] of Object.entries(mapEntry)) {
      const v = jp(raw, path);
      fields[k] = v === undefined ? null : v;
      if (fields[k] != null) anyPresent = true;
    }
    // B8: uptime given as seconds (uptime_s) → derive {d,h} for the {d}{h} format.
    // Single conversion point; the renderer stays generic (shows metric.display).
    if (metricKey === 'uptime' && fields.s != null && fields.d == null && fields.h == null) {
      const s = num(fields.s);
      if (s != null) { fields.d = Math.floor(s / 86400); fields.h = Math.floor((s % 86400) / 3600); anyPresent = true; }
    }
    let value = null;
    let level = null;
    // ratio metrics {v,max}: derive pct + level
    if (fields.v != null && fields.max != null && Number(fields.max) > 0) {
      value = Math.max(0, Math.min(100, (Number(fields.v) / Number(fields.max)) * 100));
      const th = metric?.thresholds || (metricKey.endsWith('_bytes') ? DEFAULT_RATIO : null);
      level = computeLevel(value, { ...metric, thresholds: th });
    } else if (!anyPresent) {
      level = 'cool';
    }
    // Template-less metrics get a shape-inferred default: a {v,max} pair renders
    // like disk_bytes ("used/total G"); anything else joins its subfields.
    const format = metric?.format
      || (('v' in mapEntry && 'max' in mapEntry) ? '{v}/{max}G' : Object.keys(mapEntry).map((k) => `{${k}}`).join(' '));
    const display = anyPresent ? applyFormat(format, fields, metricKey) : '—';
    return { value, level, display };
  }

  // scalar (string JSONPath)
  const rawVal = jp(raw, mapEntry);
  if (typeof rawVal === 'string') {
    return { value: rawVal, level: null, display: rawVal };
  }
  const value = rawVal === undefined ? null : num(rawVal);
  const level = computeLevel(value, metric);
  const display = fmtScalar(value, metric);
  return { value, level, display };
}

/**
 * Normalize a raw collector payload into standard metrics for a target.
 * @returns {{ metrics: Record<string,{value,level,display}> }}
 */
export function normalize(raw, target, metricTemplates) {
  const metrics = {};
  const map = target.map || {};
  for (const [metricKey, mapEntry] of Object.entries(map)) {
    const tpl = metricTemplates?.[metricKey] || {};
    metrics[metricKey] = normMetric(raw, mapEntry, tpl, metricKey);
  }
  return { metrics };
}

// Scalar metric values worth persisting to the timeseries (rings + history).
export function samplableRows(targetId, normalized) {
  const rows = [];
  for (const [metric, m] of Object.entries(normalized.metrics || {})) {
    if (typeof m.value === 'number' && Number.isFinite(m.value)) {
      rows.push([targetId, metric, m.value]);
    }
  }
  return rows;
}
