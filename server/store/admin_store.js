// Admin credential storage — the password's hash and the session signing secret, in the
// same data/homenet.db. SECURITY CRITICAL.
//
// One row, id='admin'. It holds three things:
//   - `salt` + `password_hash`: scrypt over the admin password. There is no plaintext
//     column and no route that returns the hash, so the only way out of this table is
//     an offline attack on a stolen database file — which is what the scrypt cost
//     parameter is there to price.
//   - `signing_secret`: 32 random bytes, the HMAC key for session cookies.
//
// Why the signing secret is its own random value rather than something derived from
// `password_hash`:
//   1. the hash is VERIFICATION material — a value we compare untrusted input against.
//      The secret is FORGERY material — anything holding it can mint a valid session.
//      Deriving one from the other collapses the two roles, so any future accident that
//      exposes the hash (a debug route, an error path, a log line) would hand out
//      session forgery on top of an offline cracking target;
//   2. it decouples the session's lifetime from the hash's ENCODING. Re-tuning the
//      scrypt cost, or migrating the hash format later, changes `password_hash` — and
//      with a derived key that would silently log every admin out as a side effect of
//      an unrelated change;
//   3. rotation stays an explicit act: changing the password writes a new secret in the
//      same transaction, and nothing else does.
//
// Connection: its own better-sqlite3 handle to the same file, mirroring UserStore and
// CredStore. The three hold unrelated data with unrelated lifecycles, and WAL supports
// several connections in one process.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROW_ID = 'admin';
export const SALT_LEN = 16;
export const SECRET_LEN = 32;      // 256 bits — an HMAC-SHA256 key needs no more

export class AdminStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_auth (
        id             TEXT PRIMARY KEY,
        password_hash  BLOB NOT NULL,
        salt           BLOB NOT NULL,
        signing_secret BLOB NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `);
  }

  /** @returns {{passwordHash:Buffer, salt:Buffer, signingSecret:Buffer, updatedAt:number}|null} */
  get() {
    const r = this.db.prepare(
      'SELECT password_hash, salt, signing_secret, updated_at FROM admin_auth WHERE id = ?').get(ROW_ID);
    if (!r) return null;
    return {
      passwordHash: r.password_hash,
      salt: r.salt,
      signingSecret: r.signing_secret,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Create the row if and only if it does not exist — the bootstrap path.
   * ON CONFLICT DO NOTHING rather than a check-then-insert: two boots racing for the
   * same empty table must not end up with the second one silently replacing the first
   * one's signing secret, which would invalidate the sessions it had already issued.
   * @returns {boolean} true if this call is the one that created it
   */
  bootstrap({ passwordHash, salt }) {
    const now = Date.now();
    const r = this.db.prepare(`
      INSERT INTO admin_auth (id, password_hash, salt, signing_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(ROW_ID, passwordHash, salt, randomBytes(SECRET_LEN), now, now);
    return r.changes === 1;
  }

  /**
   * Replace the password AND mint a new signing secret, atomically. The two always move
   * together: a password change that left the old secret in place would leave every
   * session issued under the old password valid, which is the opposite of what changing
   * a password means.
   * @returns {Buffer} the new signing secret
   */
  setPassword({ passwordHash, salt }) {
    const secret = randomBytes(SECRET_LEN);
    this.db.prepare(`UPDATE admin_auth
      SET password_hash = ?, salt = ?, signing_secret = ?, updated_at = ?
      WHERE id = ?`).run(passwordHash, salt, secret, Date.now(), ROW_ID);
    return secret;
  }

  /** The escape hatch's other half: used by tests; operators run the DELETE by hand. */
  clear() {
    return { removed: this.db.prepare('DELETE FROM admin_auth WHERE id = ?').run(ROW_ID).changes };
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

export const newSalt = () => randomBytes(SALT_LEN);
