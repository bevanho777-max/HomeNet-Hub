// Push host binding (v2.31) — which machine a push target belongs to.
//
// A push target is authenticated by its shared token alone, so any machine holding the token
// can report as that target. That is how machine 28 once reported as m25: its agent had been
// deployed with m25's id and token, and its numbers went into m25's history unnoticed. Agents
// now send extra.host = { machine_id, hostname }. machine_id is the sha256 of the box's own id
// (/etc/machine-id, Windows MachineGuid, the Synology serial) -- the raw id never leaves the box,
// the hub only has to compare. The first push that carries one BINDS the target to that host;
// a later push from any other host is refused: nothing is written, the card says "Push from
// unexpected host: <ip> (<hostname>)" for ALERT_TTL_MS, and the hub logs it.
//
// A push without host info is accepted while the target is unbound (an agent older than v2.31,
// during a rollout) and refused once it is bound -- the bound host's agent always sends it.
//
// Resetting (new machine, OS reinstall) is server/push_bindings_cli.js, see REBUILD 8.5. The CLI
// and the hub share this table through SQLite (WAL) and the hub reads the row on every push, so
// a reset takes effect on the next push without a restart. Cost: a primary-key lookup per push,
// about three a second across six targets.
//
// Connection: its own better-sqlite3 handle to data/homenet.db, like the other stores.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ALERT_TTL_MS = 24 * 3600 * 1000;    // how long the card keeps the warning
const LOG_EVERY_MS = 10 * 60 * 1000;             // a continuing refusal is logged this often

const MID_RE = /^[0-9a-f]{32,128}$/;

/** The host a push says it comes from, or null when it carries none (or a malformed one). */
export function hostOf(body) {
  const h = body?.extra?.host;
  if (!h || typeof h !== 'object' || typeof h.machine_id !== 'string' || !MID_RE.test(h.machine_id)) return null;
  const hostname = typeof h.hostname === 'string' ? h.hostname.replace(/[^\w.-]/g, '').slice(0, 63) : '';
  return { machineId: h.machine_id, hostname };
}

/** The address a push came from: the forwarding chain's last hop, without the IPv4-mapped prefix. */
export const normIp = (a) => String(a || '').replace(/^::ffff:/i, '') || 'unknown';

const short = (mid) => (mid ? `${mid.slice(0, 8)}…` : 'none');
const label = (hostname, ip) => `${ip} (${hostname || '?'})`;

export class PushBindings {
  /** @param {string} dbPath  @param {{ log?: (msg: string) => void }} [opts] */
  constructor(dbPath, { log = console.warn } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_bindings (
        target      TEXT PRIMARY KEY,
        machine_id  TEXT NOT NULL,
        hostname    TEXT NOT NULL,
        ip          TEXT NOT NULL,       -- where the bound host last pushed from
        bound_at    INTEGER NOT NULL,    -- ms
        alert_ip    TEXT,                -- the last refused push: address,
        alert_host  TEXT,                --   reported hostname ('' = none),
        alert_mid   TEXT,                --   machine_id (NULL = it sent none)
        alert_first INTEGER,             --   first and last refusal of this run (ms),
        alert_at    INTEGER,
        alert_count INTEGER NOT NULL DEFAULT 0   -- refusals since the binding or the last clear
      );
    `);
    this.log = log;
    this._get = this.db.prepare('SELECT * FROM push_bindings WHERE target = ?');
    this._all = this.db.prepare('SELECT * FROM push_bindings ORDER BY target');
    this._bind = this.db.prepare(`INSERT INTO push_bindings (target, machine_id, hostname, ip, bound_at)
      VALUES (?, ?, ?, ?, ?)`);
    this._ip = this.db.prepare('UPDATE push_bindings SET ip = ? WHERE target = ?');
    this._alert = this.db.prepare(`UPDATE push_bindings SET alert_ip = ?, alert_host = ?, alert_mid = ?,
      alert_first = COALESCE(alert_first, ?), alert_at = ?, alert_count = alert_count + 1 WHERE target = ?`);
    this._clear = this.db.prepare(`UPDATE push_bindings SET alert_ip = NULL, alert_host = NULL, alert_mid = NULL,
      alert_first = NULL, alert_at = NULL, alert_count = 0 WHERE target = ?`);
    this._del = this.db.prepare('DELETE FROM push_bindings WHERE target = ?');
    this._logged = new Map();   // target -> { key, at, since }: throttles the refusal log line
  }

  /**
   * Decide one push. `host` is hostOf(body), `ip` the normalized source address.
   * @returns {{ ok: true, bound?: boolean } | { ok: false, reason: string }}
   */
  check(target, host, ip, now = Date.now()) {
    const row = this._get.get(target);
    if (!row) {
      if (!host) return { ok: true };                 // pre-v2.31 agent, nothing to bind to yet
      this._bind.run(target, host.machineId, host.hostname, ip, now);
      this.log(`[push:BIND] ${target}: bound to ${label(host.hostname, ip)} id=${short(host.machineId)}`);
      return { ok: true, bound: true };
    }
    const same = host && host.machineId === row.machine_id
      && host.hostname.toLowerCase() === String(row.hostname).toLowerCase();
    if (same) {
      if (ip !== row.ip) {
        this._ip.run(ip, target);
        this.log(`[push:BIND] ${target}: bound host ${row.hostname} now pushes from ${ip} (was ${row.ip})`);
      }
      return { ok: true };
    }
    this._alert.run(ip, host?.hostname || '', host?.machineId || null, now, now, target);
    this._logRefusal(target, row, host, ip, now);
    return { ok: false, reason: host ? 'unexpected host' : 'no host info (target is bound)' };
  }

  // First refusal from a given host is logged at once; while it keeps pushing (every 2 s),
  // one line per LOG_EVERY_MS with the count in between.
  _logRefusal(target, row, host, ip, now) {
    const key = `${ip}|${host?.machineId || ''}`;
    const prev = this._logged.get(target);
    if (prev && prev.key === key && now - prev.at < LOG_EVERY_MS) { prev.since += 1; return; }
    const more = prev && prev.key === key && prev.since ? ` (${prev.since} more since the last line)` : '';
    this._logged.set(target, { key, at: now, since: 0 });
    this.log(`[push:HOST] ${target}: refused push from unexpected host ${label(host?.hostname, ip)} `
      + `id=${short(host?.machineId)}${more}; bound to ${label(row.hostname, row.ip)} id=${short(row.machine_id)} -- not recorded`);
  }

  /** The card warning for a target, or null: the last refusal within ALERT_TTL_MS. */
  alertOf(row, now = Date.now()) {
    if (!row?.alert_at || now - row.alert_at > ALERT_TTL_MS) return null;
    return { ip: row.alert_ip, hostname: row.alert_host || '', at: row.alert_at, first: row.alert_first, count: row.alert_count };
  }

  /** target -> alert, for /api/snapshot. */
  alerts(now = Date.now()) {
    const out = new Map();
    for (const row of this._all.all()) {
      const a = this.alertOf(row, now);
      if (a) out.set(row.target, a);
    }
    return out;
  }

  list() { return this._all.all(); }

  /** Forget a target's binding (and its warning); its next push with host info binds anew. */
  reset(target) {
    const row = this._get.get(target) || null;
    if (row) this._del.run(target);
    this._logged.delete(target);
    return row;
  }

  /** Drop the warning but keep the binding. */
  clearAlert(target) {
    this._logged.delete(target);
    return this._clear.run(target).changes > 0;
  }

  close() { this.db.close(); }
}
