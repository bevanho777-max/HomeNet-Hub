// sql collector (§5.5) — SECURITY CRITICAL, read-only.
// SQL only ever comes from a file under queries/. We NEVER accept SQL text
// from config or the frontend. The single bound parameter is a whitelisted
// integer (range in days). pg is lazy-imported so the app still runs if the
// driver/DSN is absent (the target just reports offline).
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUERY_DIRS = [
  join(process.env.CONFIG_DIR || join(ROOT, 'config'), 'queries'),
  join(ROOT, 'config.example', 'queries'),
];

const _fileCache = new Map();
const _pools = new Map();
let _pg = null;

function resolveQueryFile(queryFile) {
  // queryFile is a config-relative path like "queries/token_summary.sql".
  const base = queryFile.replace(/^queries[/\\]/, '');
  if (base.includes('..')) throw new Error(`illegal query_file path: ${queryFile}`);
  for (const dir of QUERY_DIRS) {
    const p = resolve(dir, base);
    if (!p.startsWith(resolve(dir))) throw new Error(`query_file escapes queries dir: ${queryFile}`);
    if (existsSync(p)) return p;
  }
  throw new Error(`query_file not found: ${queryFile}`);
}

function readQuery(queryFile) {
  if (_fileCache.has(queryFile)) return _fileCache.get(queryFile);
  const sql = readFileSync(resolveQueryFile(queryFile), 'utf8');
  _fileCache.set(queryFile, sql);
  return sql;
}

async function getPool(dsn) {
  if (_pools.has(dsn)) return _pools.get(dsn);
  if (!_pg) {
    try {
      ({ default: _pg } = await import('pg'));
    } catch {
      throw new Error('pg driver not installed');
    }
  }
  const pool = new _pg.Pool({ connectionString: dsn, max: 2, statement_timeout: 8000 });
  _pools.set(dsn, pool);
  return pool;
}

/**
 * Run the target's query with a whitelisted numeric range param.
 * @param {object} source  the target.source
 * @param {object} env     process.env (for dsn_env)
 * @param {number} rangeDays  whitelisted integer
 * @returns {Promise<object[]>} rows
 */
export async function collectSql(source, env, rangeDays) {
  const dsn = env[source.dsn_env];
  if (!dsn) throw new Error(`env ${source.dsn_env} not set`);
  const days = Number.isFinite(rangeDays) ? Math.max(1, Math.min(366, Math.floor(rangeDays))) : 30;
  const sql = readQuery(source.query_file);
  const pool = await getPool(dsn);
  const res = await pool.query(sql, [days]); // positional, integer only
  return res.rows;
}

/**
 * Run a queries/ file that returns a single scalar, bound to ONE whitelisted
 * integer param. Same security envelope as collectSql: SQL only from queries/,
 * one positional integer, zero concatenation. Used for the token-speed sample
 * (and any future slow-cycle scalar). Returns a finite number or null.
 * @param {object} source     the target.source (for dsn_env)
 * @param {object} env        process.env
 * @param {string} queryFile  config-relative path under queries/
 * @param {number} paramInt   whitelisted integer (e.g. sample count)
 * @param {string} [column]   column to read; default = first column of row 0
 */
export async function collectSqlScalar(source, env, queryFile, paramInt, column) {
  const dsn = env[source.dsn_env];
  if (!dsn) throw new Error(`env ${source.dsn_env} not set`);
  const n = Number.isFinite(paramInt) ? Math.max(1, Math.min(1000, Math.floor(paramInt))) : 10;
  const sql = readQuery(queryFile); // same resolveQueryFile whitelist (queries/ only, no ..)
  const pool = await getPool(dsn);
  const res = await pool.query(sql, [n]); // positional, integer only
  const row = res.rows[0] || {};
  const v = column ? row[column] : Object.values(row)[0];
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

/**
 * Run a queries/ file returning multiple rows. Same security envelope as
 * collectSql (SQL only from queries/, zero concatenation). The param is OPTIONAL:
 * omit it for a param-less all-time aggregate (e.g. the cumulative total) — that
 * has zero injection surface; when present it is a single whitelisted integer.
 * @param {object} source     the target.source (for dsn_env)
 * @param {object} env        process.env
 * @param {string} queryFile  config-relative path under queries/
 * @param {number} [paramInt] optional whitelisted integer bound as $1
 * @returns {Promise<object[]>} rows
 */
export async function collectSqlRows(source, env, queryFile, paramInt) {
  const dsn = env[source.dsn_env];
  if (!dsn) throw new Error(`env ${source.dsn_env} not set`);
  const sql = readQuery(queryFile); // same resolveQueryFile whitelist (queries/ only, no ..)
  const pool = await getPool(dsn);
  const params = (paramInt === undefined || paramInt === null)
    ? [] // param-less all-time aggregate
    : [Math.max(1, Math.min(1000, Math.floor(Number(paramInt))))];
  const res = await pool.query(sql, params); // positional, integer only (or none)
  return res.rows;
}

export async function closeSqlPools() {
  for (const pool of _pools.values()) { try { await pool.end(); } catch { /* ignore */ } }
  _pools.clear();
}

export function clearQueryCache() { _fileCache.clear(); }
