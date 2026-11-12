// v2.48.1 config check mode -- no server, no collectors, no database, no network:
//
//   node server/config/check.js            (in the image: docker run --rm --network none \
//                                              -v <config>:/app/config:ro --entrypoint node <image> server/config/check.js)
//
// Loads CONFIG_DIR (default /app/config, falling back to config.example/ per file, exactly as a hub start does)
// through the same loader and prints one JSON line:
//   { "ok": true,  "version": "2.48.1", "warnings": [...], "skipped_targets": [...], "unsupported_cards": [...] }
//   { "ok": false, "version": "2.48.1", "errors": [...] }
// Exit 0 = this version would start on this config (what it would set aside is in `warnings`); 1 = it would not
// (`errors`, in the same "<kind>/<path> <message> (<params>)" form the hub logs). homenet-deploy.sh --rollback runs it
// with the target release's image before switching; releases before v2.48.1 have no check mode (see that script).
import { loadConfig } from './loader.js';
import { VERSION } from '../version.js';

let code = 0;
let out;
try {
  const c = loadConfig();
  out = {
    ok: true, version: VERSION || null,
    warnings: c.warnings || [], skipped_targets: c.skipped_targets || [], unsupported_cards: c.unsupported_cards || [],
    using_fallback: !!c.usingFallback,
  };
} catch (e) {
  code = 1;
  out = { ok: false, version: VERSION || null, errors: Array.isArray(e?.errors) ? e.errors : [String(e?.message || e)] };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(code);
