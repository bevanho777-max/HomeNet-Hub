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
import { t } from '../i18n.js';

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
      // One element, one whole sentence — see the comment on #credLockedWhy in index.html.
      $('#cliOffWhy').textContent = t('cli_off_why', j.litellm?.reason || t('cli_unconfigured'));
      box.innerHTML = '';
      foot.textContent = '';
      return;
    }
    if (j.error) setStatus(t('cli_api_down', esc(j.error)), 'warn');
    const rows = j.clients || [];
    // v2.23: a real table -- name left, the figures right-aligned in their own columns
    // under right-aligned headers, so a column of token counts reads down one edge.
    box.innerHTML = rows.length ? `<table class="tbl cliTbl"><thead><tr>`
      + `<th>${esc(t('cli_col_name'))}</th><th class="num">${esc(t('cli_col_tokens'))}</th>`
      + `<th class="num opt">${esc(t('cli_col_net'))}</th><th class="num">${esc(t('cli_col_reqs'))}</th>`
      + `<th class="num opt">${esc(t('cli_col_today'))}</th><th></th></tr></thead><tbody>${rows.map((c) => {
        const u = c.usage || {};
        // A system row (the proxy master key) has no key row to delete, and a revoked one
        // is already gone — both keep their usage on screen but lose the button.
        const del = (c.system || c.revoked)
          ? `<span class="addChip">${esc(c.system ? t('cli_system') : t('cli_revoked'))}</span>`
          : `<button type="button" class="addDel">${esc(t('del'))}</button>`;
        return `<tr class="cliRow" data-id="${esc(c.id)}">`
          + `<td class="cliName" title="${esc(c.name)}"><span class="addDot ${c.revoked ? '' : 'ok'}"></span><b>${esc(c.name)}</b></td>`
          + `<td class="num">${esc(compact(u.tokens_total))}</td><td class="num opt">${esc(compact(u.net_total))}</td>`
          + `<td class="num">${esc(Number(u.requests_total ?? 0).toLocaleString('en-US'))}</td>`
          + `<td class="num opt">${esc(u.requests_today ? Number(u.requests_today).toLocaleString('en-US') : '—')}</td>`
          + `<td class="cliAct">${del}</td></tr>`;
      }).join('')}</tbody></table>` : `<div class="addMuted">${esc(t('cli_empty'))}</div>`;
    box.querySelectorAll('.addDel').forEach((b) => { b.onclick = () => removeOne(b.closest('.cliRow')); });
    // Rejected-auth traffic, counted but deliberately not named: that column of the
    // spend table holds whatever a caller sent as its key, including things people
    // pasted by mistake, so the server never echoes an unrecognised value.
    const un = j.unattributed;
    foot.textContent = un ? t('cli_unattributed', un.keys, un.requests) : '';
  } catch {
    box.innerHTML = `<div class="addStatus bad">${esc(t('cli_list_failed'))}</div>`;
  }
}

async function create() {
  if (busy) return;
  const name = $('#cliName').value.trim();
  if (!name) return setStatus(t('cli_need_name'), 'bad');
  busy = true;
  $('#cliCreate').disabled = true;
  hideNewKey();
  setStatus(t('cli_busy'), 'busy');
  try {
    const r = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    if (r.status === 503) setStatus(t('cli_key_api_off', esc(j.reason || '')), 'bad');
    else if (r.status === 409) setStatus(t('cli_dup', esc(name)), 'warn');
    else if (!r.ok) setStatus(t('cli_create_failed', esc(j.reason || j.error || `HTTP ${r.status}`)), 'bad');
    else {
      setStatus(t('cli_created', esc(j.name)), 'ok');
      showNewKey(j.key);
      $('#cliName').value = '';
      await refresh();
      await onChanged();
    }
  } catch (e) {
    setStatus(t('req_failed', esc(String(e?.message || e))), 'bad');
  } finally {
    busy = false;
    $('#cliCreate').disabled = false;
  }
}

async function removeOne(row) {
  const id = row?.dataset.id;
  if (!id) return;
  const name = row.querySelector('b')?.textContent || id;
  if (!window.confirm(t('cli_del_confirm', name))) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = t('cli_revoking');
  try {
    const r = await fetch(`/api/clients/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.reason || j.error || `HTTP ${r.status}`);
    setStatus(t('cli_revoked_ok', esc(name)), 'ok');
    await refresh();
    await onChanged();
  } catch (e) {
    btn.disabled = false; btn.textContent = t('del');
    setStatus(t('cli_revoke_failed', esc(String(e?.message || e))), 'bad');
  }
}

async function copyKey() {
  const text = $('#cliNewKey')?.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(t('cli_copied'), 'ok');
  } catch {
    // Clipboard access needs a secure context; a LAN panel on plain http has none.
    // Selecting the text is the fallback, and saying so beats a button that does nothing.
    const el = $('#cliNewKey');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    setStatus(t('cli_copy_manual'), 'warn');
  }
}

export function openClientsPanel() {
  $('#cliModal').classList.add('open');
  hideNewKey();
  setStatus(t('cli_intro'));
  refresh();
  setTimeout(() => $('#cliName')?.focus(), 0);
}

export function closeClientsPanel() {
  $('#cliModal')?.classList.remove('open');
  hideNewKey();
}

/** Re-render an OPEN panel in the language now selected. The reveal box is deliberately
 *  left alone: it holds a plaintext key that exists nowhere else, and a refresh that
 *  cleared it would destroy the one copy. */
export function relocalizeClientsPanel() {
  if (!$('#cliModal')?.classList.contains('open')) return;
  if ($('#cliNew')?.hidden !== false) setStatus(t('cli_intro'));
  refresh();
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
