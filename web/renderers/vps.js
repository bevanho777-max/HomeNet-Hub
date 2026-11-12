// v2.48 VPS card (layout type: vps) -- a KiwiVM (BandwagonHost) VPS from its provider's API
// (server/collectors/kiwivm.js, snap.extra.vps). One fixed-size card:
//   header      title · status (运行中 / 已停止 / 已暂停, or API 错误 in yellow) · data time
//   transfer    本月流量  used / total  percent, and a bar (80% yellow, 95% red: metrics.yaml vps_traffic)
//   four cells  下次重置 (date + days left) · 月底推算 (red above the total; daily average beside it) ·
//               内存 · 磁盘 (percent + used / total beside it)
//   spark       the last 30 Beijing days' transfer (getRawUsageStats, same multiplier), growing into the
//               height the row gives the card -- so a taller row never leaves a blank strip
// Every line is .fit (fit.js: smaller, then the short forms) and nothing wraps; the cells are the
// standard 108-150px .kv cells. All times are Beijing time, like every day on the board.
import { card, esc, cellHtml, lvClass } from './common.js';
import { t } from '../i18n.js';
import { sig3 } from '../fmt.js';

const GB = 2 ** 30;
const DAY = 86400;
// the bar's colours when no vps_traffic metric (with its thresholds) is mapped
const DEFAULT_TH = { warn: 80, danger: 95 };

// KiwiVM's units: 1 GB = 2^30 bytes, 1 TB = 1000 GB (a "3 TB" plan is 3000 x 2^30 bytes)
function bytesParts(b) {
  if (b == null || !Number.isFinite(b)) return null;
  if (b < 2 ** 20) return [sig3(b / 1024), 'KB'];
  if (b < GB) return [sig3(b / 2 ** 20), 'MB'];
  if (b < 1000 * GB * 0.9995) return [sig3(b / GB), 'GB'];
  return [sig3(b / (1000 * GB)), 'TB'];
}
export const fmtBytes = (b) => { const p = bytesParts(b); return p ? `${p[0]} ${p[1]}` : '—'; };
const fmtBytesShort = (b) => { const p = bytesParts(b); return p ? `${p[0]}${p[1][0]}` : '—'; };
const gb = (b) => (b == null ? '—' : sig3(b / GB));

export function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  if (p < 1) return `${p.toFixed(2)}%`;
  if (p < 100) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

const p2 = (x) => String(x).padStart(2, '0');
const bj = (sec) => { const d = new Date((sec + 8 * 3600) * 1000); return { y: d.getUTCFullYear(), mo: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()), h: p2(d.getUTCHours()), mi: p2(d.getUTCMinutes()) }; };
const bjDate = (sec) => { const x = bj(sec); return `${x.mo}-${x.d}`; };
const bjFull = (sec) => { const x = bj(sec); return `${x.y}-${x.mo}-${x.d} ${x.h}:${x.mi}`; };
/** "01:55" today, "11-12 23:55" before (Beijing) */
const bjWhen = (ms) => {
  if (!ms) return '—';
  const s = ms / 1000, x = bj(s);
  return bjDate(s) === bjDate(Date.now() / 1000) ? `${x.h}:${x.mi}` : `${x.mo}-${x.d} ${x.h}:${x.mi}`;
};

function daysLeft(sec) {
  if (sec <= 0) return { text: t('vps_hours', 0), forms: [] };
  const d = sec / DAY;
  if (d >= 10) return { text: t('vps_days', Math.round(d)) };
  if (d >= 1) return { text: t('vps_days', d.toFixed(1)) };
  return { text: t('vps_hours', Math.max(1, Math.round(sec / 3600))) };
}

function levelOf(snap, key, value) {
  const m = snap?.metrics?.[key];
  if (m && 'level' in m && m.value != null) return m.level;
  if (value == null) return null;
  return value >= DEFAULT_TH.danger ? 'danger' : value >= DEFAULT_TH.warn ? 'warn' : 'ok';
}

// "5m" -> 5 分钟 / 5 min (the target's interval as written in targets.yaml)
const durText = (s) => {
  const m = String(s || '').trim().match(/^([\d.]+)\s*(s|m|h|d)?$/);
  return m ? t(`vps_dur_${m[2] || 's'}`, m[1]) : String(s || '');
};

