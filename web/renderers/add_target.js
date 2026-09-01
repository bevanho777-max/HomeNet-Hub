// "Add target" panel (slice 3) — the first interactive surface in this frontend.
//
// Closes the discover → add → see loop against the endpoints slice 1/2b built. Two
// rules shape everything here:
//   1. This module NEVER constructs a `target.source`. It sends { host, capability,
//      name? } and nothing else. The server's capability catalog builds what gets
//      stored — that is the security boundary, and a helpful frontend that "just
//      filled in the url" would quietly punch through it.
//   2. Every failure is reported next to the thing that failed. Adding six
//      capabilities means six independent POSTs; one 409 must not cost the other five.
import { esc } from './common.js';

const $ = (s) => document.querySelector(s);

let onChanged = () => {};
let manifest = null;      // last successful /api/discover result
let busy = false;

// ── host pre-check ──────────────────────────────────────────────────
// UX only, and deliberately a copy of nothing: the server's net_guard remains the
// authority and is what actually refuses a probe. This exists so typing a public
// address gets an instant Chinese explanation instead of a round trip that returns
// English, and its verdict is never trusted for anything.
function hostHint(raw) {
  const s = (raw || '').trim();
  if (!s) return '请输入一个 IP 地址';
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return '只支持 IPv4 地址,例如 192.168.1.24';
  const o = m.slice(1, 5);
  if (o.some((x) => x.length > 1 && x[0] === '0')) return '八位组不能有前导零(0 开头会被当作八进制)';
  const n = o.map(Number);
  if (n.some((x) => x > 255)) return '每一段必须在 0-255 之间';
  const [a, b] = n;
  if (a === 169 && b === 254) return '链路本地地址(169.254.x.x)不允许探测';
  const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 127;
  if (!priv) return '只能探测私网地址:10.x / 172.16-31.x / 192.168.x';
  return null;
}

// Server errors come back in English from the validator; these are the ones a user can
// actually hit, mapped to something actionable. Anything unmapped is shown verbatim
// rather than swallowed — an unexplained failure is worse than an English one.
function zhReason(reason = '') {
  if (/private IPv4/.test(reason)) return '只能探测私网地址(10.x / 172.16-31.x / 192.168.x)';
  if (/link-local/.test(reason)) return '链路本地地址(169.254.x.x)不允许探测';
  if (/leading zero/.test(reason)) return '八位组不能有前导零';
  if (/not an IPv4 literal/.test(reason)) return '不是合法的 IPv4 地址';
  if (/not in the known port set/.test(reason)) return '该端口不在已知端口集内';
  if (/collector pending/.test(reason)) return '该能力的采集器尚未实现';
  if (/is TLS — use tls_cert/.test(reason)) return '这是 TLS 端口,请改用 TLS 证书能力';
  return reason;
}

