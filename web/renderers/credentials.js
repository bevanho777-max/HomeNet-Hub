// Credentials panel (slice 2e) — a write-only door in the UI, matching the API.
//
// The secret field is <input type="password">, it is never populated from a response,
// and nothing that comes back from the server contains one. Once stored, a credential
// can be listed and deleted; it can never be read back. That is deliberate, and the
// panel says so, because a form that silently cannot show you what you typed reads as
// broken unless it tells you it is by design.
import { esc } from './common.js';
import { t } from '../i18n.js';

const $ = (s) => document.querySelector(s);
let onChanged = () => {};
let busy = false;

// Dictionary KEYS, not text: the same three names appear in the <select> in index.html
// (translated there by data-i18n), and two lists of the same three strings drift.
const TYPE_LABEL = {
  ssh_password: 'cred_type_ssh_password',
  ssh_key: 'cred_type_ssh_key',
  winrm_password: 'cred_type_winrm_password',
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
      // One element, one whole sentence — see the comment on #credLockedWhy in index.html.
      $('#credLockedWhy').textContent = t('cred_locked_why', j.vault?.reason || t('cred_unconfigured'));
      box.innerHTML = '';
      return;
    }
    const rows = j.credentials || [];
    box.innerHTML = rows.length ? rows.map((c) => `
      <div class="addItem" data-id="${esc(c.id)}">
        <span class="addDot ok"></span>
        <b>${esc(c.name)}</b>
        <span class="addMuted">${esc(c.username)}</span>
        <span class="addChip">${esc(TYPE_LABEL[c.type] ? t(TYPE_LABEL[c.type]) : c.type)}</span>
        <button type="button" class="addDel">${esc(t('del'))}</button>
      </div>`).join('') : `<div class="addMuted">${esc(t('cred_empty'))}</div>`;
    box.querySelectorAll('.addDel').forEach((b) => { b.onclick = () => removeOne(b.closest('.addItem')); });
  } catch {
    box.innerHTML = `<div class="addStatus bad">${esc(t('cred_list_failed'))}</div>`;
  }
}

async function submit() {
  if (busy) return;
  const name = $('#credName').value.trim();
  const type = $('#credType').value;
  const username = $('#credUser').value.trim();
  const secret = $('#credSecret').value;
  if (!name || !username || !secret) return setStatus(t('cred_need_fields'), 'bad');
  busy = true;
  $('#credSave').disabled = true;
  setStatus(t('cred_busy'), 'busy');
  try {
    const r = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type, username, secret }),
    });
    const j = await r.json();
    if (r.status === 503) setStatus(t('cred_vault_off', esc(j.reason || '')), 'bad');
    else if (r.status === 409) setStatus(t('cred_dup', esc(name)), 'warn');
    else if (!r.ok) setStatus(t('cred_save_failed', esc(j.reason || j.error || `HTTP ${r.status}`)), 'bad');
    else {
      setStatus(t('cred_saved', esc(j.name)), 'ok');
      $('#credName').value = ''; $('#credUser').value = '';
      await refresh();
      await onChanged();
    }
  } catch (e) {
    setStatus(t('req_failed', esc(String(e?.message || e))), 'bad');
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
  if (!window.confirm(t('cred_del_confirm', name))) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = t('deleting');
  try {
    const r = await fetch(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (r.status === 409) {
      btn.disabled = false; btn.textContent = t('del');
      return setStatus(t('cred_in_use', esc(name), esc((j.used_by || []).join(t('list_sep')))), 'warn');
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setStatus(t('cred_deleted', esc(name)), 'ok');
    await refresh();
    await onChanged();
  } catch (e) {
    btn.disabled = false; btn.textContent = t('del');
    setStatus(t('cred_del_failed', esc(String(e?.message || e))), 'bad');
  }
}

export function openCredPanel() {
  $('#credModal').classList.add('open');
  clearSecret();
  setStatus(t('cred_intro'));
  refresh();
  setTimeout(() => $('#credName')?.focus(), 0);
}

export function closeCredPanel() { $('#credModal')?.classList.remove('open'); }

/** Re-render an OPEN panel in the language now selected. */
export function relocalizeCredPanel() {
  if (!$('#credModal')?.classList.contains('open')) return;
  setStatus(t('cred_intro'));
  refresh();
}

export function bindCredentials(opts = {}) {
  onChanged = opts.onChanged || (() => {});
  $('#credOpen').onclick = openCredPanel;
  $('#credClose').onclick = closeCredPanel;
  $('#credModal').onclick = (e) => { if (e.target.id === 'credModal') closeCredPanel(); };
  $('#credSave').onclick = submit;
  $('#credSecret').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}
