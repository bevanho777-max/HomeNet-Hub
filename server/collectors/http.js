// http collector (§3) — actively pull a machine's report endpoint.
// Returns parsed JSON or throws (scheduler marks the target offline/stale).

export async function collectHttp(source, timeoutMs, env = {}) {
  if (source.readiness != null) return collectModels(source, timeoutMs, env);
  const url = source.url;
  if (!url) throw new Error('http source missing url');
  // v2.31: `fallback_urls` (one) is tried after `url`, each attempt with its share of the
  // timeout -- a node that may serve on either of two ports (m110: 8082 or 8080) is up when
  // either answers. The first that answers wins and is named in `selected_endpoint`.
  const fb = Array.isArray(source.fallback_urls) ? source.fallback_urls : [];
  if (!fb.length) return fetchOne(url, timeoutMs);
  const urls = [url, ...fb];
  const share = Math.max(500, Math.floor(timeoutMs / urls.length));
  const errs = [];
  for (const u of urls) {
    try {
      const raw = await fetchOne(u, share);
      if (raw && typeof raw === 'object') raw.selected_endpoint = u;
      return raw;
    } catch (e) { errs.push(String(e?.message || e)); }
  }
  throw new Error(errs.join('; '));
}

async function fetchOne(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    // NOTE: source.proxy is LAN-direct by default (""); honoring an HTTP proxy
    // would require undici ProxyAgent — intentionally omitted (§4.2 defaults).
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    const raw = typeof body === 'string' ? tryJson(body) : body;
    // attach a measured latency so services can map $.latency_ms even if the
    // endpoint doesn't self-report one.
    if (raw && typeof raw === 'object' && raw.latency_ms == null) {
      raw.latency_ms = Date.now() - started;
    }
    if (raw && typeof raw === 'object' && raw.status == null) raw.status = 'online';
    return raw;
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'timeout' : String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return { status: 'online', raw_text: String(s).slice(0, 200) }; }
}

// Opt-in model readiness. Existing single-URL collectors retain the branch above.
async function collectModels(source, timeoutMs, env) {
  if (source.readiness !== 'llamacpp_models') throw new Error('unsupported HTTP readiness mode');
  if (!Array.isArray(source.fallback_urls || [])) throw new Error('invalid HTTP readiness candidates');
  const urls = [source.url, ...(source.fallback_urls || [])];
  if (!source.url || urls.length > 2 || new Set(urls).size !== urls.length) throw new Error('invalid HTTP readiness candidates');
  let parsed;
  try { parsed = urls.map(value => new URL(value)); } catch { throw new Error('invalid HTTP readiness URL'); }
  const first = parsed[0];
  if (parsed.some(u => !['http:', 'https:'].includes(u.protocol) || u.hostname !== first.hostname || u.protocol !== first.protocol ||
      u.username || u.password || u.search || u.hash || u.pathname !== '/v1/models')) {
    throw new Error('HTTP readiness candidates must share a host/protocol and models path');
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(source.key_env || '')) throw new Error('invalid HTTP readiness credential reference');
  const key = env[source.key_env];
  if (typeof key !== 'string' || !key.trim()) throw new Error('HTTP readiness credential unavailable');
  const attemptMs = source.attempt_timeout_ms;
  if (!Number.isInteger(attemptMs) || attemptMs < 50 || attemptMs > 2000) throw new Error('invalid HTTP readiness attempt timeout');
  const totalMs = Math.min(5000, Math.max(1, Number(timeoutMs) || 2500));
  const started = performance.now(), deadline = started + totalMs, failures = [];
  for (let index = 0; index < urls.length; index++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const ctrl = new AbortController();let timer;
    try {
      const operation = (async () => {
        const r = await fetch(urls[index], { signal: ctrl.signal, redirect: 'error',
          headers: { accept: 'application/json', Authorization: `Bearer ${key}` } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = await r.json();
        const model = Array.isArray(raw?.data) && raw.data.find(m =>
          m?.object === 'model' && m.owned_by === 'llamacpp' && typeof m.id === 'string' && m.id.trim() && m.id.length <= 200 &&
          [m.meta?.n_ctx, m.meta?.n_params, m.meta?.size].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) &&
          typeof m.meta?.ftype === 'string' && m.meta.ftype.trim());
        if (!model) throw new Error('no real ready model');
        return { status: 'online', model: model.id, latency_ms: Math.round(performance.now() - started), selected_endpoint: urls[index] };
      })();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort();reject(new Error('timeout')); }, Math.min(attemptMs, remaining)); });
      return await Promise.race([operation, timeout]);
    } catch (e) {
      const message = String(e?.message || '');
      failures.push(/^HTTP \d{3}$/.test(message) || message === 'timeout' || message === 'no real ready model' ? message : 'request failed');
    } finally { clearTimeout(timer);ctrl.abort(); }
  }
  throw new Error('model readiness unavailable: ' + failures.join('; '));
}
