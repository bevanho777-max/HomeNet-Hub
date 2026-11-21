// endpoints.js (v2.50) — the host:port set a node's LiteLLM rows are matched on (inference_nodes `endpoints` /
// `embed_endpoints`). An entry "192.168.1.110:*" takes every port of that host: m110 / m136 run whatever engine on
// whatever port (BACKLOG 64), and litellm 4003 / 4004 keep their configured backend port -- a request is that
// machine's either way. Exact entries behave as before. Used wherever a Set of endpoints was (`has`, `size`).
export class EndpointSet extends Set {
  constructor(list = []) {
    const exact = [], hosts = [];
    for (const e of list || []) {
      const s = String(e);
      if (s.endsWith(':*')) hosts.push(s.slice(0, -2)); else exact.push(s);
    }
    super(exact);
    this.hosts = new Set(hosts);
  }

  has(at) {
    if (super.has(at)) return true;
    if (!this.hosts.size || at == null) return false;
    const s = String(at), i = s.lastIndexOf(':');
    return i > 0 && this.hosts.has(s.slice(0, i));
  }

  get size() { return super.size + (this.hosts ? this.hosts.size : 0); }
}
