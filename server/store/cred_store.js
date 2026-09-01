// Credential storage (slice 2e) — ciphertext at rest, in the same data/homenet.db.
//
// The table holds no plaintext column at all: `secret_enc` is the vault blob and there
// is nowhere else a password could hide. Reads that serve the API deliberately do not
// SELECT that column, so a listing cannot leak it even by accident — the only way to
// reach a secret is secretOf(), which exists for the collector that will open the
// connection and is never wired to a route.
//
// Its own connection to the same file, mirroring UserStore: the two hold unrelated data
// with unrelated lifecycles, and WAL supports several connections in one process.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CRED_TYPES = ['ssh_password', 'ssh_key', 'winrm_password'];
const NAME_RE = /^[\w .:@-]{1,60}$/;
const MAX_SECRET = 16 * 1024;      // an RSA/ed25519 private key with comments fits well inside

export class CredStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        username   TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_name ON credentials(name);
      -- vault salt + verifier. One row, id='vault'. Lives beside the ciphertext on
      -- purpose: a restored backup carries the salt it was encrypted under.
      -- SSH host keys, trust-on-first-use. We are about to hand a password to whatever
      -- answers on this address, so a key that changed underneath us is a refusal, not a
      -- warning: an attacker who can answer on the LAN address gets the credential for
      -- free otherwise.
      CREATE TABLE IF NOT EXISTS ssh_known_hosts (
        hostport    TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        id         TEXT PRIMARY KEY,
        salt       BLOB NOT NULL,
        verifier   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ── vault meta (used by openVault) ────────────────────────────────
  getMeta() {
    const r = this.db.prepare("SELECT salt, verifier FROM vault_meta WHERE id = 'vault'").get();
    return r ? { salt: r.salt, verifier: r.verifier } : null;
  }

  setMeta(salt, verifier) {
    this.db.prepare(`INSERT INTO vault_meta (id, salt, verifier, created_at) VALUES ('vault', ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(salt, verifier, Date.now());
  }

  // ── credentials ───────────────────────────────────────────────────
  /** Listing shape. secret_enc is not selected — it cannot leak through this path. */
  list() {
    return this.db.prepare(
      'SELECT id, name, type, username, created_at FROM credentials ORDER BY created_at, id').all();
  }

  get(id) {
    return this.db.prepare(
      'SELECT id, name, type, username, created_at FROM credentials WHERE id = ?').get(id) || null;
  }

  /** The one path that returns ciphertext. For the collector that will decrypt it —
   *  no route calls this, and none should. */
  secretOf(id) {
    return this.db.prepare('SELECT secret_enc FROM credentials WHERE id = ?').get(id)?.secret_enc || null;
  }

  /**
   * @param {{name,type,username}} meta
   * @param {string} secretEnc  already encrypted by the caller — this store never sees
   *                            plaintext, which is why it cannot accidentally persist it
   */
  insert({ name, type, username }, secretEnc) {
    const id = `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`INSERT INTO credentials (id, name, type, username, secret_enc, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, type, username, secretEnc, Date.now());
    return this.get(id);
  }

  remove(id) {
    return { removed: this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes };
  }

  count() { return this.db.prepare('SELECT COUNT(*) c FROM credentials').get().c; }

  // ── ssh known hosts (TOFU) ────────────────────────────────────────
  /** @returns {'new'|'match'|'mismatch'} and records on first sight. */
  checkHostKey(hostport, fingerprint) {
    const row = this.db.prepare('SELECT fingerprint FROM ssh_known_hosts WHERE hostport = ?').get(hostport);
    const now = Date.now();
    if (!row) {
      this.db.prepare(`INSERT INTO ssh_known_hosts (hostport, fingerprint, first_seen, last_seen)
        VALUES (?, ?, ?, ?)`).run(hostport, fingerprint, now, now);
      return 'new';
    }
    if (row.fingerprint !== fingerprint) return 'mismatch';
    this.db.prepare('UPDATE ssh_known_hosts SET last_seen = ? WHERE hostport = ?').run(now, hostport);
    return 'match';
  }

  knownHosts() {
    return this.db.prepare('SELECT hostport, fingerprint, first_seen, last_seen FROM ssh_known_hosts ORDER BY hostport').all();
  }

  forgetHostKey(hostport) {
    return { removed: this.db.prepare('DELETE FROM ssh_known_hosts WHERE hostport = ?').run(hostport).changes };
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

/**
 * Validate a create request. Returns the cleaned fields or a reason — and NEVER echoes
 * the secret back in an error, which is the easy way to leak one into a log.
 */
export function validateCredential(body) {
  const name = String(body?.name ?? '').trim();
  const type = String(body?.type ?? '').trim();
  const username = String(body?.username ?? '').trim();
  const secret = body?.secret;
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name must be 1-60 chars of letters, digits, space . : @ - _' };
  if (!CRED_TYPES.includes(type)) return { ok: false, reason: `type must be one of ${CRED_TYPES.join(', ')}` };
  if (!username || username.length > 60) return { ok: false, reason: 'username is required (max 60 chars)' };
  if (typeof secret !== 'string' || !secret.length) return { ok: false, reason: 'secret is required' };
  if (secret.length > MAX_SECRET) return { ok: false, reason: `secret exceeds ${MAX_SECRET} bytes` };
  return { ok: true, name, type, username, secret };
}
