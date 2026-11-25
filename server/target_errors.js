// v2.52 「hub 监测项错误」 (BACKLOG 69): which of the hub's own monitored items are in an error state right now,
// since when, and why -- GET /api/target-errors, read by health-lite (its 「Hub-target-errors」 layer alerts on
// any error that has lasted more than an hour).
//
// Why: the 搬瓦工 VPS card showed 「API 错误」 (KiwiVM 700005 Authentication failure) from 2026-11-24 15:19 to
// 11-25 20:05, 29 hours, and nothing told anybody -- the card kept its last good figures, so the item even stayed
// "online".
//
// What counts (each item: id, name, kind, error, since):
//   offline  a target the hub cannot read (its snapshot entry is offline with an error: API / HTTP error,
//            authentication, parse failure, refused connection ...), since the offline spell began;
//   api      the KiwiVM card's API errors (the card stays online on its last good data), since the first failed
//            poll of the run (kept in the database across restarts);
//   push     pushes refused for a wrong host (the card's 「Push from unexpected host」), since the first refusal;
//   route    a litellm instance the nodes card cannot read routes from (/model/info, /router/settings);
//   counter  an inference node whose engine answers while its Prometheus counter cannot be read or stopped
//            (the scrape is down / missing), since its last sample;
//   config   a config reload the hub refused (it keeps running the previous config).
// What does not (the board's own rules -- these are states, not errors):
//   - a machine that is off / not booted: a push target that stopped pushing, and every service on a machine
//     whose agent is not pushing (the machine is the target's `machine`, its `source.node`, or the push target
//     whose agent pushes from the service URL's address);
//   - a service that runs only when it is opened (always_on: false -- m110 / m136 ComfyUI or LLM, the m133
//     laptop's Strata) and is not running or not reachable: a connection failure there is 「未运行」 or
//     「连线中断」 on the board, and whether such a service is reachable from the hub is Bevan's own setting
//     (CLAUDE.md, 2026-11-25). Any OTHER error on it (an HTTP error, authentication, a bad answer) still counts;
//   - 测试中 (Bevan's test Strata instance listening while the resident one is off).
// An error without a start time of its own is timed from when this hub first saw it (a restart starts it over).
import { machineUp, testingPorts } from '../web/renderers/node_state.js';

// a failure to reach something at all (nothing answered): the only kind a machine that is off, or a service
// that is not running, produces
export const CONN_RE = /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|unreachable|no push|fetch failed|aborted|AbortError|other side closed|UND_ERR|connect/i;
const PUSH_TYPES = new Set(['http_push', 'push']);
const PUSH_ALERT_LIVE_MS = 10 * 60 * 1000;   // a refusal within the last 10 minutes: the pushes are still refused
const COUNTER_WHY = { down: '抓取失败', missing: 'Prometheus 没有这个抓取目标', read: 'Prometheus 读不到' };

function hostOfUrl(u) {
  try { return new URL(String(u)).hostname; } catch { return null; }
}

