// v2.48 KiwiVM (BandwagonHost) VPS: monthly transfer, reset, status, memory and disk from the provider's
// own API (https://api.64clouds.com/v1/<call>?veid=..&api_key=..), read-only.
//
//   getLiveServiceInfo   every `interval` (default 5m): everything getServiceInfo returns plus the live status,
//                        memory and disk. Only when it fails is getServiceInfo called instead -- the transfer
//                        figures stay current, status / memory / disk keep their last good values (with
//                        their time). Both failing is an API error. (Bevan, 2026-11-13: one call per poll.)
//   getRawUsageStats     every `usage_every` (default 1h), cached in between
//
// The credentials live in the environment only (`veid_env` / `key_env` name the variables, default
// KIWIVM_VEID / KIWIVM_API_KEY): never in config, the snapshot, the database or a log line. Every error
// text that leaves this file has the key (and the api_key= query value) masked first -- including what
// the socket layer throws. The response carries the account e-mail, the IPs, the SSH port and a screen
// dump; only the whitelisted figures below go into the snapshot (the board is public by default).
//
// A failed poll keeps the last good figures (shown with their time and the error); consecutive
// failures back off 5 -> 10 -> 20 -> 40 -> 60 min instead of retrying every tick. The last good
// figures are kept in the database too, so a restart while the API is down still shows them.
//
// Units, as KiwiVM uses them: plan_monthly_data is 3000 x 2^30 bytes for a "3 TB" plan, so 1 GB here is
// 2^30 bytes and 1 TB is 1000 GB. Per the API documentation both plan_monthly_data and data_counter
// "need to be multiplied by monthly_data_multiplier" (a per-location bandwidth accounting coefficient);
// the daily figures from getRawUsageStats (network in + out per 5-minute sample: what data_counter counts)
// get the same multiplier, so a day's bar and the month's counter are in the same units.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import Database from 'better-sqlite3';

export const API_DEFAULT = 'https://api.64clouds.com/v1/';
const GB = 2 ** 30;
const KB = 1024;
const DAY = 86400;
const SPARK_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024;           // getLiveServiceInfo is ~20 KB (a screen dump inside)
const BACKOFF_BASE_MS = 300000;            // 5 min, doubled per consecutive failure
const BACKOFF_MAX_MS = 3600000;            // 60 min
const PROJECT_MIN_SEC = DAY;               // the month-end projection needs a day of the cycle behind it

// "2026-11-13" -- the Beijing calendar day of a unix-seconds instant (the board's day everywhere)
export const bjDay = (sec) => new Date((sec + 8 * 3600) * 1000).toISOString().slice(0, 10);

