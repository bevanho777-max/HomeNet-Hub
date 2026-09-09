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
import { t } from '../i18n.js';

const $ = (s) => document.querySelector(s);

let state = { authenticated: false, configured: false, setupAvailable: false };
let onChange = () => {};
let busy = false;

export const isAuthed = () => state.authenticated;
export const isConfigured = () => state.configured;
export const isSetupAvailable = () => state.setupAvailable;

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
  for (const id of ['#addOpen', '#credOpen', '#cliOpen', '#passwdOpen', '#logoutBtn']) {
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
      state = {
        authenticated: !!j.authenticated,
        configured: !!j.configured,
        // Only ever true on an install with no admin at all, asked from the LAN. The
        // server decides this; the frontend never infers it from `configured` alone,
        // because a public caller on that same install must not be shown the wizard.
        setupAvailable: !!j.setup_available,
      };
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
  if (!pass) return setStatus(t('login_need_pass'), 'bad');
  busy = true;
  $('#loginSubmit').disabled = true;
  setStatus(t('login_busy'), 'busy');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setStatus(t('login_done'), 'ok');
      await refreshSession();
      closeLoginPanel();
      await onChange();
    } else if (r.status === 429) {
      setStatus(t('too_many', Number(j.retry_after_s) || 60), 'bad');
    } else if (j.error === 'admin not configured') {
      setStatus(t('login_not_configured'), 'bad');
    } else if (r.status === 403) {
      setStatus(t('cross_site'), 'bad');
    } else if (j.retry_after_s) {
      setStatus(t('login_wrong_limited', Number(j.retry_after_s)), 'bad');
    } else {
      setStatus(t('login_wrong'), 'bad');
    }
  } catch (e) {
    setStatus(t('login_failed', esc(String(e?.message || e))), 'bad');
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
  // Close the password panel too: leaving it open after a logout means a form whose
  // every action is now a 401, with the previous outcome still on screen.
  closePasswdPanel();
  await refreshSession();
  await onChange();
}