function statusWord(v) {
  if (v.status === 'suspended') return { text: t('vps_st_suspended'), cls: 'lv-danger' };
  if (v.status === 'running') return { text: t('vps_st_running'), cls: 'lv-ok' };
  if (v.status === 'stopped') return { text: t('vps_st_stopped'), cls: 'lv-danger' };
  return { text: v.status || '—', cls: '' };
}

function headerTag(v) {
  const st = statusWord(v);
  const when = bjWhen(v.data_at);
  const lines = [t('vps_t_status', st.text), t('vps_t_data', bjFull(v.data_at / 1000), durText(v.api?.every || '5m'))];
  if (v.raw_at) lines.push(t('vps_t_raw', bjWhen(v.raw_at), durText(v.api?.usage_every || '1h')));
  if (v.api?.raw_err) lines.push(t('vps_t_raw_err', v.api.raw_err));
  if (!v.api?.ok) {
    lines.push(t('vps_t_err', v.api.err || '?', v.api.fails || 0));
    if (v.api.next_at) lines.push(t('vps_t_next', bjWhen(v.api.next_at)));
  }
  if (v.cpu_throttled) lines.push(t('vps_t_cpu_throttled'));
  if (v.disk_throttled) lines.push(t('vps_t_disk_throttled'));
  if (v.policy_violation) lines.push(t('vps_t_policy'));
  if (v.load) lines.push(t('vps_t_load', v.load));
  if (v.plan || v.datacenter) lines.push([v.plan, v.datacenter].filter(Boolean).join(' · '));
  const word = v.api?.ok === false ? { text: t('vps_api_err'), cls: 'lv-warn' } : st;
  const tag = `<span title="${esc(lines.join('\n'))}"><span class="${word.cls}">${esc(word.text)}</span> · ${esc(when)}</span>`;
  return { tag, short: word.text };
}

function sparkHtml(v) {
  const days = Array.isArray(v.days) ? v.days : [];
  const tot = (x) => (x.in == null ? null : x.in + x.out);
  const max = Math.max(0, ...days.map((x) => tot(x) || 0));
  const cols = days.map((x) => {
    const total = tot(x);
    const title = total == null ? t('vps_day_none', x.d.slice(5)) : t('vps_day', x.d.slice(5), fmtBytes(total), fmtBytes(x.in), fmtBytes(x.out));
    const f = total == null || max <= 0 ? null : (total / max).toFixed(3);
    // (a day with no samples gets a faint stub, so the 30 slots read as a chart even before there is data)
    return `<div class="c${x.d === v.today ? ' today' : ''}${f == null ? ' none' : ''}" title="${esc(title)}"><i${f == null ? '' : ` style="--f:${f}"`}></i></div>`;
  }).join('');
  const first = days[0]?.d?.slice(5) || '', last = days[days.length - 1]?.d?.slice(5) || '';
  const mid = max > 0 ? t('vps_spark', fmtBytes(max)) : t('vps_spark_none');
  const midShort = max > 0 ? t('vps_spark_short', fmtBytesShort(max)) : t('vps_spark_none_short');
  return `<div class="vps-spark">${cols}</div>`
    + `<div class="vps-axis"><span class="fit">${esc(first)}</span><span class="fit mid" data-short="${esc(midShort)}">${esc(mid)}</span><span class="fit">${esc(last)}</span></div>`;
}

