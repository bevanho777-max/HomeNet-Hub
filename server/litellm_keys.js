// litellm_keys.js — a narrow client for LiteLLM's virtual-key API (§ client manager).
//
// WHY THIS EXISTS. The Per-Project Tokens card can only ever show what LiteLLM's
// accounting table holds: `LiteLLM_DailyUserSpend.api_key`, which is the sha256 digest
// of the key a request came in on. A digest is not a name. The alias that a human typed
// when the key was minted lives in a different table that a read-only SQL role cannot
// see, and the proxy master key has no row there at all. So the names come from the
// proxy's own management API instead, over HTTP, with the master key as the credential.
//
// SCOPE. Three calls, nothing more: list (to map digest → name), generate, delete. This
// module never touches inference endpoints and never reads spend — spend stays on the
// read-only SQL path it has always been on, and the two are joined by digest.
//
// THE PLAINTEXT KEY IS RETURNED EXACTLY ONCE. LiteLLM hands it back from /key/generate
// and then keeps only the digest, so neither it nor this process can ever produce it
// again. It is passed straight to the caller and is never logged, never cached, and
// never written anywhere — every console line below prints counts and status codes, and
// `redact()` guards the one path where a proxy error body could echo a key back.
//
// REACHABILITY. The default base URL is the compose service name, not localhost: the hub
// runs in its own container, where 127.0.0.1 is the hub itself. docker-compose.yml joins
// the external `litellm_default` network precisely so `http://litellm:4000` resolves.
// Override with LITELLM_BASE_URL if the proxy lives elsewhere.

const DEFAULT_BASE = 'http://litellm:4000';
const LIST_TTL_MS = 30_000;      // digest→name changes only when someone mints or deletes
const TIMEOUT_MS = 6_000;
const PAGE_SIZE = 100;           // the proxy's own maximum; larger is a 422
const MAX_PAGES = 20;            // 2000 keys, and a hard stop on a runaway page count

// A key value the operator can read off a card and paste into a config file. LiteLLM
// accepts a user-supplied `key`, so a client gets `sk-homenet-<name>` instead of a random
// 16-digit string nobody can attribute later.
//
// Two different alphabets, on purpose. The NAME is a label shown on a board whose UI is
// Chinese, so it accepts any Unicode letter — rejecting 中文 here would make the feature
// unusable for the person it was built for. The KEY VALUE is not a label: it gets pasted
// into JSON, YAML, URLs and shells, so `slug()` reduces the name to ASCII and everything
// outside that is dropped rather than escaped. A name with no ASCII at all yields
// `sk-homenet-client-<suffix>`; the random suffix is what keeps those distinct, which is
// why it is there and not merely decorative.
//
// 2 characters minimum, matching what the API's own rejection message promises — a
// one-character client name is not a label anyone can act on.
const KEY_PREFIX = 'sk-homenet-';
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,38}[\p{L}\p{N}]$/u;

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Strip anything that looks like a key out of text that is about to be logged or sent to
// a client. Proxy error bodies are quoted verbatim in a few places and one of them could
// contain the value that was just rejected.
function redact(s) {
  return String(s ?? '').replace(/sk-[A-Za-z0-9_\-]{4,}/g, 'sk-***');
}

export function createLitellmKeys({
  baseUrl = process.env.LITELLM_BASE_URL || DEFAULT_BASE,
  masterKey = process.env.LITELLM_MASTER_KEY || '',
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const key = String(masterKey || '').trim();
  const configured = key.length > 0;
  const reason = configured ? null : 'LITELLM_MASTER_KEY not set';

  let cache = null;          // { at, keys }
  let inflight = null;       // de-dupe concurrent refreshes (the card polls on a timer)

  async function call(path, { method = 'GET', body = null } = {}) {
    if (!configured) throw Object.assign(new Error(reason), { code: 'unconfigured' });
    const r = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep null, report the text */ }
    if (!r.ok) {
      // detail can be a validation array, not a string — stringify before redacting, or
      // the message reads "[object Object]" and hides what the proxy actually objected to.
      const raw = json?.error?.message ?? json?.detail ?? text ?? '';
      const detail = redact(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300);
      throw Object.assign(new Error(`litellm ${method} ${path} -> ${r.status}${detail ? `: ${detail}` : ''}`),
        { code: 'upstream', status: r.status });
    }
    return json;
  }

  /**
   * Every minted key, as { token (sha256 digest = DailyUserSpend.api_key), name, masked,
   * created_at }. Cached for LIST_TTL_MS: the card refreshes on the target's own poll
   * cadence and there is no reason for each of those to hit the proxy.
   *
   * The master key is deliberately absent — it is a config literal, never minted, and has
   * no row here. Callers match it by its own sentinel (`litellm_proxy_master_key`).
   */
  async function list({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < LIST_TTL_MS) return cache.keys;
    if (inflight) return inflight;
    inflight = (async () => {
      // `size` is capped at 100 by the proxy (anything larger is a 422), so this pages
      // rather than asking for everything at once. MAX_PAGES bounds the work if the
      // proxy ever reports a page count that does not terminate — a management call on
      // the snapshot path must not be able to loop.
      const keys = [];
      let page = 1;
      let pages = 1;
      do {
        const j = await call('/key/list'
          + `?return_full_object=true&include_team_keys=true&size=${PAGE_SIZE}&page=${page}`);
        for (const k of j?.keys || []) {
          if (typeof k?.token !== 'string' || !k.token) continue;
          keys.push({
            token: k.token,
            name: k.key_alias || null,
            masked: k.key_name || null,    // "sk-...EX2w" — safe to show, not the key
            created_at: k.created_at || null,
          });
        }
        pages = Number(j?.total_pages) || 1;
        page += 1;
      } while (page <= pages && page <= MAX_PAGES);
      cache = { at: Date.now(), keys };
      return keys;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** digest → display name. Never throws: an unreachable proxy must degrade to digests,
   *  not blank the card that is the whole point of the feature. */
  async function aliasMap() {
    try {
      const keys = await list();
      return new Map(keys.filter((k) => k.name).map((k) => [k.token, k.name]));
    } catch {
      return new Map();
    }
  }

  /**
   * Mint a key named `name`. Returns { key, token, name } where `key` is the plaintext —
   * the only time it will ever exist outside the client that stores it.
   *
   * The key VALUE is derived from the name so it can be recognised on sight in a config
   * file, with a short random suffix so two clients with the same name (or a re-created
   * one) cannot collide on a value that is also a credential.
   */
  async function generate(name) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const wanted = `${KEY_PREFIX}${slug(name) || 'client'}-${suffix}`;
    const j = await call('/key/generate', { method: 'POST', body: { key: wanted, key_alias: name } });
    cache = null;                                     // a new key must show up immediately
    return { key: j?.key || wanted, token: j?.token || null, name: j?.key_alias || name };
  }

  /** Revoke by digest (what the listing hands out). Returns the proxy's deleted count. */
  async function remove(token) {
    const j = await call('/key/delete', { method: 'POST', body: { keys: [token] } });
    cache = null;
    return { deleted: (j?.deleted_keys || []).length };
  }

  function status() {
    return {
      configured,
      reason,
      base_url: base,                                  // no credential in it
      cached_keys: cache ? cache.keys.length : null,
    };
  }

  return { configured, reason, status, list, aliasMap, generate, remove };
}
