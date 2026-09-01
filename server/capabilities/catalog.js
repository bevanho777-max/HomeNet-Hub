// Capability catalog — the single source of truth for "what can be monitored at a
// host, and how it becomes a persisted {target, card}". SECURITY CRITICAL.
//
// Two consumers, one table:
//   discovery.js  asks `suggestFor(finding)` — which capabilities the probe results
//                 support, and what each one would create;
//   POST /api/user_targets asks `materialize({host, capability, name})` — build it.
// Before this file owned both, the two lists were written separately and had already
// drifted: discovery suggested `http_check:443`, which the API then refused. A
// suggestion the API rejects is worse than no suggestion, and the only structural cure
// is that the preview a caller sees IS the thing that gets stored — `source_preview`
// is literally `materialize().target.source`, not a hand-written lookalike.
//
// The API deliberately does not accept a `source` from the client and never will: a
// target's source is what the scheduler executes, so a client-supplied one would turn
// "add this to my panel" into "run this for me". Everything stored is built here, from
// constants, out of a host that passed net_guard and a port from the bounded set.
import { checkPrivateIp } from '../net_guard.js';
import { PORT_BY_NUM, NODE_FAMILIES } from './ports.js';

// Both service capabilities produce the same two metrics, and every collector behind
// them reports the pair: exec/ping_host returns {status, latency_ms}; the http
// collector attaches status:'online' plus a measured latency_ms; tcp returns both.
const STATUS_MAP = { status: '$.status', latency: '$.latency_ms' };
const SERVICE_ITEMS = ['status', 'latency'];

/** target ids must satisfy targets.yaml's own ^[a-zA-Z0-9_]+$ pattern. */
const idOf = (host, cap, port) =>
  `u_${host.replace(/\./g, '_')}_${cap}${port ? `_${port}` : ''}`.replace(/[^a-zA-Z0-9_]/g, '_');

const svcCard = (id, title) => ({ type: 'service', target: id, title, items: [...SERVICE_ITEMS] });

// ── the catalog ─────────────────────────────────────────────────────
// entry = {
//   status:     'available' (a collector exists) | 'pending' (slice 2d+)
//   needsPort:  whether the capability id carries ":<port>"
//   acceptsPort(portEntry): which ports of the bounded set this capability may use
//   appliesTo(finding): concrete instances the probe results support -> [{port?, ctx}]
//   label(ctx), widget, requires
//   materialize({host, port, name}): available entries only — builds {id, target, card}
//   previewSource(host, port):       pending entries only — the intended shape, so the
//                                    UI can show what it would create without pretending
//                                    a collector exists
// }
const CAPABILITIES = {
  reachability: {
    status: 'available',
    needsPort: false,
    widget: 'service',
    requires: null,
    label: () => 'Reachability (ping)',
    // Always applicable: a host worth discovering is worth knowing the up/down of,
    // including one that answered nothing (that is precisely when it matters).
    appliesTo: () => [{}],
    materialize({ host, name }) {
      const id = idOf(host, 'reachability');
      return {
        id,
        target: {
          id,
          name: name || `${host} (ping)`,
          source: { type: 'exec', command: 'ping_host', args: [host], interval: '30s' },
          map: { ...STATUS_MAP },
        },
        card: svcCard(id, name || host),
      };
    },
  },

  port_check: {
    status: 'available',
    needsPort: true,
    widget: 'service',
    requires: null,
    acceptsPort: () => true,           // any port of the bounded set may be watched
    label: ({ portEntry, port }) => `Port ${port} (${portEntry?.port_hint || '?'})`,
    appliesTo: (f) => f.open.map((p) => ({ port: p.port, portEntry: p })),
    materialize({ host, port, name }) {
      const id = idOf(host, 'port_check', port);
      const hint = PORT_BY_NUM.get(port)?.port_hint;
      return {
        id,
        target: {
          id,
          name: name || `${host}:${port}${hint ? ` (${hint})` : ''}`,
          source: { type: 'tcp', host, port, interval: '10s', timeout: '3s' },
          map: { ...STATUS_MAP },
        },
        card: svcCard(id, name || `${host}:${port}`),
      };
    },
  },

  http_check: {
    status: 'available',
    needsPort: true,
    widget: 'service',
    requires: null,
    // Plaintext only. A TLS port would need the http collector to accept a self-signed
    // certificate, which it cannot — see discovery.js on why fetch was unusable for
    // exactly that reason. 443 is covered by tls_cert instead.
    acceptsPort: (p) => p.scheme === 'http',
    label: ({ port, service }) => `HTTP ${port}${service?.title ? ` — ${service.title}` : ''}`,
    appliesTo: (f) => f.open.filter((p) => p.scheme === 'http')
      .map((p) => ({ port: p.port, portEntry: p, service: f.services.find((s) => s.port === p.port) })),
    materialize({ host, port, name }) {
      const id = idOf(host, 'http_check', port);
      return {
        id,
        target: {
          id,
          name: name || `${host}:${port}`,
          source: { type: 'http', url: `http://${host}:${port}/`, interval: '8s', timeout: '3s' },
          map: { ...STATUS_MAP },
        },
        card: svcCard(id, name || `${host}:${port}`),
      };
    },
  },

  tls_cert: {
    status: 'available',
    needsPort: true,
    widget: 'info',
    requires: null,
    acceptsPort: (p) => !!p.tls,
    label: ({ port }) => `TLS certificate (:${port})`,
    // Only where a certificate actually came back. An open TLS port whose handshake
    // failed cannot be watched for expiry, so suggesting it would be a dead end.
    appliesTo: (f) => f.services.filter((s) => s.tls_expiry_days != null)
      .map((s) => ({ port: s.port, portEntry: PORT_BY_NUM.get(s.port), service: s })),
    materialize({ host, port, name }) {
      const id = idOf(host, 'tls_cert', port);
      return {
        id,
        target: {
          id,
          name: name || `${host}:${port} cert`,
          // Certificates change on the order of months; polling one every few seconds
          // would be a handshake per tick for a number that moves once a day.
          source: { type: 'tls', host, port, interval: '60m', timeout: '4s' },
          map: { expiry_days: '$.expiry_days' },
        },
        // An info card's items are {label, value} rows with {metric} placeholders —
        // renderInfo skips anything that is not an object, so the bare metric-key form
        // the other capabilities use would have produced a card with an empty body
        // that still validated and still polled. Checked against web/renderers/info.js.
        card: {
          type: 'info', target: id, title: name || `${host}:${port} cert`,
          items: [{ label: 'Expires in', value: '{expiry_days} days' }],
        },
      };
    },
  },
};