const setStatus = (html, cls = '') => {
  const el = $('#addStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

// ── discovery ───────────────────────────────────────────────────────
async function discover() {
  const host = $('#addHost').value.trim();
  const hint = hostHint(host);
  if (hint) { manifest = null; renderManifest(); return setStatus(esc(hint), 'bad'); }
  if (busy) return;
  busy = true;
  $('#addDiscover').disabled = true;
  setStatus('正在探测 ' + esc(host) + ' …', 'busy');
  manifest = null;
  renderManifest();
  try {
    const r = await fetch(`/api/discover?host=${encodeURIComponent(host)}`, { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) return setStatus(`探测被拒绝:${esc(zhReason(j.reason || j.error || ''))}`, 'bad');
    manifest = j;
    const n = j.suggested_capabilities.filter((c) => c.available).length;
    setStatus(j.reachable
      ? `探测完成,用时 ${j.took_ms}ms,可添加 ${n} 项`
      : `${esc(j.host)} 没有响应(端口全关或主机离线),仍可添加可达性监控`, j.reachable ? 'ok' : 'warn');
    renderManifest();
  } catch (e) {
    setStatus(`探测失败:${esc(String(e?.message || e))}`, 'bad');
  } finally {
    busy = false;
    $('#addDiscover').disabled = false;
  }
}

// ── manifest rendering ──────────────────────────────────────────────
const WIDGET_GROUP = {
  service: '服务与端口',
  info: '证书与信息',
  machine: '机器指标',
};

function pendingWhy(cap) {
  if (cap.requires === 'ssh') return '需要 SSH 凭据';
  if (cap.requires === 'winrm') return '需要 WinRM 凭据';
  return '需要采集器(切片 2d)';
}

function renderManifest() {
  const box = $('#addManifest');
  const foot = $('#addFoot');
  if (!manifest) { box.innerHTML = ''; foot.hidden = true; return; }

  const m = manifest;
  const ports = m.open_ports.map((p) =>
    `<span class="addChip">${p.port}<i>${esc(p.port_hint)}</i></span>`).join('') || '<span class="addMuted">无</span>';

  const svc = m.services.map((s) => `<div class="addSvc">
      <b>:${s.port}</b>
      <span>${s.http_status ? `HTTP ${s.http_status}` : '—'}</span>
      <span class="addMuted">${esc(s.server || '')}</span>
      <span>${esc(s.title || '')}</span>
      ${s.tls_expiry_days != null ? `<span class="addMuted">证书 ${s.tls_expiry_days} 天</span>` : ''}
    </div>`).join('');

  // Group by widget so a long list reads as "ports / certificates / machine metrics"
  // rather than one flat column of 18 checkboxes.
  const groups = new Map();
  for (const c of m.suggested_capabilities) {
    const g = WIDGET_GROUP[c.widget] || c.widget;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const caps = [...groups].map(([g, list]) => `
    <div class="addGroup"><h4>${esc(g)}</h4>${list.map((c) => (c.available ? `
      <label class="addCap" data-cap="${esc(c.id)}">
        <input type="checkbox" class="addPick" value="${esc(c.id)}" />
        <span class="addCapLabel">${esc(c.label)}</span>
        <input type="text" class="addName" placeholder="自定义名称(可选)" maxlength="60" />
        <span class="addResult"></span>
      </label>` : `
      <div class="addCap off">
        <input type="checkbox" disabled />
        <span class="addCapLabel">${esc(c.label)}</span>
        <span class="addPending">${esc(pendingWhy(c))}</span>
      </div>`)).join('')}</div>`).join('');

  box.innerHTML = `
    <div class="addSum">
      <span class="addDot ${m.reachable ? 'ok' : 'bad'}"></span>
      <b>${esc(m.host)}</b>
      <span>${m.reachable ? '可达' : '无响应'}</span>
      ${m.latency_ms != null ? `<span class="addMuted">${m.latency_ms}ms</span>` : ''}
      <span class="addMuted">·</span>
      <span>${esc(m.os_hint)}</span>
      <span class="addMuted">(${esc(m.os_hint_reason)})</span>
    </div>
    <div class="addRow"><span class="addMuted">开放端口</span><div class="addChips">${ports}</div></div>
    ${svc ? `<div class="addRow"><span class="addMuted">服务</span><div class="addSvcs">${svc}</div></div>` : ''}
    <div class="addCaps">${caps}</div>`;

  foot.hidden = false;
  box.querySelectorAll('.addPick').forEach((el) => {
    el.onchange = () => {
      // The name field only appears once a row is picked. Eleven identical
      // "custom name (optional)" inputs sitting there permanently read as required
      // fields and bury the labels they belong to.
      el.closest('.addCap').classList.toggle('picked', el.checked);
      updateCount();
    };
  });
  updateCount();
}

function updateCount() {
  const n = document.querySelectorAll('.addPick:checked').length;
  const btn = $('#addSelected');
  btn.disabled = n === 0 || busy;
  btn.textContent = n ? `添加所选 (${n})` : '添加所选';
}

// ── adding ──────────────────────────────────────────────────────────
// One POST per capability, sequential: a handful of adds is not worth a burst, and
// serialising means each row's result lands next to it as it happens.
async function addSelected() {
  if (busy) return;
  const picks = [...document.querySelectorAll('.addPick:checked')];
  if (!picks.length) return;
  busy = true;
  updateCount();
  let added = 0;
  for (const pick of picks) {
    const row = pick.closest('.addCap');
    const out = row.querySelector('.addResult');
    const name = row.querySelector('.addName')?.value.trim() || undefined;
    out.className = 'addResult busy';
    out.textContent = '添加中…';
    try {
      const r = await fetch('/api/user_targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // host + capability id only. No source, ever.
        body: JSON.stringify({ host: manifest.host, capability: pick.value, ...(name ? { name } : {}) }),
      });
      const j = await r.json();
      if (r.ok) {
        out.className = 'addResult ok'; out.textContent = '已添加';
        pick.checked = false; pick.disabled = true; row.classList.add('done');
        added++;
      } else if (r.status === 409) {
        out.className = 'addResult warn'; out.textContent = '已存在';
        pick.checked = false; pick.disabled = true;
      } else {
        out.className = 'addResult bad';
        out.textContent = zhReason(j.reason || (j.errors || []).join('; ') || j.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      out.className = 'addResult bad';
      out.textContent = `请求失败:${String(e?.message || e)}`;
    }
  }
  busy = false;
  updateCount();
  if (added) {
    setStatus(`已添加 ${added} 项,看板已刷新`, 'ok');
    await refreshList();
    await onChanged();
  }
}

// ── added list ──────────────────────────────────────────────────────
async function refreshList() {
  const box = $('#addList');
  try {
    const r = await fetch('/api/user_targets', { cache: 'no-store' });
    const j = await r.json();
    const rows = j.targets || [];
    box.innerHTML = rows.length ? rows.map((t) => `
      <div class="addItem" data-id="${esc(t.id)}">
        <span class="addDot ${t.enabled ? 'ok' : ''}"></span>
        <b>${esc(t.name)}</b>
        <span class="addMuted">${esc(t.host || '')}</span>
        <span class="addChip">${esc(t.capability || '手动')}</span>
        <button type="button" class="addDel">删除</button>
      </div>`).join('') : '<div class="addMuted">还没有通过发现添加的目标。</div>';
    box.querySelectorAll('.addDel').forEach((btn) => {
      btn.onclick = () => removeOne(btn.closest('.addItem'));
    });
  } catch {
    box.innerHTML = '<div class="addStatus bad">已添加列表加载失败</div>';
  }
}

async function removeOne(row) {
  const id = row?.dataset.id;
  if (!id) return;
  // Deleting takes a card off the panel; a mis-click should not be silent.
  if (!window.confirm(`删除 "${id}" ?\n它的卡片和历史采样将停止。`)) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = '删除中…';
  try {
    const r = await fetch(`/api/user_targets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(zhReason(j.reason || j.error || `HTTP ${r.status}`));
    // A deleted target frees its id, so anything in the manifest that was greyed out
    // as "already added" can be picked again — re-render rather than leave it stale.
    await refreshList();
    await onChanged();
    setStatus(`已删除 ${esc(id)}`, 'ok');
  } catch (e) {
    btn.disabled = false; btn.textContent = '删除';
    setStatus(`删除失败:${esc(String(e?.message || e))}`, 'bad');
  }
}

// ── wiring ──────────────────────────────────────────────────────────
export function openAddPanel() {
  $('#addModal').classList.add('open');
  // Reopening starts clean. A manifest from ten minutes ago describes a host that may
  // have changed, and its rows still carry the "已添加 / disabled" state from that
  // session — stale enough to mislead, so it is discarded rather than shown again.
  manifest = null;
  renderManifest();
  setStatus('输入一个私网 IP,点"发现"看看那台机器上有什么。');
  refreshList();
  setTimeout(() => $('#addHost')?.focus(), 0);
}

export function closeAddPanel() { $('#addModal')?.classList.remove('open'); }

export function bindAddTarget(opts = {}) {
  onChanged = opts.onChanged || (() => {});
  $('#addOpen').onclick = openAddPanel;
  $('#addClose').onclick = closeAddPanel;
  $('#addModal').onclick = (e) => { if (e.target.id === 'addModal') closeAddPanel(); };
  $('#addDiscover').onclick = discover;
  $('#addHost').onkeydown = (e) => { if (e.key === 'Enter') discover(); };
  $('#addSelected').onclick = addSelected;
}
