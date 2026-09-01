// Capability catalog (slice 2b) — the ONE place that decides how a discovered
// capability becomes a persisted {target, card}. SECURITY CRITICAL.
//
// The API deliberately does not accept a `source` from the client, and never will:
// a target's source is what the scheduler executes, so a client-supplied one would
// turn "add this to my panel" into "run this for me". The client names a host and a
// capability id; everything that ends up in the database is built here, from
// constants, out of values that have been through net_guard and the bounded port set.
//
// discovery.js's suggested_capabilities and this catalog describe the same universe
// from two sides ("what could be added" vs "how to add it"). They are still two
// lists; §4 of the slice-2b notes covers folding them into one.
import { checkPrivateIp } from '../net_guard.js';
import { DISCOVERY_PORTS } from '../collectors/discovery.js';

// The bounded port set is imported, not re-declared — a second copy would let the two
// drift and this one is the security boundary ("no arbitrary ports").
const PORT_BY_NUM = new Map(DISCOVERY_PORTS.map((p) => [p.port, p]));

// Capability ids that discovery emits but no collector can serve yet. Named
// explicitly so the caller gets "pending", not "unknown" — the difference between
// "come back in slice 2c" and "you typed it wrong".
const PENDING_PREFIXES = ['port_check', 'tls_cert', 'node_', 'ssh_', 'winrm_'];

// Both capabilities produce the same two metrics, and both collectors already report
// them: exec/ping_host returns {status, latency_ms}, and the http collector attaches
// status:'online' plus a measured latency_ms to whatever the endpoint returned.
const STATUS_MAP = { status: '$.status', latency: '$.latency_ms' };
const SERVICE_ITEMS = ['status', 'latency'];

/** target ids must satisfy targets.yaml's own pattern. */
const idOf = (host, cap, port) =>
  `u_${host.replace(/\./g, '_')}_${cap}${port ? `_${port}` : ''}`.replace(/[^a-zA-Z0-9_]/g, '_');

const CAPABILITIES = {
  reachability: {
    needsPort: false,
    label: 'Reachability (ping)',
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
        card: {
          type: 'service', target: id, title: name || host, items: [...SERVICE_ITEMS],
        },
      };
    },
  },
  http_check: {
    needsPort: true,
    label: 'HTTP check',
    // Plaintext only this slice. A TLS port needs the http collector to accept a
    // self-signed certificate, which it cannot today — see discovery.js's note on why
    // fetch was unusable for exactly this reason. Refusing is honest; adding it with
    // verification on would produce a card that is permanently red on every LAN box.
    acceptsPort(p) { return p.scheme === 'http'; },
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
        card: {
          type: 'service', target: id, title: name || `${host}:${port}`, items: [...SERVICE_ITEMS],
        },
      };
    },
  },
};

/**
 * Parse a capability id into a catalog entry + port.
 * @returns {{ok:true, kind:string, port:number|null} | {ok:false, reason:string, pending?:boolean}}
 */
export function parseCapability(capId) {
  if (typeof capId !== 'string' || !capId) return { ok: false, reason: 'capability is required' };
  const [kind, portStr] = capId.split(':');
  const entry = CAPABILITIES[kind];
  if (!entry) {
    const pending = PENDING_PREFIXES.some((p) => kind.startsWith(p));
    return pending
      ? { ok: false, pending: true, reason: `capability "${capId}" is not materializable yet (collector pending)` }
      : { ok: false, reason: `unknown capability "${capId}"` };
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
  if (!known) {
    return { ok: false, reason: `port ${port} is not in the known port set (add it to discovery's table first)` };
  }
  if (!entry.acceptsPort(known)) {
    const why = known.scheme === 'https'
      ? 'https ports need a TLS-tolerant collector (slice 2c)'
      : `port ${port} (${known.port_hint}) is not an HTTP port`;
    return { ok: false, pending: known.scheme === 'https', reason: `${capId}: ${why}` };
  }
  return { ok: true, kind, port };
}

/**
 * Build the {target, card} pair for a capability. Host is re-validated here rather
 * than trusted from the caller — this function is the last thing before the database.
 * @returns {{ok:true, id:string, target:object, card:object} | {ok:false, reason:string, pending?:boolean}}
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
