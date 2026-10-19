// sha256 of the agent scripts as they are in this checkout (v2.18).
//
// Agents report their own sha256 in `extra.agent` ({ file, sha256 }). The machine
// detail modal compares that against the same file here, so "is this box running the
// agent that is in the repo?" no longer needs an SSH round to every host.
//
// The checkout IS the production build directory and is kept clean at HEAD (see the
// repo's working rules), so the working-tree file is the HEAD version. agents/ reaches
// the container as a read-only bind mount (docker-compose.yml); the image also carries
// a copy so an install without the mount still answers -- it is then as fresh as the
// last build. Hashes are cached by mtime+size, so polling this costs one stat per file.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAME_OK = /^[\w.-]+\.(sh|ps1)$/;
const cache = new Map();   // name -> { key, sha }

export function agentHeads(dir) {
  const out = {};
  let names = [];
  try { names = readdirSync(dir).filter((n) => NAME_OK.test(n)); } catch { return out; }
  for (const name of names) {
    try {
      const p = join(dir, name);
      const st = statSync(p);
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = cache.get(name);
      if (!hit || hit.key !== key) {
        hit = { key, sha: createHash('sha256').update(readFileSync(p)).digest('hex') };
        cache.set(name, hit);
      }
      out[name] = hit.sha;
    } catch { /* unreadable file: simply not reported */ }
  }
  return out;
}