/** Mask every secret in a string: the literal key, and any api_key= (and veid=) query value. */
export function redact(s, secrets = []) {
  let out = String(s ?? '');
  for (const v of secrets) if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('***');
  return out.replace(/((?:api_key|veid)=)[^&\s"'<>]*/gi, '$1***');
}

/** The start of the billing cycle that ends at `reset` (unix s): one calendar month earlier (UTC),
 *  the day clamped to the shorter month (Mar 31 -> Feb 28). */
export function monthBefore(reset) {
  const d = new Date(reset * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
  const last = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
  return Date.UTC(py, pm, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

const num = (x) => (x === null || x === undefined || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
const clampPct = (x) => (x == null ? null : Math.max(0, Math.min(100, x)));

/**
 * GET a URL and parse JSON, directly or through an HTTP proxy (CONNECT tunnel). Rejects with a plain
 * Error whose message is NOT yet redacted -- the caller masks it (it knows the secrets).
 */
export function getJson(urlStr, { timeoutMs = 15000, proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const reqs = [];
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) for (const r of reqs) { try { r.destroy(); } catch { /* gone */ } }
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    const onRes = (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { finish(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) { finish(new Error(`HTTP ${res.statusCode}`)); return; }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('invalid JSON')); }
      });
      res.on('error', (e) => finish(e));
    };
    const headers = { accept: 'application/json', 'user-agent': 'homenet-hub' };
    const get = (socket) => {
      const opts = { host: u.hostname, port, path: u.pathname + u.search, method: 'GET', headers };
      if (socket) opts.createConnection = () => (isHttps ? tls.connect({ socket, servername: u.hostname }) : socket);
      const r = (isHttps ? https : http).request(opts, onRes);
      reqs.push(r);
      r.on('error', (e) => finish(e));
      r.end();
    };
    if (!proxy) { get(null); return; }
    let p;
    try { p = new URL(proxy); } catch { finish(new Error('invalid proxy URL')); return; }
    if (p.protocol !== 'http:') { finish(new Error('proxy must be http://host:port')); return; }
    const c = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${u.hostname}:${port}`,
      headers: { host: `${u.hostname}:${port}` } });
    reqs.push(c);
    c.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); finish(new Error(`proxy CONNECT HTTP ${res.statusCode}`)); return; }
      get(socket);
    });
    c.on('error', (e) => finish(new Error(`proxy: ${e?.message || e}`)));
    c.end();
  });
}

function freshState() {
  return {
    svc: null, svcAt: 0,          // last good getServiceInfo / getLiveServiceInfo figures (whitelisted)
    live: null, liveAt: 0,
    days: new Map(),              // 'YYYY-MM-DD' -> { in, out, n } (bytes, multiplier NOT applied)
    rawAt: 0, rawNextAt: 0, rawFails: 0, rawErr: null,
    fails: 0, nextAt: 0, err: null, errAt: 0, triedAt: 0,
    liveErr: null,                // the last poll's getLiveServiceInfo error when getServiceInfo stood in
    cycleStart: null,             // exact start of the current cycle once a reset has been seen
    loaded: false,
  };
}

// Only these leave the collector. Everything else in the API's answer (e-mail, IP addresses, SSH
// port, MAC, hostname, the screen dump, the ISO list ...) is dropped right here.
function pickService(j) {
  return {
    plan: typeof j.plan === 'string' ? j.plan : null,
    location: typeof j.node_location_id === 'string' ? j.node_location_id : null,
    datacenter: typeof j.node_datacenter === 'string' ? j.node_datacenter.slice(0, 120) : null,
    os: typeof j.os === 'string' ? j.os : null,
    vm_type: typeof j.vm_type === 'string' ? j.vm_type : null,
    plan_monthly_data: num(j.plan_monthly_data),
    monthly_data_multiplier: num(j.monthly_data_multiplier),
    data_counter: num(j.data_counter),
    data_next_reset: num(j.data_next_reset),
    plan_ram: num(j.plan_ram),
    plan_disk: num(j.plan_disk),
    suspended: j.suspended === true || j.suspended === 1,
    policy_violation: j.policy_violation === true || j.policy_violation === 1,
  };
}
function pickLive(j) {
  return {
    ve_status: typeof j.ve_status === 'string' ? j.ve_status.toLowerCase() : null,
    ve_used_disk_space_b: num(j.ve_used_disk_space_b),
    ve_disk_quota_gb: num(j.ve_disk_quota_gb),
    mem_available_kb: num(j.mem_available_kb),
    swap_total_kb: num(j.swap_total_kb),
    swap_available_kb: num(j.swap_available_kb),
    load_average: typeof j.load_average === 'string' ? j.load_average.split(/\s+/).slice(0, 3).join(' ') : null,
    cpu_throttled: num(j.is_cpu_throttled) === 1,
    disk_throttled: num(j.is_disk_throttled) === 1,
  };
}

export class KiwiVmCollector {
  /** @param dbPath  the hub's database file (own tables: kiwivm_day, kiwivm_state) */
  constructor(dbPath, { get = getJson } = {}) {
    this._get = get;
    this.states = new Map();      // target id -> state
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kiwivm_day (target TEXT NOT NULL, day TEXT NOT NULL, in_bytes REAL NOT NULL,
        out_bytes REAL NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (target, day));
      CREATE TABLE IF NOT EXISTS kiwivm_state (target TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    this._dayPut = this.db.prepare(`INSERT INTO kiwivm_day (target, day, in_bytes, out_bytes, n, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (target, day) DO UPDATE SET in_bytes = excluded.in_bytes, out_bytes = excluded.out_bytes, n = excluded.n, at = excluded.at
      WHERE excluded.n >= kiwivm_day.n`);
    this._dayGet = this.db.prepare('SELECT day, in_bytes, out_bytes, n FROM kiwivm_day WHERE target = ? AND day >= ? ORDER BY day');
    this._statePut = this.db.prepare('INSERT OR REPLACE INTO kiwivm_state (target, json, at) VALUES (?, ?, ?)');
    this._stateGet = this.db.prepare('SELECT json FROM kiwivm_state WHERE target = ?');
  }

  /** Called on every config (re)load with the enabled kiwivm targets. A target whose source changed starts over. */
  configure(targets) {
    const next = new Map();
    for (const t of targets || []) {
      const sig = JSON.stringify(t.source || {});
      const old = this.states.get(t.id);
      next.set(t.id, old && old.sig === sig ? old : { sig, st: freshState() });
    }
    this.states = next;
  }

  _st(target) {
    let e = this.states.get(target.id);
    if (!e) { e = { sig: JSON.stringify(target.source || {}), st: freshState() }; this.states.set(target.id, e); }
    const st = e.st;
    if (!st.loaded) { st.loaded = true; this._load(target.id, st); }
    return st;
  }

  // the last good figures from before a restart (the daily table is read on every view)
  _load(id, st) {
    try {
      const row = this._stateGet.get(id);
      if (!row) return;
      const s = JSON.parse(row.json);
      if (s.svc) { st.svc = s.svc; st.svcAt = Number(s.svcAt) || 0; }
      if (s.live) { st.live = s.live; st.liveAt = Number(s.liveAt) || 0; }
      st.rawAt = Number(s.rawAt) || 0;
      st.cycleStart = num(s.cycleStart);
      // the hourly raw call is due again an hour after the last one, not at once on every restart
      if (st.rawAt) st.rawNextAt = st.rawAt + 3600000;
    } catch { /* a corrupt row: start empty */ }
  }

  _save(id, st) {
    try {
      this._statePut.run(id, JSON.stringify({ svc: st.svc, svcAt: st.svcAt, live: st.live, liveAt: st.liveAt, rawAt: st.rawAt, cycleStart: st.cycleStart }), Date.now());
    } catch (e) { console.error(`[kiwivm] ${id}: state not saved: ${e?.message || e}`); }
  }

  _creds(target, env) {
    const src = target.source || {};
    const veid = String(env[src.veid_env || 'KIWIVM_VEID'] ?? '').trim().replace(/^["']|["']$/g, '');
    const key = String(env[src.key_env || 'KIWIVM_API_KEY'] ?? '').trim().replace(/^["']|["']$/g, '');
    const proxy = String(env[src.proxy_env || 'KIWIVM_PROXY'] ?? '').trim().replace(/^["']|["']$/g, '');
    return { veid, key, proxy };
  }

  async _call(target, call, creds, timeoutMs) {
    const base = String(target.source?.url || API_DEFAULT).replace(/\/*$/, '/');
    const url = `${base}${call}?${new URLSearchParams({ veid: creds.veid, api_key: creds.key })}`;
    try {
      const j = await this._get(url, { timeoutMs, proxy: creds.proxy });
      if (!j || typeof j !== 'object') throw new Error('empty answer');
      // the API answers HTTP 200 with { error: <code>, message } when it refuses
      if (num(j.error)) throw new Error(`KiwiVM error ${j.error}${j.message ? `: ${String(j.message).slice(0, 160)}` : ''}`);
      return j;
    } catch (e) {
      const msg = e?.code && !String(e.message || '').includes(e.code) ? `${e.code} ${e.message}` : (e?.message || String(e));
      throw new Error(`${call}: ${redact(msg, [creds.key])}`);
    }
  }

  /**
   * One scheduled poll. Calls the API when due (not while backing off) and returns the view either way.
   * `opts`: { timeoutMs, usageEveryMs, env, now }
   */
  async poll(target, { timeoutMs = 15000, usageEveryMs = 3600000, env = process.env, now = Date.now() } = {}) {
    const st = this._st(target);
    const creds = this._creds(target, env);
    if (!creds.veid || !creds.key) {
      st.err = `${target.source?.veid_env || 'KIWIVM_VEID'} / ${target.source?.key_env || 'KIWIVM_API_KEY'} not set`;
      st.errAt = now;
      return this.view(target, { now, fresh: false });
    }
    if (now < st.nextAt) return this.view(target, { now, fresh: false });
    st.triedAt = now;
    // getLiveServiceInfo returns everything getServiceInfo does: one call per poll; getServiceInfo only
    // when it fails (the transfer figures from there, status / memory / disk kept from the last good Live)
    let liveJ = null, svcJ = null;
    const errs = [];
    try { liveJ = await this._call(target, 'getLiveServiceInfo', creds, timeoutMs); svcJ = liveJ; } catch (e) { errs.push(e?.message || String(e)); }
    if (!liveJ) {
      try { svcJ = await this._call(target, 'getServiceInfo', creds, timeoutMs); } catch (e) { errs.push(e?.message || String(e)); }
    }
    if (svcJ) {
      const s = pickService(svcJ);
      const prevReset = st.svc?.data_next_reset;
      // a new reset date while the old one has passed: the old one is exactly when this cycle began
      if (prevReset && s.data_next_reset && s.data_next_reset > prevReset && prevReset <= now / 1000 + 600) st.cycleStart = prevReset;
      if (st.cycleStart && s.data_next_reset && st.cycleStart >= s.data_next_reset) st.cycleStart = null;
      st.svc = s; st.svcAt = Date.now();
    }
    if (liveJ) { st.live = pickLive(liveJ); st.liveAt = Date.now(); st.liveErr = null; } else st.liveErr = errs[0] || null;
    // an API error only when neither call answered
    if (!svcJ) {
      st.err = errs.join('; ');
      st.errAt = now;
    } else st.err = null;
    if (!svcJ) {
      st.fails += 1;
      st.nextAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (st.fails - 1)) - 5000;   // (5 s early: lands on that tick)
      if (st.fails === 1 || st.fails % 5 === 0) console.warn(`[kiwivm] ${target.id}: ${st.err} (failure ${st.fails}, next try in ${Math.round((st.nextAt - now) / 60000)} min)`);
    } else {
      if (st.fails) console.log(`[kiwivm] ${target.id}: API answers again after ${st.fails} failure(s)`);
      st.fails = 0; st.nextAt = 0;
    }
    // the 5-minute samples, hourly (its own back-off, never faster than the hourly cadence would retry)
    if (svcJ && now >= st.rawNextAt) {
      try {
        const j = await this._call(target, 'getRawUsageStats', creds, timeoutMs);
        this._storeDays(target.id, j);
        st.rawAt = Date.now(); st.rawFails = 0; st.rawErr = null;
        st.rawNextAt = now + usageEveryMs - 5000;
      } catch (e) {
        st.rawFails += 1;
        st.rawErr = e?.message || String(e);
        st.rawNextAt = now + Math.min(usageEveryMs, BACKOFF_BASE_MS * 2 ** (st.rawFails - 1)) - 5000;
        if (st.rawFails === 1 || st.rawFails % 5 === 0) console.warn(`[kiwivm] ${target.id}: ${st.rawErr} (failure ${st.rawFails})`);
      }
    }
    if (svcJ) this._save(target.id, st);
    // (fresh = Live answered now: only then is every figure current, and only then are they written to the
    // timeseries again -- a poll that fell back to getServiceInfo would re-write old memory / disk values)
    return this.view(target, { now, fresh: !!liveJ });
  }

  // getRawUsageStats: { data: [{ timestamp, network_in_bytes, network_out_bytes, ... }, ...] }, one sample per
  // 5 minutes, published in batches (2026-11-13: up to an hour late). The fields were network_in_kbytes /
  // network_out_kbytes in the first answers for a VPS a few minutes old and *_bytes after that -- both are read.
  // in + out is what data_counter counts: summed sample by sample it matched the counter to within 1.2 KB at
  // six readings (2026-11-13). Summed per Beijing day; a day is only overwritten by an answer with at least as
  // many samples (the oldest day of a window may be cut short; the window must not shrink a day already stored).
  _storeDays(id, j) {
    const rows = Array.isArray(j?.data) ? j.data : [];
    const days = new Map();
    const bytes = (r, k) => (num(r[`${k}_bytes`]) ?? ((num(r[`${k}_kbytes`]) ?? 0) * KB));
    for (const r of rows) {
      const ts = num(r?.timestamp);
      if (ts == null) continue;
      const d = bjDay(ts);
      const e = days.get(d) || { in: 0, out: 0, n: 0 };
      e.in += bytes(r, 'network_in');
      e.out += bytes(r, 'network_out');
      e.n += 1;
      days.set(d, e);
    }
    const at = Date.now();
    this.db.transaction(() => { for (const [d, e] of days) this._dayPut.run(id, d, e.in, e.out, e.n, at); })();
  }

  /** The figures the card and the map read (no secret, no address). `fresh` = from this very poll. */
  view(target, { now = Date.now(), fresh = false } = {}) {
    const st = this._st(target);
    const s = st.svc, l = st.live;
    const nowSec = now / 1000;
    const mult = s?.monthly_data_multiplier || 1;
    const used = s?.data_counter != null ? s.data_counter * mult : null;
    const total = s?.plan_monthly_data != null ? s.plan_monthly_data * mult : null;
    const pct = used != null && total > 0 ? (used / total) * 100 : null;
    const reset = s?.data_next_reset ?? null;
    const exact = !!st.cycleStart;
    const start = st.cycleStart || (reset ? monthBefore(reset) : null);
    // month-end projection: this cycle's average per day so far, carried on to the reset
    let perDay = null, projected = null;
    const elapsed = start != null ? nowSec - start : null;
    if (used != null && reset && elapsed >= PROJECT_MIN_SEC) {
      perDay = used / (elapsed / DAY);
      projected = used + perDay * Math.max(0, reset - nowSec) / DAY;
    }
    // memory: what the guest has available against the plan's RAM; disk: mapped blocks against the image size
    const ramTotal = s?.plan_ram ?? null;
    const memAvail = l?.mem_available_kb != null ? l.mem_available_kb * 1024 : null;
    const memPct = memAvail != null && ramTotal > 0 ? clampPct((1 - memAvail / ramTotal) * 100) : null;
    const diskTotal = l?.ve_disk_quota_gb != null ? l.ve_disk_quota_gb * GB : (s?.plan_disk ?? null);
    const diskUsed = l?.ve_used_disk_space_b ?? null;
    const diskPct = diskUsed != null && diskTotal > 0 ? clampPct((diskUsed / diskTotal) * 100) : null;
    const status = s?.suspended ? 'suspended' : (l?.ve_status || null);
    // the last SPARK_DAYS Beijing days, oldest first; a day the API never covered is null (no bar)
    const today = bjDay(nowSec);
    const first = bjDay(nowSec - (SPARK_DAYS - 1) * DAY);
    const have = new Map(this._dayGet.all(target.id, first).map((r) => [r.day, r]));
    const days = [];
    for (let i = SPARK_DAYS - 1; i >= 0; i--) {
      const d = bjDay(nowSec - i * DAY);
      const r = have.get(d);
      days.push(r ? { d, in: r.in_bytes * mult, out: r.out_bytes * mult, n: r.n } : { d, in: null, out: null, n: 0 });
    }
    return {
      has_data: !!s,
      fresh,
      status,
      suspended: !!s?.suspended,
      policy_violation: !!s?.policy_violation,
      cpu_throttled: !!l?.cpu_throttled,
      disk_throttled: !!l?.disk_throttled,
      load: l?.load_average ?? null,
      plan: s?.plan ?? null, location: s?.location ?? null, datacenter: s?.datacenter ?? null, os: s?.os ?? null,
      mult,
      used, total, pct,
      used_gb: used != null ? used / GB : null,
      reset, cycle_start: start, cycle_exact: exact,
      per_day: perDay, projected,
      mem: { pct: memPct, avail: memAvail, total: ramTotal },
      disk: { pct: diskPct, used: diskUsed, total: diskTotal },
      days, today,
      data_at: st.svcAt || null, live_at: st.liveAt || null, raw_at: st.rawAt || null,
      api: {
        ok: !st.err, err: st.err, err_at: st.err ? st.errAt : null, fails: st.fails,
        live_err: st.err ? null : st.liveErr,
        next_at: st.nextAt || null, raw_err: st.rawErr,
        every: target.source?.interval || '5m', usage_every: target.source?.usage_every || '1h',
      },
    };
  }
}