// ── change password ────────────────────────────────────────────────
// The same rule as the login field, three times over: every path out of a submit clears
// all three boxes. A failed attempt must leave nothing in the DOM to read back, and the
// two that matter here are the CURRENT password (which is the secret being guessed at)
// and the new one (which is about to become it).
const setPwStatus = (html, cls = '') => {
  const el = $('#passwdStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

function clearPasswdFields() {
  for (const id of ['#passwdCurrent', '#passwdNew', '#passwdConfirm']) {
    const el = $(id);
    if (el) el.value = '';
  }
}

async function submitPasswd() {
  if (busy) return;
  const current = $('#passwdCurrent').value;
  const next = $('#passwdNew').value;
  const confirm = $('#passwdConfirm').value;

  // Checked here only to save a round trip; the server enforces every one of these
  // again and is the only place that decides.
  if (!current) return setPwStatus(t('passwd_need_current'), 'bad');
  if (!next) return setPwStatus(t('passwd_need_new'), 'bad');
  if (next !== confirm) {
    // Not a server error, so nothing is sent — but the boxes still get cleared, because
    // a mistyped password sitting in the DOM is the same exposure as a submitted one.
    clearPasswdFields();
    return setPwStatus(t('passwd_mismatch'), 'bad');
  }

  busy = true;
  $('#passwdSubmit').disabled = true;
  setPwStatus(t('passwd_busy'), 'busy');
  try {
    const r = await fetch('/api/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setPwStatus(t('passwd_done'), 'ok');
      await refreshSession();
      await onChange();
    } else if (r.status === 429) {
      setPwStatus(t('too_many', Number(j.retry_after_s) || 60), 'bad');
    } else if (r.status === 403) {
      setPwStatus(t('cross_site'), 'bad');
    } else if (r.status === 401 && j.error === 'invalid current password') {
      setPwStatus(j.retry_after_s
        ? t('passwd_bad_current_limited', Number(j.retry_after_s))
        : t('passwd_bad_current'), 'bad');
    } else if (r.status === 401) {
      // The session went away underneath us — an expiry, or another tab changing the
      // password first. Say so and put the login entry back rather than blaming the
      // password they typed.
      setPwStatus(t('passwd_session_lost'), 'bad');
      await sessionLost();
    } else {
      setPwStatus(esc(String(j.reason || t('passwd_failed'))), 'bad');
    }
  } catch (e) {
    setPwStatus(t('req_failed', esc(String(e?.message || e))), 'bad');
  } finally {
    clearPasswdFields();   // always — success, rejection, or network failure
    busy = false;
    $('#passwdSubmit').disabled = false;
  }
}

export function openPasswdPanel() {
  $('#passwdModal').classList.add('open');
  clearPasswdFields();
  setPwStatus(t('passwd_intro'));
  setTimeout(() => $('#passwdCurrent')?.focus(), 0);
}

export function closePasswdPanel() {
  $('#passwdModal')?.classList.remove('open');
  clearPasswdFields();
  // Same reason logout() clears the login panel's line: the next person to open this
  // must not be greeted by the previous outcome.
  setPwStatus('');
}

export function openLoginPanel() {
  // On an install with no password, logging in cannot succeed by construction. If this
  // caller is allowed to run first-run setup, send them there instead of to a box whose
  // only possible outcome is "not configured".
  if (!state.configured && state.setupAvailable) return openSetupPanel();
  $('#loginModal').classList.add('open');
  clearPass();
  if (!state.configured) {
    setStatus(t('login_hint_unconfigured'), 'warn');
    $('#loginSubmit').disabled = true;
  } else {
    setStatus(t('login_hint'));
    $('#loginSubmit').disabled = false;
  }
  setTimeout(() => $('#loginPass')?.focus(), 0);
}

export function closeLoginPanel() {
  $('#loginModal')?.classList.remove('open');
  clearPass();
}

// ── first-run setup ────────────────────────────────────────────────
// Shown once, on an install that has no admin password, to a caller on the LAN. Same
// two rules as every other password box here: the value goes only into the request
// body, and every path out of a submit clears both fields.
const setSetupStatus = (html, cls = '') => {
  const el = $('#setupStatus');
  if (el) { el.className = `addStatus ${cls}`; el.innerHTML = html; }
};

function clearSetupFields() {
  for (const id of ['#setupPass', '#setupConfirm']) {
    const el = $(id);
    if (el) el.value = '';
  }
}

export function openSetupPanel() {
  $('#setupModal')?.classList.add('open');
  clearSetupFields();
  setSetupStatus(t('setup_intro'));
  setTimeout(() => $('#setupPass')?.focus(), 0);
}

export function closeSetupPanel() {
  $('#setupModal')?.classList.remove('open');
  clearSetupFields();
  setSetupStatus('');
}

async function submitSetup() {
  if (busy) return;
  const pass = $('#setupPass').value;
  const confirm = $('#setupConfirm').value;

  // Both checked again on the server, which is the only place that decides. These two
  // just save a round trip — and the mismatch branch still clears the boxes, because a
  // mistyped password left in the DOM is the same exposure as a submitted one.
  if (!pass) return setSetupStatus(t('login_need_pass'), 'bad');
  if (pass !== confirm) {
    clearSetupFields();
    return setSetupStatus(t('setup_mismatch'), 'bad');
  }

  busy = true;
  $('#setupSubmit').disabled = true;
  setSetupStatus(t('setup_busy'), 'busy');
  try {
    const r = await fetch('/api/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pass, confirm }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setSetupStatus(t('setup_done'), 'ok');
      await refreshSession();
      closeSetupPanel();
      await onChange();
    } else if (r.status === 409) {
      // Someone else got there first, or this install was already configured. Either
      // way the wizard is over — re-read the state so the login entry takes its place.
      setSetupStatus(t('setup_conflict'), 'bad');
      await refreshSession();
    } else if (r.status === 403) {
      setSetupStatus(t('setup_lan_only'), 'bad');
    } else if (r.status === 429) {
      setSetupStatus(t('too_many', Number(j.retry_after_s) || 60), 'bad');
    } else {
      setSetupStatus(esc(String(j.reason || t('setup_failed'))), 'bad');
    }
  } catch (e) {
    setSetupStatus(t('req_failed', esc(String(e?.message || e))), 'bad');
  } finally {
    clearSetupFields();   // always — success, rejection, or network failure
    busy = false;
    $('#setupSubmit').disabled = false;
  }
}

/**
 * Offer the wizard on load, once, when the server says this caller may run it. Called
 * after the first refreshSession so it acts on a real answer rather than the default
 * state. Opening it is not a security decision — the server refuses the POST either way.
 */
export function maybeOpenSetup() {
  if (state.configured || !state.setupAvailable) return false;
  openSetupPanel();
  return true;
}

/**
 * Re-write whatever standing text an OPEN panel is showing. The status lines are the
 * only strings these panels hold that a `data-i18n` sweep cannot reach — they were
 * written by JS, so JS has to write them again. Deliberately limited to the idle/intro
 * lines: an outcome ("Wrong password.") stays in the language it was reported in rather
 * than being silently rewritten under the reader.
 */
export function relocalizeSession() {
  if ($('#loginModal')?.classList.contains('open')) {
    setStatus(state.configured ? t('login_hint') : t('login_hint_unconfigured'), state.configured ? '' : 'warn');
  }
  if ($('#passwdModal')?.classList.contains('open')) setPwStatus(t('passwd_intro'));
  if ($('#setupModal')?.classList.contains('open')) setSetupStatus(t('setup_intro'));
}

export function bindSession(opts = {}) {
  onChange = opts.onChange || (() => {});
  $('#loginOpen').onclick = openLoginPanel;
  $('#setupClose').onclick = closeSetupPanel;
  $('#setupModal').onclick = (e) => { if (e.target.id === 'setupModal') closeSetupPanel(); };
  $('#setupSubmit').onclick = submitSetup;
  for (const id of ['#setupPass', '#setupConfirm']) {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') submitSetup(); };
  }
  $('#loginClose').onclick = closeLoginPanel;
  $('#loginModal').onclick = (e) => { if (e.target.id === 'loginModal') closeLoginPanel(); };
  $('#loginSubmit').onclick = submit;
  $('#loginPass').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#logoutBtn').onclick = logout;
  $('#passwdOpen').onclick = openPasswdPanel;
  $('#passwdClose').onclick = closePasswdPanel;
  $('#passwdModal').onclick = (e) => { if (e.target.id === 'passwdModal') closePasswdPanel(); };
  $('#passwdSubmit').onclick = submitPasswd;
  for (const id of ['#passwdCurrent', '#passwdNew', '#passwdConfirm']) {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') submitPasswd(); };
  }
  apply();
}
