// Credentials panel (slice 2e) — a write-only door in the UI, matching the API.
//
// The secret field is <input type="password">, it is never populated from a response,
// and nothing that comes back from the server contains one. Once stored, a credential
// can be listed and deleted; it can never be read back. That is deliberate, and the
// panel says so, because a form that silently cannot show you what you typed reads as
// broken unless it tells you it is by design.
import { esc } from './common.js';

const $ = (s) => document.querySelector(s);
let onChanged = () => {};
let busy = false;

const TYPE_LABEL = {
  ssh_password: 'SSH 密码',
  ssh_key: 'SSH 私钥',
  winrm_password: 'WinRM 密码',
};

const setStatus = (html, cls = '') => {
  const el = $('#credStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

// Clearing the secret field is not security theatre — the DOM value would otherwise sit
// in the page for as long as the tab is open, in a field the browser may also offer to
// save. It is wiped after every submit, success or failure.
function clearSecret() {
  const el = $('#credSecret');
  if (el) el.value = '';
}

async function refresh() {
  const box = $('#credList');
  try {
    const r = await fetch('/api/credentials', { cache: 'no-store' });
    const j = await r.json();
    const locked = !j.vault?.configured;
    $('#credForm').hidden = locked;
    $('#credLocked').hidden = !locked;
    if (locked) {
      $('#credLockedWhy').textContent = j.vault?.reason || '未配置';
      box.innerHTML = '';
      return;
    }
    const rows = j.credentials || [];
    box.innerHTML = rows.length ? rows.map((c) => `
      <div class="addItem" data-id="${esc(c.id)}">
        <span class="addDot ok"></span>
        <b>${esc(c.name)}</b>
        <span class="addMuted">${esc(c.username)}</span>
        <span class="addChip">${esc(TYPE_LABEL[c.type] || c.type)}</span>
        <button type="button" class="addDel">删除</button>
      </div>`).join('') : '<div class="addMuted">还没有存过凭据。</div>';
    box.querySelectorAll('.addDel').forEach((b) => { b.onclick = () => removeOne(b.closest('.addItem')); });
  } catch {
    box.innerHTML = '<div class="addStatus bad">凭据列表加载失败</div>';
  }
}

async function submit() {
  if (busy) return;
  const name = $('#credName').value.trim();
  const type = $('#credType').value;
  const username = $('#credUser').value.trim();
  const secret = $('#credSecret').value;
  if (!name || !username || !secret) return setStatus('名称、用户名、密钥都要填。', 'bad');
  busy = true;
  $('#credSave').disabled = true;
  setStatus('正在加密并保存…', 'busy');
  try {
    const r = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type, username, secret }),
    });
    const j = await r.json();
    if (r.status === 503) setStatus(`金库未配置:${esc(j.reason || '')}`, 'bad');
    else if (r.status === 409) setStatus(`已存在同名凭据「${esc(name)}」`, 'warn');
    else if (!r.ok) setStatus(`保存失败:${esc(j.reason || j.error || `HTTP ${r.status}`)}`, 'bad');
    else {
      setStatus(`已加密保存「${esc(j.name)}」—— 密钥本身此后无法再读出。`, 'ok');
      $('#credName').value = ''; $('#credUser').value = '';
      await refresh();
      await onChanged();
    }
  } catch (e) {
    setStatus(`请求失败:${esc(String(e?.message || e))}`, 'bad');
  } finally {
    clearSecret();          // always, including on failure
    busy = false;
    $('#credSave').disabled = false;
  }
}

async function removeOne(row) {
  const id = row?.dataset.id;
  if (!id) return;
  const name = row.querySelector('b')?.textContent || id;
  if (!window.confirm(`删除凭据「${name}」?\n它无法恢复,引用它的目标会失效。`)) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = '删除中…';
  try {
    const r = await fetch(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (r.status === 409) {
      btn.disabled = false; btn.textContent = '删除';
      return setStatus(`「${esc(name)}」正在被这些目标使用:${esc((j.used_by || []).join('、'))}`, 'warn');
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setStatus(`已删除「${esc(name)}」`, 'ok');
    await refresh();
    await onChanged();
  } catch (e) {
    btn.disabled = false; btn.textContent = '删除';
    setStatus(`删除失败:${esc(String(e?.message || e))}`, 'bad');
  }
}

export function openCredPanel() {
  $('#credModal').classList.add('open');
  clearSecret();
  setStatus('密钥加密后存入本机数据库,存进去就再也读不出来 —— 只能改名重存或删除。');
  refresh();
  setTimeout(() => $('#credName')?.focus(), 0);
}

export function closeCredPanel() { $('#credModal')?.classList.remove('open'); }

export function bindCredentials(opts = {}) {
  onChanged = opts.onChanged || (() => {});
  $('#credOpen').onclick = openCredPanel;
  $('#credClose').onclick = closeCredPanel;
  $('#credModal').onclick = (e) => { if (e.target.id === 'credModal') closeCredPanel(); };
  $('#credSave').onclick = submit;
  $('#credSecret').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}