export function renderVps(gridCard, target, snap, metrics = {}) {
  const title = target.name || target.id;
  const accent = target.color || '';
  const v = snap?.extra?.vps;
  if (!v || !v.has_data) {
    const err = snap?.error || v?.api?.err || '';
    return card({
      key: target.id, title, accent, kind: 'vps', stale: true,
      tag: `<span class="lv-warn">${esc(err ? t('vps_api_err') : t('vps_no_data'))}</span>`,
      body: `<div class="note">${esc(t('vps_no_data'))}${err ? ` (${esc(err)})` : ''}</div>`,
    });
  }
  const now = Date.now() / 1000;
  const { tag, short } = headerTag(v);

  // transfer: used / total, percent, bar
  const lv = levelOf(snap, 'vps_traffic', v.pct);
  const th = { ...DEFAULT_TH, ...(metrics?.vps_traffic?.thresholds || {}) };
  const useTitle = t('vps_title_use', fmtBytes(v.used), fmtBytes(v.total), fmtPct(v.pct), v.mult, th.warn, th.danger);
  const amt = `${fmtBytes(v.used)} / ${fmtBytes(v.total)}`;
  const amtShort = `${fmtBytesShort(v.used)}/${fmtBytesShort(v.total)}`;
  const w = v.pct == null ? 0 : Math.max(0, Math.min(100, v.pct));
  const use = `<div class="vps-use" title="${esc(useTitle)}"><span class="vps-lbl fit">${esc(t('vps_traffic'))}</span>`
    + `<span class="vps-amt fit" data-min="13" data-short="${esc(amtShort)}">${esc(amt)}</span><span class="vps-pct fit ${lvClass(lv)}" data-min="13">${esc(fmtPct(v.pct))}</span></div>`
    + `<div class="vps-bar ${lvClass(lv)}" title="${esc(useTitle)}"><i style="width:${w.toFixed(2)}%"></i></div>`;

  // the four cells
  const cells = [];
  if (v.reset) {
    const left = daysLeft(v.reset - now);
    cells.push(cellHtml({ label: t('vps_reset'), labelShort: t('vps_reset_short'), value: bjDate(v.reset),
      last: { text: t('vps_left', left.text), forms: [left.text] }, title: t('vps_title_reset', bjFull(v.reset), left.text) }));
  } else cells.push(cellHtml({ label: t('vps_reset'), labelShort: t('vps_reset_short'), value: '—' }));
  const elapsedDays = v.cycle_start ? (now - v.cycle_start) / DAY : null;
  if (v.projected != null) {
    const over = v.total > 0 && v.projected > v.total;
    const pd = fmtBytes(v.per_day), pds = fmtBytesShort(v.per_day);
    cells.push(cellHtml({ label: t('vps_projected'), labelShort: t('vps_projected_short'), value: fmtBytes(v.projected), short: fmtBytesShort(v.projected),
      cls: over ? 'lv-danger' : '', itemCls: over ? 'lv-danger' : '',
      last: { text: t('vps_per_day', pd), forms: [t('vps_per_day_short', pds), pds] },
      title: t('vps_title_proj', fmtBytes(v.projected), pd, fmtBytes(v.used), elapsedDays.toFixed(1), bjFull(v.cycle_start), bjFull(v.reset), v.cycle_exact, v.mult, fmtBytes(v.total)) }));
  } else {
    cells.push(cellHtml({ label: t('vps_projected'), labelShort: t('vps_projected_short'), value: '—',
      last: { text: t('vps_too_early'), forms: [t('vps_too_early_short')] },
      title: t('vps_title_proj_early', elapsedDays == null ? '—' : Math.max(0, elapsedDays).toFixed(1)) }));
  }
  const memLv = levelOf(snap, 'vps_mem', v.mem?.pct);
  const memUsed = v.mem?.avail != null && v.mem?.total != null ? v.mem.total - v.mem.avail : null;
  cells.push(cellHtml({ label: t('vps_mem'), value: v.mem?.pct == null ? '—' : `${Math.round(v.mem.pct)}%`, cls: lvClass(memLv),
    itemCls: memLv === 'warn' || memLv === 'danger' ? lvClass(memLv) : '',
    last: memUsed == null ? null : { text: `${gb(memUsed)}/${gb(v.mem.total)}G`, forms: [`${gb(memUsed)}G`] },
    title: memUsed == null ? '' : t('vps_title_mem', fmtBytes(memUsed), fmtBytes(v.mem.total), fmtBytes(v.mem.avail)) }));
  const diskLv = levelOf(snap, 'vps_disk', v.disk?.pct);
  cells.push(cellHtml({ label: t('vps_disk'), value: v.disk?.pct == null ? '—' : `${Math.round(v.disk.pct)}%`, cls: lvClass(diskLv),
    itemCls: diskLv === 'warn' || diskLv === 'danger' ? lvClass(diskLv) : '',
    last: v.disk?.used == null ? null : { text: `${gb(v.disk.used)}/${gb(v.disk.total)}G`, forms: [`${gb(v.disk.used)}G`] },
    title: v.disk?.used == null ? '' : t('vps_title_disk', fmtBytes(v.disk.used), fmtBytes(v.disk.total)) }));

  const body = `<div class="vps">${use}<div class="kv vps-kv" data-n="4">${cells.join('')}</div>${sparkHtml(v)}</div>`;
  return card({ key: target.id, title, tag, tagShort: short, body, accent, kind: 'vps' });
}

