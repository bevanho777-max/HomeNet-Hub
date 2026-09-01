// The bounded port set — SECURITY CRITICAL, and the reason it lives in its own file.
//
// "Callers cannot name a port" is one of the two guarantees the discovery/materialise
// path rests on (the other is net_guard). Discovery needs the table to know what to
// probe; the capability catalog needs it to know what it may build a target for. Both
// importing the same constant is what makes the guarantee one fact instead of two
// copies that agree today. It sits here rather than in discovery.js because the
// catalog now feeds discovery's suggestions, and a table owned by either one of them
// would make that a cycle.
//
// `port_hint` is the CONVENTIONAL name of the port, not the product that answered:
// :3000 is labelled grafana and on this LAN it is Open WebUI. What actually runs there
// is in services[].title / services[].server. The field is named hint so nobody builds
// on it as an identification.
//
// `scheme` marks the ports worth an HTTP fingerprint; `tls` marks the ones whose
// certificate is worth reading.
export const DISCOVERY_PORTS = [
  { port: 22,    port_hint: 'ssh' },
  { port: 80,    port_hint: 'http',          scheme: 'http' },
  { port: 443,   port_hint: 'https',         scheme: 'https', tls: true },
  { port: 445,   port_hint: 'smb' },
  { port: 1883,  port_hint: 'mqtt' },
  { port: 3000,  port_hint: 'grafana',       scheme: 'http' },
  { port: 3306,  port_hint: 'mysql' },
  { port: 3389,  port_hint: 'rdp' },
  { port: 5000,  port_hint: 'dsm-http',      scheme: 'http' },
  { port: 5001,  port_hint: 'dsm-https',     scheme: 'https', tls: true },
  { port: 5432,  port_hint: 'postgres' },
  { port: 6379,  port_hint: 'redis' },
  { port: 8006,  port_hint: 'proxmox',       scheme: 'https', tls: true },
  { port: 9090,  port_hint: 'prometheus',    scheme: 'http' },
  { port: 9100,  port_hint: 'node_exporter', scheme: 'http' },
  { port: 32400, port_hint: 'plex',          scheme: 'http' },
];

export const PORT_BY_NUM = new Map(DISCOVERY_PORTS.map((p) => [p.port, p]));

/** Metric families a node_exporter must expose for the node_* capabilities. */
export const NODE_FAMILIES = [
  'node_cpu_seconds_total',
  'node_memory_MemAvailable_bytes',
  'node_filesystem_avail_bytes',
  'node_network_receive_bytes_total',
];
