// Clients panel — one LiteLLM virtual key per client, named, with the usage that key
// produced next to it.
//
// THE PLAINTEXT KEY IS SHOWN EXACTLY ONCE. LiteLLM hands it back from /key/generate and
// then keeps only a digest, so nothing — not this panel, not the server, not the proxy —
// can produce it again. The reveal box therefore says so, stays open until the operator
// dismisses it, and is cleared on every other path. It is never written to storage and
// never re-fetched, because there is nothing to re-fetch.
//
// Like the credentials panel, hiding controls here is UX, not a security boundary: the
// server refuses an unauthenticated request either way.
import { esc } from './common.js';

const $ = (s) => document.querySelector(s);
let onChanged = () => {};
let busy = false;

const setStatus = (html, cls = '') => {
  const el = $('#cliStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

// Same compact scale the token cards use, so a number means the same thing wherever it
// appears on this board.
function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function hideNewKey() {
  const box = $('#cliNew');
  if (!box) return;
  box.hidden = true;
  const el = $('#cliNewKey');
  if (el) el.textContent = '';       // do not leave it sitting in the DOM
}

function showNewKey(key) {
  const box = $('#cliNew');
  const el = $('#cliNewKey');
  if (!box || !el) return;
  el.textContent = key;
  box.hidden = false;
}

async function refresh() {
  const box = $('#cliList');
  const foot = $('#cliFoot');
  try {
    const r = await fetch('/api/clients', { cache: 'no-store' });
    const j = await r.json();
    const off = !j.litellm?.configured;
    $('#cliForm').hidden = off;
    $('#cliOff').hidden = !off;
    if (off) {
      $('#cliOffWhy').textContent = j.litellm?.reason || '未配置';
      box.innerHTML = '';
      foot.textContent = '';
      return;
    }
    if (j.error) setStatus(`litellm 的 key 接口没响应:${esc(j.error)}`, 'warn');
    const rows = j.clients || [];
    box.innerHTML = rows.length ? rows.map((c) => {
      const u = c.usage || {};
      // A system row (the proxy master key) has no key row to delete, and a revoked one
      // is already gone — both keep their usage on screen but lose the button.
      const del = (c.system || c.revoked)
        ? `<span class="addChip">${c.system ? '网关自己的 key' : '已撤销'}</span>`
        : '<button type="button" class="addDel">删除</button>';
      return `
      <div class="addItem" data-id="${esc(c.id)}">
        <span class="addDot ${c.revoked ? '' : 'ok'}"></span>
        <b>${esc(c.name)}</b>
        <span class="addMuted">${esc(compact(u.tokens_total))} tok · 净 ${esc(compact(u.net_total))} · ${esc(u.requests_total ?? 0)} 次</span>
        ${u.requests_today ? `<span class="addChip">今日 ${esc(u.requests_today)} 次</span>` : ''}
        ${del}
      </div>`;
    }).join('') : '<div class="addMuted">还没有客户端 key。</div>';
    box.querySelectorAll('.addDel').forEach((b) => { b.onclick = () => removeOne(b.closest('.addItem')); });
    // Rejected-auth traffic, counted but deliberately not named: that column of the
    // spend table holds whatever a caller sent as its key, including things people
    // pasted by mistake, so the server never echoes an unrecognised value.
    const un = j.unattributed;
    foot.textContent = un
      ? `另有 ${un.keys} 个无法归属的 key 值(鉴权失败/扫描噪声),共 ${un.requests} 次请求 —— 出于安全不显示内容。`
      : '';
  } catch {
    box.innerHTML = '<div class="addStatus bad">客户端列表加载失败</div>';
  }
}

async function create() {
  if (busy) return;
  const name = $('#cliName').value.trim();
  if (!name) return setStatus('给这个客户端起个名字,比如 openclaw。', 'bad');
  busy = true;
  $('#cliCreate').disabled = true;
  hideNewKey();
  setStatus('正在向 litellm 申请…', 'busy');
  try {
    const r = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    if (r.status === 503) setStatus(`litellm key 接口未配置:${esc(j.reason || '')}`, 'bad');
    else if (r.status === 409) setStatus(`已经有叫「${esc(name)}」的客户端了。`, 'warn');
    else if (!r.ok) setStatus(`创建失败:${esc(j.reason || j.error || `HTTP ${r.status}`)}`, 'bad');
    else {
      setStatus(`已创建「${esc(j.name)}」—— 把下面这把 key 配到客户端里。`, 'ok');
      showNewKey(j.key);
      $('#cliName').value = '';
      await refresh();
      await onChanged();
    }
  } catch (e) {
    setStatus(`请求失败:${esc(String(e?.message || e))}`, 'bad');
  } finally {
    busy = false;
    $('#cliCreate').disabled = false;
  }
}

async function removeOne(row) {
  const id = row?.dataset.id;
  if (!id) return;
  const name = row.querySelector('b')?.textContent || id;
  if (!window.confirm(`撤销客户端「${name}」的 key?\n用它的客户端会立刻 401,历史用量仍会留在卡上。`)) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = '撤销中…';
  try {
    const r = await fetch(`/api/clients/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.reason || j.error || `HTTP ${r.status}`);
    setStatus(`已撤销「${esc(name)}」`, 'ok');
    await refresh();
    await onChanged();
  } catch (e) {
    btn.disabled = false; btn.textContent = '删除';
    setStatus(`撤销失败:${esc(String(e?.message || e))}`, 'bad');
  }
}

async function copyKey() {
  const text = $('#cliNewKey')?.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('已复制到剪贴板。', 'ok');
  } catch {
    // Clipboard access needs a secure context; a LAN panel on plain http has none.
    // Selecting the text is the fallback, and saying so beats a button that does nothing.
    const el = $('#cliNewKey');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    setStatus('浏览器不允许自动复制(需要 https),已帮你选中,按 Ctrl+C。', 'warn');
  }
}

export function openClientsPanel() {
  $('#cliModal').classList.add('open');
  hideNewKey();
  setStatus('每个客户端一把 key。卡上的用量按这里的名字归属,撤销后历史用量仍然保留。');
  refresh();
  setTimeout(() => $('#cliName')?.focus(), 0);
}

export function closeClientsPanel() {
  $('#cliModal')?.classList.remove('open');
  hideNewKey();
}

export function bindClients(opts = {}) {
  onChanged = opts.onChanged || (() => {});
  $('#cliOpen').onclick = openClientsPanel;
  $('#cliClose').onclick = closeClientsPanel;
  $('#cliModal').onclick = (e) => { if (e.target.id === 'cliModal') closeClientsPanel(); };
  $('#cliCreate').onclick = create;
  $('#cliCopy').onclick = copyKey;
  $('#cliName').onkeydown = (e) => { if (e.key === 'Enter') create(); };
}