// Deep/pending capabilities: discovery still lists them so the operator can see what
// exists, but nothing can be built until their collector lands.
const PENDING = {
  node_cpu:  { family: 'node_cpu_seconds_total',            label: 'CPU (node_exporter)' },
  node_mem:  { family: 'node_memory_MemAvailable_bytes',    label: 'Memory (node_exporter)' },
  node_disk: { family: 'node_filesystem_avail_bytes',       label: 'Disk (node_exporter)' },
  node_net:  { family: 'node_network_receive_bytes_total',  label: 'Network (node_exporter)' },
};
const DEEP_METRICS = [['cpu', 'CPU'], ['mem', 'Memory'], ['disk', 'Disk']];

for (const [id, def] of Object.entries(PENDING)) {
  CAPABILITIES[id] = {
    status: 'pending',
    needsPort: false,
    widget: 'machine',
    requires: null,
    label: () => def.label,
    appliesTo: (f) => (f.nodeExporter?.metric_families || []).includes(def.family) ? [{}] : [],
    previewSource: (host) => ({
      type: 'prometheus', url: `http://${host}:9100/metrics`, metric_family: def.family,
    }),
  };
}
for (const transport of ['ssh', 'winrm']) {
  for (const [metric, label] of DEEP_METRICS) {
    CAPABILITIES[`${transport}_${metric}`] = {
      status: 'pending',
      needsPort: false,
      widget: 'machine',
      requires: transport,
      label: () => `${label} (via ${transport.toUpperCase()}, credentials required)`,
      // Offered on the transport the OS hint points at, when a login port is open.
      appliesTo: (f) => {
        const want = f.osHint === 'windows' ? 'winrm' : 'ssh';
        if (transport !== want) return [];
        const p = new Set(f.open.map((o) => o.port));
        return (p.has(22) || p.has(3389) || p.has(5985) || p.has(5986)) ? [{}] : [];
      },
      previewSource: (host) => ({ type: transport, host, metric }),
    };
  }
}

