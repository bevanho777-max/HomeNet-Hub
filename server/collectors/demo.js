// demo collector (type: demo) — §12-step4.
// Synthesizes plausible data with NO real backend, so a fresh clone "moves" out
// of the box. Values are generated to satisfy whatever the target's `map`
// declares (scalars, {v,max} bytes, {rx,tx} net, loadavg, uptime, status…) and
// drift via a small random walk per (target, metric). Token targets get a set
// of synthetic raw `model` rows that the config `classify` buckets normally.
//
// This collector is additive — it never touches the http/push/sql/exec paths.

// per-(target:metric) random-walk state so values change smoothly each tick
const walk = new Map();
function rw(id, key, { min, max, step, init }) {
  const k = id + ':' + key;
  let v = walk.has(k) ? walk.get(k) : (init ?? (min + max) / 2);
  v += (Math.random() - 0.5) * 2 * step;
  v = Math.max(min, Math.min(max, v));
  walk.set(k, v);
  return v;
}

// fixed capacities for {v,max} byte metrics (GB)
const CAPACITY = { vram_bytes: 24, mem_bytes: 64, disk_bytes: 1000 };

// write a value into a synthetic raw object at a simple JSONPath
// ("$.a.b", "$.load[0]", "$.net.rx") so the normal normalize() can read it back.
function setPath(obj, path, val) {
  if (typeof path !== 'string') return;
  const segs = path.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter((s) => s != null && s !== '');
  let cur = obj;
  for (let i = 0; i < segs.length; i++) {
    const isIdx = /^\d+$/.test(segs[i]);
    const key = isIdx ? Number(segs[i]) : segs[i];
    if (i === segs.length - 1) { cur[key] = val; return; }
    if (cur[key] == null) cur[key] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[key];
  }
}

// keep % metrics mostly in "ok", occasionally nudging into "warn"
function synthPct(id, key, tpl) {
  const warn = tpl?.thresholds?.warn ?? 70;
  const danger = tpl?.thresholds?.danger ?? 90;
  return rw(id, key, { min: 8, max: Math.min(danger - 2, warn + (danger - warn) * 0.5), step: 5, init: warn * 0.6 });
}

function synthScalar(id, key, tpl) {
  const unit = tpl?.unit;
  if (key === 'status') return 'online';
  if (key === 'model') return 'demo-model';
  if (key === 'role') return 'demo';
  if (key === 'token_speed') return Math.round(rw(id, key, { min: 30, max: 90, step: 6, init: 55 }));
  if (key === 'gpu_temp' || unit === '°C') return Math.round(rw(id, key, { min: 42, max: 78, step: 3, init: 58 }));
  if (key === 'gpu_power' || unit === 'W') return Math.round(rw(id, key, { min: 120, max: 280, step: 12, init: 190 }));
  if (key === 'latency' || unit === 'ms') return Math.round(rw(id, key, { min: 4, max: 60, step: 6, init: 18 }));
  if (unit === '%') return Math.round(synthPct(id, key, tpl));
  return Math.round(rw(id, key, { min: 1, max: 12, step: 1, init: 4 })); // counts (procs/sessions/skills)
}

function fillMetric(raw, id, key, entry, tpl) {
  if (entry && typeof entry === 'object') {
    if ('v' in entry && 'max' in entry) {
      const cap = CAPACITY[key] || 100;
      const pct = rw(id, key + '_pct', { min: 20, max: 90, step: 5, init: 55 });
      setPath(raw, entry.v, Math.round(cap * pct / 100 * 10) / 10);
      setPath(raw, entry.max, cap);
    } else if ('rx' in entry && 'tx' in entry) {
      setPath(raw, entry.rx, Math.round(rw(id, key + '_rx', { min: 50, max: 9000, step: 800, init: 1200 })));
      setPath(raw, entry.tx, Math.round(rw(id, key + '_tx', { min: 20, max: 4000, step: 400, init: 500 })));
    } else if ('m1' in entry) {
      const base = rw(id, key, { min: 0.1, max: 4, step: 0.4, init: 0.8 });
      setPath(raw, entry.m1, Math.round(base * 100) / 100);
      setPath(raw, entry.m5, Math.round(base * 90) / 100);
      setPath(raw, entry.m15, Math.round(base * 80) / 100);
    } else if ('s' in entry) {
      setPath(raw, entry.s, 15 * 86400 + new Date().getHours() * 3600); // ~15d Xh uptime_s (protocol field)
    } else if ('d' in entry && 'h' in entry) {
      setPath(raw, entry.d, 12);
      setPath(raw, entry.h, new Date().getHours());
    } else {
      for (const [, sp] of Object.entries(entry)) setPath(raw, sp, Math.round(rw(id, key + ':' + sp, { min: 1, max: 100, step: 8 })));
    }
  } else {
    setPath(raw, entry, synthScalar(id, key, tpl));
  }
}

// Build a synthetic raw payload for a target, honoring its `map` declaration.
export function collectDemo(target, metrics) {
  const raw = {};
  for (const [mk, entry] of Object.entries(target.map || {})) {
    fillMetric(raw, target.id, mk, entry, metrics?.[mk] || {});
  }
  return raw;
}

// Derive a model name guaranteed to match a classify rule (first al/word token).
function ruleSampleModel(rule, i) {
  const alts = String(rule?.match?.regex || '').split('|');
  const lit = alts.map((a) => a.replace(/[^a-z0-9]/gi, '')).find((a) => a.length >= 2);
  return `demo-${lit || ('cat' + i)}-model`;
}

// Synthetic token rows (raw `model` names) for the last `days` days, sized so
// each classify bucket — plus an unmatched "Other" — has data.
export function demoTokenRows(classify, days = 30) {
  const rules = classify?.rules || [];
  const now = Date.now();
  const rows = [];
  const emit = (model, base) => {
    for (let d = days - 1; d >= 0; d--) {
      const day = new Date(now - d * 86400000);
      const jitter = 0.6 + Math.random() * 0.8;
      rows.push({ model, day, tokens: Math.round(base * jitter), requests: Math.max(1, Math.round(20 * jitter / (rules.length + 1))) });
    }
  };
  rules.forEach((r, i) => emit(ruleSampleModel(r, i), 600000 / (i + 1)));
  emit('demo-other-svc', 45000); // matches no rule → fallback bucket
  return rows;
}

// Synthetic token speed for the snapshot card's token_speed metric.
export function demoTokenSpeed(id = 'token') {
  return Math.round(rw(id, 'token_speed', { min: 30, max: 90, step: 6, init: 55 }));
}
