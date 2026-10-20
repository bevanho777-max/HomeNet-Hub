// service renderer (§6) — no rings; KV list + header_right status/badge.
import { card, mget, lvClass, esc, statusLevel } from './common.js';
import { cv, t } from '../i18n.js';

// v2.19 measurement age. A metric the hub tracks for freshness carries `at` (unix
// seconds of the measurement, null = none inside the query's lookback) and, once older
// than the target's max_age, `expired` with a "—" display. The card says when the
// number was taken, so an old value can never pass for a current one.
function fmtWhen(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const p2 = (n) => ('0' + n).slice(-2);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}

function measuredNote(target, snap, keys) {
  const ms = keys.map((k) => snap?.metrics?.[k]).filter((m) => m && 'at' in m);
  if (!ms.length) return '';
  const ats = ms.map((m) => m.at).filter((a) => typeof a === 'number');
  const last = ats.length ? Math.max(...ats) : null;
  const expired = ms.every((m) => m.expired);
  const text = last == null ? t('measured_none', target.freshness?.lookback)
    : expired ? t('measured_last', fmtWhen(last)) : t('measured_at', fmtWhen(last));
  return `<div class="note measured${expired ? ' is-expired' : ''}">${esc(text)}</div>`;
}

export function renderService(gridCard, target, snap, metrics) {
  const title = target.name || target.id;
  const accent = target.color || '';

  if (!snap || snap.online === false) {
    // v2.19 `when_down`: expected absence, shown neutral (see stack.js).
    if (target.when_down) {
      return card({
        key: target.id, title, tag: '', accent, stale: true,
        body: `<div class="note">${esc(cv(target.when_down, 'note') || t('svc_idle'))}</div>`,
      });
    }
    return card({
      key: target.id, title, tag: 'offline', accent, stale: true,
      body: `<div class="note">Unavailable${snap?.error ? ` (${esc(snap.error)})` : ''}</div>`,
    });
  }

  const label = (k) => cv(metrics?.[k], 'label') || k;

  // header_right: "status" → colored status value, "badge" → target.badge, else metric
  let tag = '';
  if (gridCard.header_right === 'status') {
    const m = mget(snap, 'status');
    const lvl = statusLevel(m.value);
    tag = `<span class="${lvClass(lvl)}">${esc(m.display)}</span>`;
  } else if (gridCard.header_right === 'badge') {
    tag = esc(target.badge || '');
  } else if (gridCard.header_right) {
    tag = esc(mget(snap, gridCard.header_right).display || '');
  }

  const itemKeys = gridCard.items || [];
  const items = itemKeys.map((k) => {
    const m = mget(snap, k);
    // v2.23: one type scale in every cell (the 12px model/role override is gone); a long
    // model name wraps inside its cell instead.
    const cls = k === 'status' ? lvClass(statusLevel(m.value)) : lvClass(m.level);
    return `<div class="item"><span class="label">${esc(label(k))}</span><span class="value ${cls}">${esc(m.display)}</span></div>`;
  }).join('');

  // no items configured → show a note instead of a silent empty card body
  const body = itemKeys.length
    ? `<div class="kv" data-n="${itemKeys.length}">${items}</div>${measuredNote(target, snap, itemKeys)}`
    : '<div class="note">No fields configured</div>';
  return card({ key: target.id, title, tag, body, accent, stale: snap.stale });
}