const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export class TargetErrors {
  constructor() {
    this.first = new Map();      // item key -> when this hub first saw it (ms), for errors with no start time
  }

  /**
   * @param targets   the enabled targets of the effective config
   * @param snap      snapshot.toJSON() of (at least) every target and machine id
   * @param bindings  push_bindings rows ({ target, ip }) -- which machine pushes from which address
   * @param alerts    Map target -> push alert ({ ip, hostname, at, first, count }), as /api/snapshot shows
   * @param configError  ConfigStore.lastError ({ at, errors[] }) or null
   */
  compute({ targets = [], snap = {}, bindings = [], alerts = new Map(), configError = null, now = Date.now() } = {}) {
    const byId = new Map(targets.map((t) => [t.id, t]));
    const ipMachine = new Map();
    for (const b of bindings || []) if (b?.ip && b?.target && byId.has(b.target)) ipMachine.set(String(b.ip), b.target);
    const machineOf = (t) => {
      if (t.machine && byId.has(t.machine)) return t.machine;
      const node = t.source?.node;
      if (node && byId.has(node) && PUSH_TYPES.has(byId.get(node).source?.type)) return node;
      const h = hostOfUrl(t.source?.url || t.source?.base);
      return (h && ipMachine.get(h)) || null;
    };
    const items = [], excluded = [];
    const add = (it) => items.push(it);

    for (const t of targets) {
      const s = snap[t.id];
      const type = t.source?.type;
      const name = t.name || t.id;
      if (PUSH_TYPES.has(type)) {
        // a machine that stopped pushing is off (not an error); pushes from the wrong host are
        const a = alerts.get(t.id);
        if (a && now - Number(a.at) <= PUSH_ALERT_LIVE_MS) {
          add({ key: `${t.id}|push`, id: t.id, name, kind: 'push',
            error: `拒收来自 ${a.ip}(${a.hostname || '?'})的推送(主机不符),共 ${a.count} 次`, since: Number(a.first) || null });
        } else if (s && s.online === false) excluded.push({ id: t.id, why: '机器没在推送(关机 / 未开机)' });
        continue;
      }
      if (!s) continue;
      if (s.online === false && s.error) {
        const mId = machineOf(t);
        const m = mId ? snap[mId] : null;
        const conn = CONN_RE.test(String(s.error));
        if (mId && !machineUp(m)) excluded.push({ id: t.id, why: `${mId} 关机 / 未开机` });
        else if (t.always_on === false && conn) excluded.push({ id: t.id, why: '随用随开,没在运行 / 连不上' });
        else if (mId && testingPorts(m).length) excluded.push({ id: t.id, why: `${mId} 测试中` });
        else add({ key: `${t.id}|offline`, id: t.id, name, kind: 'offline', error: short(s.error), since: Number(s.since) || null });
      }
      if (type === 'kiwivm') {
        const a = s.extra?.vps?.api;
        if (a && a.ok === false) {
          add({ key: `${t.id}|api`, id: t.id, name, kind: 'api', error: short(a.err), since: Number(a.err_since || a.err_at) || null });
        }
      }
      if (type === 'inference_nodes') {
        for (const r of s.extra?.route_errors || []) {
          add({ key: `${t.id}|route|${r.port}`, id: t.id, name, kind: 'route', error: `litellm :${r.port} 读不到路由:${short(r.error, 160)}`, since: null });
        }
        for (const [node, n] of Object.entries(s.extra?.nodes || {})) {
          const mt = byId.get(node);
          if (mt && PUSH_TYPES.has(mt.source?.type) && !machineUp(snap[node])) continue;   // the machine is off
          const onDemand = mt?.always_on === false;
          const probs = new Map();          // problem text -> { kinds[], since }
          for (const [kind, k] of Object.entries(n?.counters?.kinds || {})) {
            let text = null, since = null, detail = '';
            if (k?.error) { detail = k.error.detail || ''; text = `计数器读不到:${short(detail, 140)}`; }
            else if (k?.mark?.code === 'stale' && COUNTER_WHY[k.mark.why]) {
              detail = k.mark.detail || '';
              text = `计数器停更(${COUNTER_WHY[k.mark.why]}${detail ? ':' + short(detail, 140) : ''})`;
              since = k.mark.since ? Number(k.mark.since) * 1000 : null;
              if (onDemand && (k.mark.why === 'missing' || CONN_RE.test(detail))) text = null;
            }
            if (!text) continue;
            const p = probs.get(text) || { kinds: [], since: null };
            p.kinds.push(kind);
            if (since && (!p.since || since < p.since)) p.since = since;
            probs.set(text, p);
          }
          for (const [text, p] of probs) {
            add({ key: `${t.id}|counter|${node}|${text}`, id: t.id, name: `${name} · ${node}`, kind: 'counter',
              error: `${node} ${text}(${p.kinds.join(' / ')})`, since: p.since });
          }
        }
      }
    }
    if (configError && Array.isArray(configError.errors) && configError.errors.length) {
      const n = configError.errors.length;
      add({ key: 'config|config', id: 'config', name: '配置', kind: 'config',
        error: `配置重载被拒,沿用上一版:${short(configError.errors[0], 160)}${n > 1 ? ` 等 ${n} 项` : ''}`,
        since: null, seen: Date.parse(configError.at) || null });
    }

    // start times: the item's own, else when this hub first saw it
    const live = new Set();
    for (const it of items) {
      live.add(it.key);
      if (!this.first.has(it.key)) this.first.set(it.key, Math.min(now, it.seen || now));
      if (!it.since) it.since = this.first.get(it.key);
      delete it.seen;
      it.duration_s = Math.max(0, Math.round((now - it.since) / 1000));
    }
    for (const k of [...this.first.keys()]) if (!live.has(k)) this.first.delete(k);
    items.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
    return { at: now, items: items.map(({ key, ...it }) => it), excluded };
  }
}
