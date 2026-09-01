// Runtime-added monitoring objects (slice 2) — SQLite-backed, config/-shaped.
//
// Production mounts config/ read-only, so anything added while the panel is running
// cannot go in the YAML. It goes here instead, in the same data/homenet.db that holds
// the timeseries (already a writable volume, already WAL).
//
// The stored `doc` of a row is EXACTLY the object the YAML would have contained — a
// targets.yaml target, or a layout.yaml grid card — so once effective.js concatenates
// the two sources, the scheduler, normalize, publicConfig and the whole frontend see
// one shape and needed no changes at all. That is the reason for storing JSON docs
// rather than a normalized column-per-field table: the schema of a target is already
// defined once, in schema.js, and a second definition here would drift from it.
//
// Connection: its own better-sqlite3 handle to the same file rather than borrowing
// Tsdb's. Tsdb owns a hot write path with its own prepared statements and watermark
// bookkeeping; threading a second table's lifecycle through it would couple two things
// that have no reason to know about each other. WAL allows multiple connections in one
// process, and busy_timeout covers the rare overlap with a rollup transaction.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ID_RE = /^[a-zA-Z0-9_]+$/;   // same pattern targets.yaml's schema enforces

export class UserStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Tsdb's rollup holds write transactions for ~20ms at a time; wait rather than
    // fail a user write that lands in one of those windows.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_targets (
        id         TEXT PRIMARY KEY,
        doc        TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_cards (
        id         TEXT PRIMARY KEY,
        doc        TEXT NOT NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- cards are read in one ordered sweep; the index keeps that off a sort
      CREATE INDEX IF NOT EXISTS idx_user_cards_pos ON user_cards(position, id);
    `);
    this._sel = {
      targets: this.db.prepare('SELECT id, doc, enabled FROM user_targets ORDER BY id'),
      cards: this.db.prepare('SELECT id, doc, position FROM user_cards ORDER BY position, id'),
    };
  }

  // ── reads ─────────────────────────────────────────────────────────
  // A row whose doc will not parse is skipped, not thrown: one corrupt row must not
  // take the panel down with it. It is logged so it is not silently invisible.
  listTargets() {
    return this._sel.targets.all().map((r) => this._parse(r, 'user_targets')).filter(Boolean)
      .map((r) => ({ ...r, enabled: r.enabled !== 0 }));
  }

  listCards() {
    return this._sel.cards.all().map((r) => this._parse(r, 'user_cards')).filter(Boolean);
  }

  /** Parsed docs ready for the assembly layer. Disabled targets keep enabled:false
   *  in their doc so the scheduler's existing filter does the work. */
  getUserConfig() {
    const targets = this.listTargets().map((r) => ({ ...r.doc, id: r.id, enabled: r.enabled }));
    const cards = this.listCards().map((r) => r.doc);
    return { targets, cards };
  }

  countAll() {
    const t = this.db.prepare('SELECT COUNT(*) c FROM user_targets').get().c;
    const c = this.db.prepare('SELECT COUNT(*) c FROM user_cards').get().c;
    return { targets: t, cards: c };
  }

  // ── writes ────────────────────────────────────────────────────────
  upsertTarget(id, doc, { enabled = true } = {}) {
    assertId(id, 'target');
    if (!doc || typeof doc !== 'object') throw new Error('target doc must be an object');
    // The row id is the identity. Storing a different id inside the doc would give the
    // assembly layer two answers to "what is this target called".
    const body = { ...doc, id };
    delete body.enabled;                     // enabled lives in its own column
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO user_targets (id, doc, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, enabled = excluded.enabled,
                                    updated_at = excluded.updated_at
    `).run(id, JSON.stringify(body), enabled ? 1 : 0, now, now);
    return { id };
  }

  upsertCard(id, doc, { position = null } = {}) {
    assertId(id, 'card');
    if (!doc || typeof doc !== 'object') throw new Error('card doc must be an object');
    const pos = position == null ? this._nextPosition() : Number(position);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO user_cards (id, doc, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, position = excluded.position,
                                    updated_at = excluded.updated_at
    `).run(id, JSON.stringify(doc), pos, now, now);
    return { id, position: pos };
  }

  /** Deleting a target takes its cards with it — a card pointing at a target that no
   *  longer exists is exactly what crossValidate refuses, so leaving orphans behind
   *  would wedge every later reassembly. Both statements share one transaction. */
  deleteTarget(id) {
    const tx = this.db.transaction((tid) => {
      const cards = this.listCards().filter((c) => cardTargets(c.doc).includes(tid));
      for (const c of cards) this.db.prepare('DELETE FROM user_cards WHERE id = ?').run(c.id);
      const r = this.db.prepare('DELETE FROM user_targets WHERE id = ?').run(tid);
      return { removed: r.changes, cards_removed: cards.length };
    });
    return tx(id);
  }

  deleteCard(id) {
    return { removed: this.db.prepare('DELETE FROM user_cards WHERE id = ?').run(id).changes };
  }

  setEnabled(id, enabled) {
    const r = this.db.prepare('UPDATE user_targets SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return { updated: r.changes };
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  // ── internals ─────────────────────────────────────────────────────
  _nextPosition() {
    const r = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM user_cards').get();
    return r.p;
  }

  _parse(row, table) {
    try { return { ...row, doc: JSON.parse(row.doc) }; }
    catch (e) {
      console.error(`[user_store] skipping unparsable ${table} row "${row.id}": ${e.message}`);
      return null;
    }
  }
}

/** Every target id a card references (its own target plus any stack children). */
export function cardTargets(card) {
  const ids = [];
  if (card?.target) ids.push(card.target);
  for (const c of card?.children || []) if (typeof c === 'string') ids.push(c);
  return ids;
}

function assertId(id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`invalid ${what} id "${id}" — must match ${ID_RE}`);
  }
}
