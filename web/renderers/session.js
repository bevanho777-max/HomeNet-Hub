// Admin session (frontend half) — three states, one source of truth.
//
// The states are: NOT CONFIGURED (the server has no ADMIN_PASSWORD, so nothing can be
// managed from here), LOGGED OUT, and LOGGED IN. Every admin control in the page is
// hidden unless the third one holds.
//
// Two rules this module keeps:
//   1. It is not a security boundary and does not pretend to be. Hiding "＋ 添加目标"
//      stops a confusing dead button, not an attacker — the server refuses the request
//      either way, which is where the actual gate lives.
//   2. The password is written to exactly one place, the request body, and the field is
//      cleared on every outcome. It is never re-displayed, never stored, and a failed
//      attempt leaves nothing in the DOM to read back.
import { esc } from './common.js';

const $ = (s) => document.querySelector(s);

let state = { authenticated: false, configured: false };
let onChange = () => {};
let busy = false;

export const isAuthed = () => state.authenticated;
export const isConfigured = () => state.configured;

const setStatus = (html, cls = '') => {
  const el = $('#loginStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

// The password field is cleared on every path out of a submit. A field the browser may
// also offer to save should not sit populated in the DOM for as long as the tab is open.
function clearPass() {
  const el = $('#loginPass');
  if (el) el.value = '';
}

/** Show/hide every admin control from the one piece of state. */
function apply() {
  const admin = !!state.authenticated;
  for (const id of ['#addOpen', '#credOpen', '#logoutBtn']) {
    const el = $(id);
    if (el) el.hidden = !admin;
  }
  // The login entry stays visible when the server has no password configured: an
  // invisible feature reads as a missing one, and opening it explains why it cannot be
  // used. Clicking it is always harmless.
  const li = $('#loginOpen');
  if (li) li.hidden = admin;
  document.body.classList.toggle('is-admin', admin);
}

/** Ask the server what we are. Never throws — a failed check leaves the last state. */
export async function refreshSession() {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      state = { authenticated: !!j.authenticated, configured: !!j.configured };
    }
  } catch { /* offline: keep what we had, the server still decides on every call */ }
  apply();
  return state;
}

/** Called when a data endpoint answers 401 — REQUIRE_LOGIN_TO_VIEW, or an expiry. */
export async function sessionLost() {
  if (state.authenticated) state = { ...state, authenticated: false };
  apply();
  return refreshSession();
}

async function submit() {
  if (busy) return;
  const pass = $('#loginPass').value;
  if (!pass) return setStatus('请输入管理密码。', 'bad');
  busy = true;
  $('#loginSubmit').disabled = true;
  setStatus('正在登录…', 'busy');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setStatus('已登录。', 'ok');
      await refreshSession();
      closeLoginPanel();
      await onChange();
    } else if (r.status === 429) {
      setStatus(`尝试过于频繁,请 ${Number(j.retry_after_s) || 60} 秒后再试。`, 'bad');
    } else if (j.error === 'admin not configured') {
      setStatus('服务端没有配置 ADMIN_PASSWORD,管理功能不可用。', 'bad');
    } else if (r.status === 403) {
      setStatus('请求被拒(跨站来源)。', 'bad');
    } else if (j.retry_after_s) {
      setStatus(`密码错误,已触发限速,${Number(j.retry_after_s)} 秒后可再试。`, 'bad');
    } else {
      setStatus('密码错误。', 'bad');
    }
  } catch (e) {
    setStatus(`登录请求失败:${esc(String(e?.message || e))}`, 'bad');
  } finally {
    clearPass();          // always — success, wrong password, or network failure
    busy = false;
    $('#loginSubmit').disabled = false;
  }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* clear locally anyway */ }
  // Drop the "已登录。" the modal is still holding: the next person to open it must not
  // be told they are logged in by a leftover line.
  setStatus('');
  await refreshSession();
  await onChange();
}

export function openLoginPanel() {
  $('#loginModal').classList.add('open');
  clearPass();
  if (!state.configured) {
    setStatus('服务端没有配置 ADMIN_PASSWORD —— 管理端点全部拒绝,登录也不会成功。', 'warn');
    $('#loginSubmit').disabled = true;
  } else {
    setStatus('登录后才能发现主机、添加目标与管理凭据。');
    $('#loginSubmit').disabled = false;
  }
  setTimeout(() => $('#loginPass')?.focus(), 0);
}

export function closeLoginPanel() {
  $('#loginModal')?.classList.remove('open');
  clearPass();
}

export function bindSession(opts = {}) {
  onChange = opts.onChange || (() => {});
  $('#loginOpen').onclick = openLoginPanel;
  $('#loginClose').onclick = closeLoginPanel;
  $('#loginModal').onclick = (e) => { if (e.target.id === 'loginModal') closeLoginPanel(); };
  $('#loginSubmit').onclick = submit;
  $('#loginPass').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#logoutBtn').onclick = logout;
  apply();
}
