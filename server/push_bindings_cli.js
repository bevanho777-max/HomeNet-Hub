// Push host bindings from the command line (v2.31) — see store/push_bindings.js.
//
//   docker exec homenet-hub node server/push_bindings_cli.js list
//   docker exec homenet-hub node server/push_bindings_cli.js reset <target>        # new machine / OS reinstall
//   docker exec homenet-hub node server/push_bindings_cli.js clear-alert <target>  # keep the binding, drop the warning
//
// It writes the same table the running hub reads on every push, so a reset takes effect on the
// target's next push (about 2 s later): the first push that carries host info binds it again.
// A reset while the unexpected host is still pushing would bind THAT host -- stop it first.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PushBindings } from './store/push_bindings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const [cmd, target] = process.argv.slice(2);

const ts = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '-');
const fmt = (r) => `${r.target.padEnd(8)} ${String(r.hostname).padEnd(16)} ${String(r.ip).padEnd(15)} `
  + `id=${r.machine_id.slice(0, 12)}…  bound ${ts(r.bound_at)}`
  + (r.alert_at ? `\n         ! refused ${r.alert_count}x from ${r.alert_ip} (${r.alert_host || '?'}), `
    + `${ts(r.alert_first)} .. ${ts(r.alert_at)}` : '');

const pb = new PushBindings(join(DATA_DIR, 'homenet.db'), { log: (m) => console.log(m) });
let code = 0;
if (cmd === 'list') {
  const rows = pb.list();
  console.log(rows.length ? rows.map(fmt).join('\n') : '(no bindings)');
} else if (cmd === 'reset' && target) {
  const row = pb.reset(target);
  console.log(row ? `reset ${target} (was ${row.hostname} ${row.ip}); its next push binds it again` : `${target}: not bound`);
} else if (cmd === 'clear-alert' && target) {
  console.log(pb.clearAlert(target) ? `${target}: warning cleared, binding kept` : `${target}: not bound`);
} else {
  console.error('usage: node server/push_bindings_cli.js list | reset <target> | clear-alert <target>');
  code = 2;
}
pb.close();
process.exit(code);
