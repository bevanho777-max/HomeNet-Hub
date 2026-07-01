// http collector (§3) — actively pull a machine's report endpoint.
// Returns parsed JSON or throws (scheduler marks the target offline/stale).

export async function collectHttp(source, timeoutMs) {
  const url = source.url;
  if (!url) throw new Error('http source missing url');
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
