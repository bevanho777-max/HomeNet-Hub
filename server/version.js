// The product version, read once from package.json at startup.
//
// package.json is the single source of truth and is bumped together with the
// CHANGELOG heading at release time. Reading it here rather than hardcoding a string
// means the two can never disagree, and nothing but `version` is ever taken from the
// file — the rest of it (dependencies, scripts) has no business reaching an API.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read() {
  try {
    const v = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))?.version;
    // A version is only useful if it is a plain semver-ish string. Anything else is
    // ignored rather than shipped to every client as-is.
    return typeof v === 'string' && /^[\w.+-]{1,32}$/.test(v) ? v : null;
  } catch {
    // A missing or unreadable package.json must not stop the panel from booting;
    // the version simply goes unreported.
    return null;
  }
}

export const VERSION = read();
