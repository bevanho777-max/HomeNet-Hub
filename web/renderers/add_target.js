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
import { t } from '../i18n.js';

const $ = (s) => document.querySelector(s);

let onChanged = () => {};
let manifest = null;      // last successful /api/discover result
let creds = { vault: { configured: false }, credentials: [] };
let busy = false;

// ── host pre-check ──────────────────────────────────────────────────
// UX only, and deliberately a copy of nothing: the server's net_guard remains the
// authority and is what actually refuses a probe. This exists so typing a public
// address gets an instant explanation in the reader's own language instead of a round
// trip that returns a validator string, and its verdict is never trusted for anything.
function hostHint(raw) {
  const s = (raw || '').trim();
  if (!s) return t('add_need_ip');
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return t('add_ipv4_only');
  const o = m.slice(1, 5);
  if (o.some((x) => x.length > 1 && x[0] === '0')) return t('add_leading_zero');
  const n = o.map(Number);
  if (n.some((x) => x > 255)) return t('add_octet_range');
  const [a, b] = n;
  if (a === 169 && b === 254) return t('add_link_local');
  const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 127;
  if (!priv) return t('add_private_only');
  return null;
}

// Server errors come back in English from the validator; these are the ones a user can
// actually hit, mapped to something actionable. Anything unmapped is shown verbatim
// rather than swallowed — an unexplained failure is worse than an English one.
//
// In EN mode the mapping is still applied rather than short-circuited: the phrasing here
// is the one written for a person, while the validator's is written for a log line
// ("host must be a private IPv4 literal"). Only the unmapped tail falls through raw.
function reasonText(reason = '') {
  if (/private IPv4/.test(reason)) return t('add_reason_private');
  if (/link-local/.test(reason)) return t('add_reason_link_local');
  if (/leading zero/.test(reason)) return t('add_reason_leading_zero');
  if (/not an IPv4 literal/.test(reason)) return t('add_reason_not_ipv4');
  if (/not in the known port set/.test(reason)) return t('add_reason_port');
  if (/collector pending/.test(reason)) return t('add_reason_pending');
  if (/is TLS — use tls_cert/.test(reason)) return t('add_reason_tls');
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
  setStatus(t('add_probing', esc(host)), 'busy');
  manifest = null;
  renderManifest();
  try {
    const r = await fetch(`/api/discover?host=${encodeURIComponent(host)}`, { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) return setStatus(t('add_refused', esc(reasonText(j.reason || j.error || ''))), 'bad');
    manifest = j;
    // Fetched alongside the manifest so a credential-backed row can render its picker
    // in the same paint — asking for it lazily would flash an empty select.
    try { creds = await (await fetch('/api/credentials', { cache: 'no-store' })).json(); }
    catch { creds = { vault: { configured: false }, credentials: [] }; }
    const n = j.suggested_capabilities.filter((c) => c.available).length;
    setStatus(j.reachable
      ? t('add_probe_ok', j.took_ms, n)
      : t('add_probe_silent', esc(j.host)), j.reachable ? 'ok' : 'warn');
    renderManifest();
  } catch (e) {
    setStatus(t('add_probe_failed', esc(String(e?.message || e))), 'bad');
  } finally {
    busy = false;
    $('#addDiscover').disabled = false;
  }
}

// ── manifest rendering ──────────────────────────────────────────────
const WIDGET_GROUP = {
  service: 'add_group_service',
  info: 'add_group_info',
  machine: 'add_group_machine',
};

// A capability that needs a credential gets a picker instead of a name field. The list
// comes from the credentials API — names only, which is all this side ever sees.
function credPicker(capId) {
  if (!creds.vault?.configured) {
    return `<span class="addPending">${esc(t('add_no_vault'))}</span>`;
  }
  if (!creds.credentials.length) {
    return `<span class="addPending">${esc(t('add_no_creds'))}</span>`;
  }
  return `<select class="addName addCred credSelect" data-for="${esc(capId)}">`
    + creds.credentials.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.username)})</option>`).join('')
    + '</select>';
}

function pendingWhy(cap) {
  if (cap.requires === 'ssh') return t('add_needs_ssh');
  if (cap.requires === 'winrm') return t('add_needs_winrm');
  return t('add_needs_collector');
}

function renderManifest() {
  const box = $('#addManifest');
  const foot = $('#addFoot');
  if (!manifest) { box.innerHTML = ''; foot.hidden = true; return; }

  const m = manifest;
  const ports = m.open_ports.map((p) =>
    `<span class="addChip">${p.port}<i>${esc(p.port_hint)}</i></span>`).join('')
    || `<span class="addMuted">${esc(t('add_none'))}</span>`;

  const svc = m.services.map((s) => `<div class="addSvc">
      <b>:${s.port}</b>
      <span>${s.http_status ? `HTTP ${s.http_status}` : '—'}</span>
      <span class="addMuted">${esc(s.server || '')}</span>
      <span>${esc(s.title || '')}</span>
      ${s.tls_expiry_days != null ? `<span class="addMuted">${esc(t('add_cert_days', s.tls_expiry_days))}</span>` : ''}
    </div>`).join('');

  // Group by widget so a long list reads as "ports / certificates / machine metrics"
  // rather than one flat column of 18 checkboxes.
  const groups = new Map();
  for (const c of m.suggested_capabilities) {
    const g = WIDGET_GROUP[c.widget] ? t(WIDGET_GROUP[c.widget]) : c.widget;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const caps = [...groups].map(([g, list]) => `
    <div class="addGroup"><h4>${esc(g)}</h4>${list.map((c) => (c.available ? `
      <label class="addCap${c.requires === 'credential' ? ' needsCred' : ''}" data-cap="${esc(c.id)}">
        <input type="checkbox" class="addPick" value="${esc(c.id)}"${
          c.requires === 'credential' && !(creds.vault?.configured && creds.credentials.length) ? ' disabled' : ''} />
        <span class="addCapLabel">${esc(c.label)}</span>
        ${c.requires === 'credential' ? credPicker(c.id)
          : `<input type="text" class="addName" placeholder="${esc(t('add_custom_name_ph'))}" maxlength="60" />`}
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
      <span>${esc(m.reachable ? t('add_reachable') : t('add_silent'))}</span>
      ${m.latency_ms != null ? `<span class="addMuted">${m.latency_ms}ms</span>` : ''}
      <span class="addMuted">·</span>
      <span>${esc(m.os_hint)}</span>
      <span class="addMuted">(${esc(m.os_hint_reason)})</span>
    </div>
    <div class="addRow"><span class="addMuted">${esc(t('add_open_ports'))}</span><div class="addChips">${ports}</div></div>
    ${svc ? `<div class="addRow"><span class="addMuted">${esc(t('add_services'))}</span><div class="addSvcs">${svc}</div></div>` : ''}
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
  btn.textContent = n ? t('add_selected_n', n) : t('add_selected');
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
    const credSel = row.querySelector('.addCred');
    const credentialId = credSel ? credSel.value : undefined;
    // The name input and the credential picker share a slot; only one is ever present.
    const name = credSel ? undefined : (row.querySelector('.addName')?.value.trim() || undefined);
    out.className = 'addResult busy';
    out.textContent = t('add_adding');
    try {
      const r = await fetch('/api/user_targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // host + capability id only. No source, ever.
        body: JSON.stringify({
          host: manifest.host, capability: pick.value,
          ...(name ? { name } : {}), ...(credentialId ? { credential_id: credentialId } : {}),
        }),
      });
      const j = await r.json();
      if (r.ok) {
        out.className = 'addResult ok'; out.textContent = t('add_added');
        pick.checked = false; pick.disabled = true; row.classList.add('done');
        added++;
      } else if (r.status === 409) {
        out.className = 'addResult warn'; out.textContent = t('add_exists');
        pick.checked = false; pick.disabled = true;
      } else {
        out.className = 'addResult bad';
        out.textContent = reasonText(j.reason || (j.errors || []).join('; ') || j.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      out.className = 'addResult bad';
      out.textContent = t('req_failed', String(e?.message || e));
    }
  }
  busy = false;
  updateCount();
  if (added) {
    setStatus(t('add_added_n', added), 'ok');
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
    box.innerHTML = rows.length ? rows.map((x) => `
      <div class="addItem" data-id="${esc(x.id)}">
        <span class="addDot ${x.enabled ? 'ok' : ''}"></span>
        <b>${esc(x.name)}</b>
        <span class="addMuted">${esc(x.host || '')}</span>
        <span class="addChip">${esc(x.capability || t('add_manual'))}</span>
        <button type="button" class="addDel">${esc(t('del'))}</button>
      </div>`).join('') : `<div class="addMuted">${esc(t('add_list_empty'))}</div>`;
    box.querySelectorAll('.addDel').forEach((btn) => {
      btn.onclick = () => removeOne(btn.closest('.addItem'));
    });
  } catch {
    box.innerHTML = `<div class="addStatus bad">${esc(t('add_list_failed'))}</div>`;
  }
}

async function removeOne(row) {
  const id = row?.dataset.id;
  if (!id) return;
  // Deleting takes a card off the panel; a mis-click should not be silent.
  if (!window.confirm(t('add_del_confirm', id))) return;
  const btn = row.querySelector('.addDel');
  btn.disabled = true; btn.textContent = t('deleting');
  try {
    const r = await fetch(`/api/user_targets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(reasonText(j.reason || j.error || `HTTP ${r.status}`));
    // A deleted target frees its id, so anything in the manifest that was greyed out
    // as "already added" can be picked again — re-render rather than leave it stale.
    await refreshList();
    await onChanged();
    setStatus(t('add_deleted', esc(id)), 'ok');
  } catch (e) {
    btn.disabled = false; btn.textContent = t('del');
    setStatus(t('add_del_failed', esc(String(e?.message || e))), 'bad');
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
  setStatus(t('add_intro'));
  refreshList();
  setTimeout(() => $('#addHost')?.focus(), 0);
}

export function closeAddPanel() { $('#addModal')?.classList.remove('open'); }

/** Re-render an OPEN panel in the language now selected; the manifest and the added
 *  list are both rebuilt from data already in hand, so nothing is re-fetched. */
export function relocalizeAddPanel() {
  if (!$('#addModal')?.classList.contains('open')) return;
  setStatus(t('add_intro'));
  renderManifest();
  refreshList();
}

export function bindAddTarget(opts = {}) {
  onChanged = opts.onChanged || (() => {});
  $('#addOpen').onclick = openAddPanel;
  $('#addClose').onclick = closeAddPanel;
  $('#addModal').onclick = (e) => { if (e.target.id === 'addModal') closeAddPanel(); };
  $('#addDiscover').onclick = discover;
  $('#addHost').onkeydown = (e) => { if (e.key === 'Enter') discover(); };
  $('#addSelected').onclick = addSelected;
}
