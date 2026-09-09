// Demo onboarding bar (P2) — the one thing a fresh `docker compose up` says about
// itself: these machines are not yours, here is how to add your own.
//
// Two dismissals, deliberately NOT sharing state:
//   - "×" hides the bar in THIS browser (localStorage). A local convenience, and a
//     convenience must not be able to change what other visitors see.
//   - "清空演示" clears the demo board for the whole install (POST /api/demo/dismiss).
//     A management action, so it needs a session, a confirmation, and it survives a
//     reload for everyone.
// Collapsing the two into one flag would mean either that hiding a banner silently
// reconfigured the server, or that clearing the demo left the banner up on every other
// device until each one was clicked.
import { esc } from './common.js';
import { t } from '../i18n.js';

const $ = (s) => document.querySelector(s);
const HIDE_KEY = 'hnh_demo_bar_hidden';

let state = { demoMode: false, authed: false };
let hooks = {};   // { onAdd, onCleared, needsLogin }
let busy = false;

// localStorage throws in some privacy modes; a banner is not worth an exception on the
// render path, so both directions swallow and fall back to "not hidden".
const locallyHidden = () => {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
};
const setLocallyHidden = () => {
  try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* nothing to do */ }
};

const setText = (html, cls = '') => {
  const el = $('#demoText');
  if (el) { el.className = `demoText ${cls}`; el.innerHTML = html; }
};

/**
 * Show or hide the bar from the two facts that decide it.
 * @param {{demo_mode?:boolean}} config  the /api/config payload
 * @param {boolean} authed               whether this browser has an admin session
 */
export function applyDemoBar(config, authed) {
  state = { demoMode: !!config?.demo_mode, authed: !!authed };
  const bar = $('#demoBar');
  if (!bar) return;
  bar.hidden = !state.demoMode || locallyHidden();
  // "清空演示" is an admin action. Show it either way rather than hiding it — hiding it
  // would leave a logged-out visitor with no hint that the demo CAN be cleared — but
  // clicking it while logged out routes to the login/first-run box instead of a 401.
  const clear = $('#demoClear');
  if (clear) clear.textContent = state.authed ? t('demo_clear') : t('demo_clear_locked');
}

async function clearDemo() {
  if (busy) return;
  if (!state.authed) return hooks.needsLogin?.();
  // A one-way action for the whole install: worth one deliberate confirmation. Native
  // confirm() rather than a bespoke modal — this fires at most once in an install's life.
  if (!window.confirm(t('demo_confirm'))) return;

  busy = true;
  $('#demoClear').disabled = true;
  setText(t('demo_clearing'), 'busy');
  try {
    // The body is '{}' rather than absent: declaring content-type application/json and
    // then sending nothing is what Fastify's JSON parser rejects with a 400
    // (FST_ERR_CTP_EMPTY_JSON_BODY). The endpoint takes no input, but it still has to be
    // sent a parseable document.
    const r = await fetch('/api/demo/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      // The server has already reloaded its config; pull the new one so the demo cards
      // actually leave the screen instead of lingering until the next poll.
      await hooks.onCleared?.();
      const bar = $('#demoBar');
      if (bar) bar.hidden = true;
    } else if (r.status === 401) {
      setText(t('demo_expired'), 'bad');
      hooks.needsLogin?.();
    } else if (r.status === 403) {
      setText(t('cross_site'), 'bad');
    } else {
      setText(esc(String(j.reason || t('demo_failed'))), 'bad');
    }
  } catch (e) {
    setText(t('req_failed', esc(String(e?.message || e))), 'bad');
  } finally {
    busy = false;
    const b = $('#demoClear');
    if (b) b.disabled = false;
  }
}

export function bindDemoBar(opts = {}) {
  hooks = opts;
  $('#demoAdd').onclick = () => (state.authed ? hooks.onAdd?.() : hooks.needsLogin?.());
  $('#demoClear').onclick = clearDemo;
  $('#demoHide').onclick = () => {
    setLocallyHidden();
    const bar = $('#demoBar');
    if (bar) bar.hidden = true;
  };
}

/**
 * The empty board's own message. Rendered by app.js when the grid has no cards at all,
 * which after a dismiss is the normal state rather than an error — so it reads as an
 * invitation, not a failure.
 */
export function emptyBoardHtml(authed) {
  return `<div class="emptyBoard">
    <div class="emptyTitle">${esc(t('empty_title'))}</div>
    <div class="emptyHint">${esc(t(authed ? 'empty_hint_admin' : 'empty_hint_guest'))}</div>
  </div>`;
}
