// comfy_follow.js (v2.41) — 跟随 ComfyUI 的端口 / follow the port a ComfyUI server actually listens on.
//
// The Windows agent reports, under extra.comfyui of its machine target (agents/homenet-agent.ps1):
//   { procs: 1, listen: [{ port: 8188, addr: "0.0.0.0" }], cmd_port: 8188, pid: 340832, since: <unix s> }
// procs = python processes running ComfyUI's main.py; listen = the TCP ports they listen on; always sent
// (procs 0) by an agent that looks. The hub probes the port in use instead of the one written in
// targets.yaml, so a ComfyUI restarted on 8000 (the desktop app's default) or with another --port is
// followed without a config change; the firewall rule for a new port is added by the 24-side follower
// (homenet-config scripts/homenet-comfy-fw-follow.py). Used by the scheduler for `process: comfyui`
// http targets (the 「ComfyUI · 136」 pill) and by the ComfyUI nodes collector (every node; its id is
// its machine's id).
//
// A listener bound only to loopback (127.0.0.1 / ::1) is not reachable from the hub and is not followed.

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;

/** extra.comfyui of a live, fresh machine snapshot -- null when the machine is off / stale or the agent does not report it */
export function comfyInfo(m) {
  if (!m || m.online === false || m.stale) return null;
  const c = m.extra?.comfyui;
  return c && typeof c === 'object' && Number.isFinite(Number(c.procs)) ? c : null;
}

/** the ports ComfyUI listens on that the hub can reach (not loopback-only), as numbers */
export function reachablePorts(c) {
  if (!c || !Array.isArray(c.listen)) return [];
  const out = [];
  for (const l of c.listen) {
    const p = Number(l?.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || LOOPBACK.test(String(l?.addr ?? ''))) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The port to probe: the configured one while ComfyUI listens on it (or nothing better is known), else
 * the --port of its command line when it listens there, else the lowest port it listens on.
 */
export function comfyPort(machineSnap, configured) {
  const ports = reachablePorts(comfyInfo(machineSnap));
  if (!ports.length || ports.includes(configured)) return configured;
  const cmd = Number(comfyInfo(machineSnap)?.cmd_port);
  if (ports.includes(cmd)) return cmd;
  return Math.min(...ports);
}

/** the explicit or default port of an http(s) URL */
export function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return null; }
}

/** `url` with its port replaced; a base URL keeps having no trailing slash */
export function withPort(url, port) {
  if (!port || portOf(url) === port) return url;
  const u = new URL(url);
  u.port = String(port);
  const s = u.toString();
  return /\/$/.test(url) ? s : s.replace(/\/$/, '');
}

/** the URL to probe for a ComfyUI server configured at `url`, on the machine whose snapshot is `machineSnap` */
export function followUrl(url, machineSnap) {
  return withPort(url, comfyPort(machineSnap, portOf(url)));
}