// ── suggestions (consumed by discovery.js) ──────────────────────────
/**
 * @param {{host:string, open:object[], services:object[], nodeExporter:object|null,
 *          osHint:string}} finding
 * @returns {object[]} suggested_capabilities
 */
export function suggestFor(finding) {
  const out = [];
  for (const [kind, entry] of Object.entries(CAPABILITIES)) {
    let instances = [];
    try { instances = entry.appliesTo(finding) || []; } catch { instances = []; }
    for (const inst of instances) {
      const port = inst.port ?? null;
      if (entry.needsPort && port == null) continue;
      const capId = entry.needsPort ? `${kind}:${port}` : kind;
      const available = entry.status === 'available';
      out.push({
        id: capId,
        label: entry.label({ ...inst, port, host: finding.host }),
        widget: entry.widget,
        requires: entry.requires,
        available,
        // The preview IS what gets stored — same function, same constants. For a
        // pending capability there is nothing to store yet, so its declared shape is
        // returned instead and `available:false` says so.
        source_preview: available
          ? entry.materialize({ host: finding.host, port }).target.source
          : entry.previewSource(finding.host, port),
      });
    }
  }
  return out;
}

// ── materialisation (consumed by the API) ───────────────────────────
/**
 * @returns {{ok:true, kind:string, port:number|null} | {ok:false, reason:string, pending?:boolean}}
 */
export function parseCapability(capId) {
  if (typeof capId !== 'string' || !capId) return { ok: false, reason: 'capability is required' };
  const [kind, portStr] = capId.split(':');
  const entry = CAPABILITIES[kind];
  if (!entry) return { ok: false, reason: `unknown capability "${capId}"` };
  if (entry.status !== 'available') {
    return { ok: false, pending: true, reason: `capability "${capId}" is not materializable yet (collector pending)` };
  }
  if (!entry.needsPort) {
    if (portStr !== undefined) return { ok: false, reason: `capability "${kind}" takes no port` };
    return { ok: true, kind, port: null };
  }
  if (portStr === undefined) return { ok: false, reason: `capability "${kind}" requires a port ("${kind}:80")` };
  if (!/^\d{1,5}$/.test(portStr)) return { ok: false, reason: `invalid port "${portStr}"` };
  const port = Number(portStr);
  const known = PORT_BY_NUM.get(port);
  // The bounded set is the whole point: without it this endpoint would write a target
  // that polls any port the caller names, on a schedule, forever.
  if (!known) return { ok: false, reason: `port ${port} is not in the known port set (add it to capabilities/ports.js first)` };
  if (!entry.acceptsPort(known)) {
    const why = kind === 'http_check' && known.scheme === 'https'
      ? `port ${port} is TLS — use tls_cert:${port}`
      : kind === 'tls_cert'
        ? `port ${port} (${known.port_hint}) is not a TLS port`
        : `port ${port} (${known.port_hint}) is not valid for ${kind}`;
    return { ok: false, reason: `${capId}: ${why}` };
  }
  return { ok: true, kind, port };
}

/**
 * Build the {target, card} pair. The host is re-validated here rather than trusted
 * from the caller — this function is the last thing before the database.
 * @returns {{ok:true, id, target, card} | {ok:false, reason, pending?}}
 */
export function materialize({ host, capability, name }) {
  const guard = checkPrivateIp(host);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const parsed = parseCapability(capability);
  if (!parsed.ok) return parsed;
  if (name != null && (typeof name !== 'string' || name.length > 60)) {
    return { ok: false, reason: 'name must be a string of at most 60 characters' };
  }
  const built = CAPABILITIES[parsed.kind].materialize({
    host: guard.ip, port: parsed.port, name: name || undefined,
  });
  // Provenance rides in the target doc so the list endpoint can answer "where did this
  // come from" without parsing it back out of the id. targets.yaml's schema allows
  // extra properties, publicConfig only ever emits a fixed field list, and the
  // scheduler reads source/map — so this is inert everywhere downstream.
  built.target._origin = {
    host: guard.ip, capability, kind: parsed.kind, port: parsed.port, added_at: new Date().toISOString(),
  };
  return { ok: true, ...built };
}

/** For the list endpoint: what a stored target came from. */
export function originOf(targetDoc) {
  const o = targetDoc?._origin;
  return o ? { host: o.host, capability: o.capability, added_at: o.added_at } : null;
}

export const CAPABILITY_IDS = Object.keys(CAPABILITIES);
export { NODE_FAMILIES };
