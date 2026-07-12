// Shared rendering helpers for the config-driven renderers (§6).
// Status color logic lives server-side (normalize → level); the frontend only
// maps level → lv-* class / --c color. Visuals match the .24 baseline 1:1.

export const LV_VAR = {
  ok: 'var(--lv-ok)', warn: 'var(--lv-warn)', danger: 'var(--lv-danger)', cool: 'var(--lv-cool)',
};

export const lvClass = (level) => (level ? `lv-${level}` : '');
export const levelColor = (level) => LV_VAR[level] || 'var(--blue)';

// Status string → level (B1). Healthy vocab → ok(green); explicit failure vocab
// → danger(red). Anything else (unknown/degraded/starting…) → null(neutral).
// Transport failures (timeout/conn-fail/non-2xx) surface as snap.online===false,
// handled by callers — NOT reddened here. Collector raw value is left untouched.
const STATUS_OK = new Set(['online', 'ok', 'up', 'live', 'running', 'healthy']);
const STATUS_BAD = new Set(['offline', 'down', 'dead', 'error', 'fail', 'failed', 'unreachable', 'timeout', 'stopped', 'unavailable']);
export function statusLevel(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  if (STATUS_OK.has(s)) return 'ok';
  if (STATUS_BAD.has(s)) return 'danger';
  return null;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A metric cell from /api/snapshot: { value, level, display }.
export const mget = (snap, key) => (snap?.metrics?.[key] || { value: null, level: 'cool', display: '—' });

// Ring gauge. value===null → show "—", never 0%, color = cool (§4.1/§6).
export function ring(label, m) {
  const isNull = m.value == null || typeof m.value !== 'number';
  const p = isNull ? 0 : Math.max(0, Math.min(100, m.value));
  const c = isNull ? 'var(--lv-cool)' : levelColor(m.level);
  // B2: ring center is ALWAYS an integer percentage (composite *_bytes uses its
  // v/max ratio in m.value). Full "used/total G" stays in the KV block, never here.
  const text = isNull ? '—' : Math.round(p) + '%';
  return `<div class="ring-wrap"><div class="ring" style="--p:${p};--c:${c}"><b>${esc(text)}</b></div><div class="ring-label">${esc(label)}</div></div>`;
}

// Key/value item; ratio metrics (have numeric value) get a status class.
export function kvItem(label, m) {
  const cls = lvClass(m.level);
  return `<div class="item"><span class="label">${esc(label)}</span><span class="value ${cls}">${esc(m.display)}</span></div>`;
}

// Card model consumed by mountCards (matches the .24 shell-persist contract).
export function card({ key, title, tag = '', body, accent = '', clickable = false, stale = false }) {
  return { key, title, tag, body, accent, clickable, stale };
}
