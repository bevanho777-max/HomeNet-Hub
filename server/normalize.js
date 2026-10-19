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
// Optional metric.`divide`: scale every numeric field by it and keep 1 decimal
// (e.g. GB→TB via divide:1024, format "{v}/{max}T"). Display-only — ratio/threshold
// still use raw v/max (see normMetric) — and takes precedence over the metricKey
// formatting below.
function applyFormat(format, fields, metricKey, divide) {
  const div = Number(divide) || 0;
  return format.replace(/\{(\w+)\}/g, (_, k) => {
    const raw = fields[k];
    if (raw == null) return '—';
    if (div > 0) { const n = num(raw); return n == null ? '—' : (n / div).toFixed(1); }
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
    const display = anyPresent ? applyFormat(format, fields, metricKey, metric?.divide) : '—';
    // B20: `part_thresholds` colors each subfield on its own instead of giving the
    // whole cell one status — e.g. one temperature per disk in a single KV cell, so a
    // hot drive stands out next to cold ones. Additive: a metric without the field
    // returns exactly the same shape as before, so every existing card is unaffected.
    if (metric?.part_thresholds) {
      const parts = [];
      for (const k of Object.keys(mapEntry)) {
        if (k.endsWith('_label')) continue;   // a sibling naming another part, not a part
        const n = num(fields[k]);
        if (n == null) continue;
        const part = { display: fmtScalar(n, metric), level: computeLevel(n, { thresholds: metric.part_thresholds }) };
        // Optional `<key>_label` sibling in the map names the part (e.g. the DSM bay a
        // disk sits in). Rendered as a superscript tag, so it stays a label and never
        // takes the value's status color.
        const lbl = jp(raw, mapEntry[`${k}_label`]);
        if (lbl != null && lbl !== '') part.label = String(lbl);
        parts.push(part);
      }
      if (parts.length) {
        // The cell's own level is the worst part, so the item border still summarises
        // the group at a glance while each number keeps its individual color.
        const RANK = { ok: 1, warn: 2, danger: 3 };
        const worst = parts.reduce((a, p) => ((RANK[p.level] || 0) > (RANK[a] || 0) ? p.level : a), null);
        return { value, level: worst ?? level, display, parts };
      }
    }
    return { value, level, display };
  }

  // scalar (string JSONPath)
  const rawVal = jp(raw, mapEntry);
  if (typeof rawVal === 'string') {
    // Optional metric.level_map colors a text value (e.g. raid "clean"->ok,
    // "degraded"->danger). Unmapped values / no map stay neutral (null).
    const level = metric?.level_map?.[rawVal] ?? null;
    return { value: rawVal, level, display: rawVal };
  }
  const value = rawVal === undefined ? null : num(rawVal);
  const level = computeLevel(value, metric);
  const display = fmtScalar(value, metric);
  return { value, level, display };
}

// ── 多 GPU(v2.18)─────────────────────────────────────────────────────
// 协议的 gpus[] 一直是数组,但 map 只取 gpus[0]:双卡机器的第二张卡从来没上过卡面。
// 这里在 map 之后统一处理 —— 只在「payload 里 ≥2 张卡」或「target 声明 gpu_count ≥2」
// 时介入,单卡/无卡机器一个字节都不变。
//
//   合计:gpu=平均使用率  vram_bytes=已用合计/总量合计  gpu_temp=最高 edge 温度
//         gpu_power=功耗相加(各卡都报了 power_cap_w 时显示「合计/上限合计 W」)
//   告警:颜色按**单张卡**判 —— 合计显存比例永远不高于最满的那张卡,用合计判断等于
//         放宽阈值。所以 vram_bytes / gpu_temp / gpu_power 取各卡 level 的最差值,
//         阈值仍是 metrics.yaml 里同一份,一个数字都没改。
//   每卡:gpuN、gpuN_vram_bytes、gpuN_temp(edge)、gpuN_temp_junction、gpuN_temp_mem、
//         gpuN_power —— 普通 metric,自动进历史,机器明细弹窗按卡画线。
//   少卡:gpu_cards = 检测到的张数;少于 gpu_count 时 level=danger,卡面显示警告,
//         免得只剩一张卡时合计值看起来一切正常。
// 卡面小字由各合计 metric 上的 `cards` 数组提供(用 cards 而不是 parts,不触发 B20 的分段渲染)。
const LV_RANK = { ok: 1, warn: 2, danger: 3 };
const worstLevel = (levels) => levels.reduce((a, l) => ((LV_RANK[l] || 0) > (LV_RANK[a] || 0) ? l : a), null);
const gb1 = (n) => n.toFixed(1);

function applyGpuMulti(raw, target, tpls, metrics) {
  const list = Array.isArray(raw?.gpus) ? raw.gpus.filter((g) => g && typeof g === 'object') : [];
  const expected = Number(target.gpu_count) || 0;
  if (list.length < 2 && expected < 2) return;

  const T = (k) => tpls?.[k] || {};
  const vramTh = T('vram_bytes').thresholds || DEFAULT_RATIO;
  const cards = list
    .map((g, pos) => ({ g, i: num(g.idx) ?? pos }))
    .sort((a, b) => a.i - b.i)
    .map(({ g, i }) => {
      const util = num(g.util_pct), used = num(g.vram_used_gb), total = num(g.vram_total_gb);
      const temp = num(g.temp_c), power = num(g.power_w), cap = num(g.power_cap_w);
      const ratio = used != null && total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null;
      return {
        i, util, used, total, ratio, temp, power, cap,
        tj: num(g.temp_junction_c), tm: num(g.temp_mem_c),
        lvUtil: computeLevel(util, T('gpu')),
        lvVram: computeLevel(ratio, { thresholds: vramTh }),
        lvTemp: computeLevel(temp, T('gpu_temp')),
        lvPower: computeLevel(power, T('gpu_power')),
      };
    });

  // 每卡 metric
  for (const c of cards) {
    const p = `gpu${c.i}`;
    metrics[p] = { value: c.util, level: c.lvUtil, display: fmtScalar(c.util, T('gpu')) };
    metrics[`${p}_vram_bytes`] = {
      value: c.ratio, level: c.lvVram,
      display: c.used != null && c.total != null ? `${gb1(c.used)}/${gb1(c.total)}G` : '—',
    };
    metrics[`${p}_temp`] = { value: c.temp, level: c.lvTemp, display: fmtScalar(c.temp, T('gpu_temp')) };
    // junction/mem 正常就比 edge 高 20-30°C,套 edge 的阈值会常年发红;只进历史,不着色。
    metrics[`${p}_temp_junction`] = { value: c.tj, level: c.tj == null ? 'cool' : null, display: fmtScalar(c.tj, T('gpu_temp')) };
    metrics[`${p}_temp_mem`] = { value: c.tm, level: c.tm == null ? 'cool' : null, display: fmtScalar(c.tm, T('gpu_temp')) };
    metrics[`${p}_power`] = { value: c.power, level: c.lvPower, display: fmtScalar(c.power, T('gpu_power')) };
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(target.map || {}, k);
  const vals = (k) => cards.map((c) => c[k]).filter((v) => v != null);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const lvOf = (k) => cards.filter((c) => c[k] != null);

  if (has('gpu')) {
    const xs = vals('util');
    const v = xs.length ? sum(xs) / xs.length : null;
    metrics.gpu = {
      value: v, level: computeLevel(v, T('gpu')), display: fmtScalar(v, T('gpu')),
      cards: lvOf('util').map((c) => ({ i: c.i, text: `${Math.round(c.util)}%`, level: c.lvUtil })),
    };
  }
  if (has('vram_bytes')) {
    const ok = cards.filter((c) => c.used != null && c.total > 0);
    const u = sum(ok.map((c) => c.used)), t = sum(ok.map((c) => c.total));
    const v = ok.length ? Math.max(0, Math.min(100, (u / t) * 100)) : null;
    const tpl = T('vram_bytes');
    metrics.vram_bytes = {
      value: v,
      level: ok.length ? worstLevel([computeLevel(v, { thresholds: vramTh }), ...ok.map((c) => c.lvVram)]) : 'cool',
      display: ok.length ? applyFormat(tpl.format || '{v}/{max}G', { v: u, max: t }, 'vram_bytes', tpl.divide) : '—',
      cards: ok.map((c) => ({ i: c.i, text: `${gb1(c.used)}G`, full: `${gb1(c.used)}/${gb1(c.total)}`, level: c.lvVram })),
    };
  }
  if (has('gpu_temp')) {
    const xs = vals('temp');
    const v = xs.length ? Math.max(...xs) : null;
    metrics.gpu_temp = {
      value: v, level: xs.length ? worstLevel(lvOf('temp').map((c) => c.lvTemp)) : 'cool',
      display: fmtScalar(v, T('gpu_temp')),
      cards: lvOf('temp').map((c) => ({ i: c.i, text: `${Math.round(c.temp)}`, level: c.lvTemp })),
    };
  }
  if (has('gpu_power')) {
    const xs = vals('power');
    const v = xs.length ? sum(xs) : null;
    const caps = vals('cap');
    const capSum = caps.length === cards.length && caps.length ? sum(caps) : null;
    metrics.gpu_power = {
      value: v, level: xs.length ? worstLevel(lvOf('power').map((c) => c.lvPower)) : 'cool',
      display: v == null ? '—' : capSum ? `${Math.round(v)}/${Math.round(capSum)}W` : fmtScalar(v, T('gpu_power')),
      cards: lvOf('power').map((c) => ({ i: c.i, text: `${Math.round(c.power)}`, level: c.lvPower })),
    };
  }
  metrics.gpu_cards = {
    value: cards.length,
    level: expected && cards.length < expected ? 'danger' : 'ok',
    display: expected ? `${cards.length}/${expected}` : String(cards.length),
    ...(expected ? { expected } : {}),
  };
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
  applyGpuMulti(raw, target, metricTemplates, metrics);
  return { metrics };
}

// Scalar metric values worth persisting to the timeseries (rings + history).
// B23: a `part_thresholds` metric has no scalar of its own (its value is null), so a
// cell like nas75's seven drive temperatures never reached the timeseries at all and
// could not be charted. `sample_parts` in metrics.yaml opts one into a derived scalar
// -- "max" records the hottest member as `<metric>_max`, which is the right summary
// for a threshold group: if the worst part is safe, all of them are. Opt-in, because
// the reduction is only meaningful for comparable parts (it would be nonsense for the
// gateway's per-model request counts), and a metric without the field behaves exactly
// as before.
const PART_REDUCERS = {
  max: (xs) => Math.max(...xs),
  min: (xs) => Math.min(...xs),
  avg: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
};

export function samplableRows(targetId, normalized, metricTemplates) {
  const rows = [];
  for (const [metric, m] of Object.entries(normalized.metrics || {})) {
    if (typeof m.value === 'number' && Number.isFinite(m.value)) {
      rows.push([targetId, metric, m.value]);
    }
    const how = metricTemplates?.[metric]?.sample_parts;
    const reduce = how && PART_REDUCERS[how];
    if (reduce && Array.isArray(m.parts) && m.parts.length) {
      // parts carry formatted display strings, so read the number back off them.
      const xs = m.parts.map((p) => Number(p.display)).filter((n) => Number.isFinite(n));
      if (xs.length) rows.push([targetId, `${metric}_${how}`, reduce(xs)]);
    }
  }
  return rows;
}
