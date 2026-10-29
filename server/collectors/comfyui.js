// comfyui.js (v2.32) — ComfyUI 节点 / ComfyUI Nodes: what each ComfyUI server is doing right
// now, and what it made today. Strictly read-only: GETs, and one WebSocket that only listens.
// Nothing here queues, cancels or changes anything on a ComfyUI server.
//
// Per node, every poll (2 s; one in flight, 1.5 s timeout, backoff up to 30 s while it does
// not answer -- the laptops sleep, m110 is switched off a lot):
//   GET /api/jobs?status=in_progress&limit=2   (~0.3 KB) the running job
//   GET /api/jobs?status=pending&limit=1       (~0.3 KB) pagination.total = jobs waiting
// When a job has ended (the running id changed), at the first answer after being unreachable,
// and every 5 minutes as a backstop:
//   GET /api/jobs?status=completed,failed&limit=N   (N = 200 the first time, 30 after)
//     -> the hub's own table comfy_jobs (node, id, status, start, end, images). ComfyUI keeps
//        its history in memory only, so today's count and the average time per image would
//        otherwise reset whenever ComfyUI restarts; the table also survives a hub restart.
// Every 60 s while the node answers: GET /system_stats (~1.4 KB): version, GPU, VRAM.
// /queue and /history are never read: both carry every job's whole workflow (/history is
// ~55 KB per image job on m110).
//
// Step progress ("step 12 / 30") comes from ComfyUI's own push: a WebSocket on /ws under the
// hub's own client id. ComfyUI sends `progress` only to the client that queued the job -- or
// to every client when the job was queued without a client id (API callers: scripts,
// comfyui-mcp). A job queued from someone's browser therefore shows its elapsed time but no
// step count, and the card says why. The socket is opened only while the node answers and
// re-opened with backoff; binary frames (previews) are dropped unread. Without it the 2-second
// poll above carries on alone.
//
// Elapsed time: ComfyUI does not say when a RUNNING job started (only finished jobs carry
// execution_start_time), so it counts from the first poll that saw the job running (at most
// one poll late), or from the socket's execution_start when that arrives. A job that was
// already running when the hub first reached the node is marked as a lower bound ("≥").
//
// Today = the Beijing calendar day the job FINISHED in. Images = a completed job's
// previewable outputs (outputs_count when that is missing); average time per image = the
// summed execution time of today's completed jobs / their images.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import http from 'node:http';

const BACKOFF_MAX_MS = 30000;
const SYSTEM_EVERY_MS = 60000;
const DONE_EVERY_MS = 300000;
const DONE_FIRST = 200;
const DONE_NEXT = 30;
const WS_RETRY_MIN_MS = 5000;
const WS_RETRY_MAX_MS = 120000;
const WS_MAX_FRAME = 16 * 1024 * 1024;   // a preview image is a few hundred KB; anything bigger is dropped with the socket
const KEEP_DAYS = 90;
const BJ_OFFSET_S = 8 * 3600;
const GIB = 1024 ** 3;

const int = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : null; };
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** start of the Beijing calendar day containing `ms`, in ms */
export function bjDayStart(ms = Date.now()) {
  const s = Math.floor(ms / 1000) + BJ_OFFSET_S;
  return (s - (s % 86400) - BJ_OFFSET_S) * 1000;
}

/** "cuda:0 NVIDIA GeForce RTX 5090 Laptop GPU : cudaMallocAsync" -> "RTX 5090 Laptop" */
export function gpuName(raw) {
  return String(raw || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\S+$/, '')
    .replace(/^NVIDIA\s+/, '').replace(/^GeForce\s+/, '').replace(/\s+GPU$/, '').trim() || null;
}

async function getJson(url, timeoutMs) {
  const t0 = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  return { body, ms: Date.now() - t0 };
}

/**
 * A listen-only WebSocket client (Node 20 has none built in, and the hub takes no dependency
 * for this): the HTTP upgrade, text frames (fragmented or not) to onMessage, pings answered,
 * binary frames dropped. It never sends anything else.
 */
export class WsListener {
  constructor(url, { onOpen, onMessage, onClose }) {
    this.url = new URL(url);
    this.onOpen = onOpen; this.onMessage = onMessage; this.onClose = onClose;
    this.socket = null; this.buf = Buffer.alloc(0); this.frag = null; this.done = false;
  }

  open() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: this.url.hostname, port: this.url.port || 80, path: this.url.pathname + this.url.search, timeout: 3000,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (res, socket, head) => {
      const want = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== want) { socket.destroy(); this._end('bad handshake'); return; }
      this.socket = socket;
      socket.setTimeout(0);
      socket.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this._parse(); });
      socket.on('close', () => this._end('closed'));
      socket.on('error', () => {});   // 'close' follows
      if (head?.length) this.buf = Buffer.from(head);
      this.onOpen?.();
      this._parse();
    });
    req.on('response', (res) => { res.resume(); this._end(`HTTP ${res.statusCode}`); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => this._end(e.message));
    req.end();
  }

  close() { if (this.socket) this.socket.destroy(); this._end('closed by hub'); }

  _end(why) {
    if (this.done) return;
    this.done = true;
    this.buf = Buffer.alloc(0); this.frag = null;
    this.onClose?.(why);
  }

  _parse() {
    while (!this.done && this.buf.length >= 2) {
      const b = this.buf;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6); off = 10; }
      if (len > WS_MAX_FRAME) { this.close(); return; }
      const mask = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._pong(payload); continue; }
      if (op === 0x1 || op === 0x2) {
        if (fin) { if (op === 0x1) this.onMessage?.(payload.toString('utf8')); this.frag = null; }
        else this.frag = { op, parts: [payload], size: payload.length };
      } else if (op === 0x0 && this.frag) {
        this.frag.parts.push(payload); this.frag.size += payload.length;
        if (this.frag.size > WS_MAX_FRAME) { this.close(); return; }
        if (fin) { const f = this.frag; this.frag = null; if (f.op === 0x1) this.onMessage?.(Buffer.concat(f.parts).toString('utf8')); }
      }
    }
  }

  // a client frame must be masked; a ping's payload is at most 125 bytes
  _pong(payload) {
    if (!this.socket || payload.length > 125) return;
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | body.length]), mask, body]));
  }
}

function freshState() {
  return {
    reachable: null, fails: 0, nextAt: 0, err: null, latency: null, seenAt: null,
    running: null,            // { id, since, exact }
    runningN: 0, pending: 0,
    system: null, systemAt: 0,
    doneAt: 0, doneSeeded: false, doneDirty: true,
    progress: null,           // { prompt_id, value, max, at } from the socket
    wsStart: null,            // { prompt_id, at } execution_start from the socket
    ws: null, wsState: 'off', wsFails: 0, wsNextAt: 0, wsErr: null,
  };
}

export class ComfyCollector {
  constructor(dbPath, { wsEnabled = true } = {}) {
    this.nodes = new Map();          // id -> { id, url, st }
    this.wsEnabled = wsEnabled;
    this.clientId = `homenet-hub-${crypto.randomBytes(6).toString('hex')}`;
    this.timeoutMs = 1500;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comfy_jobs (node TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL,
        start_ms INTEGER, end_ms INTEGER NOT NULL, images INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (node, id));
      CREATE INDEX IF NOT EXISTS comfy_jobs_end ON comfy_jobs (node, end_ms);
      CREATE TABLE IF NOT EXISTS comfy_meta (node TEXT PRIMARY KEY, first_ms INTEGER NOT NULL);
    `);
    this.db.prepare('DELETE FROM comfy_jobs WHERE end_ms < ?').run(Date.now() - KEEP_DAYS * 86400000);
    this._upsert = this.db.prepare(`INSERT INTO comfy_jobs (node, id, status, start_ms, end_ms, images) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (node, id) DO UPDATE SET status = excluded.status, start_ms = excluded.start_ms, end_ms = excluded.end_ms, images = excluded.images`);
    this._first = this.db.prepare('INSERT INTO comfy_meta (node, first_ms) VALUES (?, ?) ON CONFLICT (node) DO UPDATE SET first_ms = MIN(first_ms, excluded.first_ms)');
    this._firstGet = this.db.prepare('SELECT first_ms FROM comfy_meta WHERE node = ?');
    this._today = this.db.prepare(`SELECT
        SUM(status = 'completed') AS ok, SUM(status = 'failed') AS failed,
        SUM(CASE WHEN status = 'completed' THEN images ELSE 0 END) AS images,
        SUM(CASE WHEN status = 'completed' AND images > 0 AND start_ms IS NOT NULL THEN end_ms - start_ms ELSE 0 END) AS ms_timed,
        SUM(CASE WHEN status = 'completed' AND images > 0 AND start_ms IS NOT NULL THEN images ELSE 0 END) AS img_timed
      FROM comfy_jobs WHERE node = ? AND end_ms >= ?`);
    this._last = this.db.prepare(`SELECT start_ms, end_ms, images FROM comfy_jobs WHERE node = ? AND status = 'completed'
      ORDER BY end_ms DESC LIMIT 1`);
    this._hourly = this.db.prepare(`SELECT (end_ms / 3600000) * 3600000 AS h, SUM(status = 'completed') AS jobs,
        SUM(CASE WHEN status = 'completed' THEN images ELSE 0 END) AS images
      FROM comfy_jobs WHERE node = ? AND end_ms >= ? GROUP BY h ORDER BY h`);
  }

  configure(target, { timeoutMs = 1500 } = {}) {
    this.timeoutMs = timeoutMs;
    const next = new Map();
    for (const n of target?.nodes || []) {
      if (!n?.id || !n.url) continue;
      const url = String(n.url).replace(/\/+$/, '');
      const old = this.nodes.get(n.id);
      if (old && old.url === url) next.set(n.id, old);
      else { if (old) this._closeWs(old); next.set(n.id, { id: n.id, url, st: freshState() }); }
    }
    for (const [id, n] of this.nodes) if (!next.has(id)) this._closeWs(n);
    this.nodes = next;
  }

  has(id) { return this.nodes.has(id); }

  stop() { for (const n of this.nodes.values()) this._closeWs(n); }

  async poll() {
    const now = Date.now();
    await Promise.all([...this.nodes.values()].map((n) => this._pollNode(n, now)));
    return this.view();
  }

  async _pollNode(n, now) {
    const st = n.st;
    if (now < st.nextAt) return;
    try {
      const [run, pend] = await Promise.all([
        getJson(`${n.url}/api/jobs?status=in_progress&limit=2`, this.timeoutMs),
        getJson(`${n.url}/api/jobs?status=pending&limit=1`, this.timeoutMs),
      ]);
      const wasUp = st.reachable === true;
      st.reachable = true; st.fails = 0; st.nextAt = 0; st.err = null; st.seenAt = now;
      st.latency = Math.max(run.ms, pend.ms);
      const job = (run.body?.jobs || [])[0] || null;
      const prevId = st.running?.id || null;
      if (job?.id && job.id !== prevId) {
        const ws = st.wsStart?.prompt_id === job.id ? st.wsStart.at : null;
        st.running = { id: job.id, since: ws || now, exact: !!ws || wasUp };
      } else if (!job) st.running = null;
      if (prevId && prevId !== (job?.id || null)) st.doneDirty = true;   // a job ended
      st.runningN = int(run.body?.pagination?.total) ?? (run.body?.jobs || []).length;
      st.pending = int(pend.body?.pagination?.total) ?? 0;
      if (st.progress && st.progress.prompt_id !== st.running?.id) st.progress = null;
      if (!wasUp) { st.doneDirty = true; st.systemAt = 0; }
      // the slower reads ride on the same tick; a failure there does not make the node "down"
      if (now - st.systemAt >= SYSTEM_EVERY_MS) await this._system(n, now);
      if (st.doneDirty || now - st.doneAt >= DONE_EVERY_MS) await this._done(n, now);
      this._ensureWs(n, now);
    } catch (e) {
      st.fails += 1;
      st.reachable = false;
      st.err = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code || e?.message || e);
      st.nextAt = now + Math.min(BACKOFF_MAX_MS, 2000 * 2 ** Math.min(4, st.fails - 1));
      st.running = null; st.runningN = 0; st.pending = 0; st.progress = null;
      this._closeWs(n);
    }
  }

  async _system(n, now) {
    try {
      const { body } = await getJson(`${n.url}/system_stats`, 3000);
      const dev = (body?.devices || [])[0] || {};
      const total = Number(dev.vram_total), free = Number(dev.vram_free);
      n.st.system = {
        version: body?.system?.comfyui_version || null,
        gpu: gpuName(dev.name),
        vram_total_gb: Number.isFinite(total) && total > 0 ? round1(total / GIB) : null,
        vram_used_gb: Number.isFinite(total) && Number.isFinite(free) && total > 0 ? round1((total - free) / GIB) : null,
      };
    } catch { /* keep the last reading */ }
    n.st.systemAt = now;
  }

  async _done(n, now) {
    const st = n.st;
    try {
      const limit = st.doneSeeded ? DONE_NEXT : DONE_FIRST;
      const { body } = await getJson(`${n.url}/api/jobs?status=completed,failed&limit=${limit}&sort_order=desc`, 5000);
      const rows = (body?.jobs || []).filter((j) => j?.id && Number(j.execution_end_time) > 0 && (j.status === 'completed' || j.status === 'failed'));
      const tx = this.db.transaction((list) => {
        for (const j of list) {
          const images = j.status === 'completed' ? (int(j.previewable_outputs_count ?? j.outputs_count) || 0) : 0;
          this._upsert.run(n.id, String(j.id), j.status, int(j.execution_start_time), int(j.execution_end_time), images);
        }
      });
      tx(rows);
      if (!st.doneSeeded) {
        // charts zero-fill only from here on: before this the hub knows nothing either way
        const first = Math.min(now, ...rows.map((j) => int(j.execution_end_time)).filter((x) => x != null));
        this._first.run(n.id, first);
      }
      st.doneSeeded = true;
      st.doneDirty = false;
    } catch { /* try again next tick (doneDirty stays) or at the backstop */ }
    st.doneAt = now;
  }

  _ensureWs(n, now) {
    const st = n.st;
    if (!this.wsEnabled || st.ws || now < st.wsNextAt) return;
    st.wsState = 'connecting';
    const ws = new WsListener(`${n.url.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`, {
      onOpen: () => { st.wsState = 'open'; st.wsFails = 0; st.wsErr = null; },
      onMessage: (txt) => this._onWs(n, txt),
      onClose: (why) => {
        if (st.ws !== ws) return;
        st.ws = null;
        st.wsState = 'off';
        st.wsErr = why;
        st.wsFails += 1;
        st.wsNextAt = Date.now() + Math.min(WS_RETRY_MAX_MS, WS_RETRY_MIN_MS * 2 ** Math.min(5, st.wsFails - 1));
      },
    });
    st.ws = ws;
    ws.open();
  }

  _closeWs(n) {
    const ws = n.st.ws;
    if (!ws) return;
    n.st.ws = null;
    n.st.wsState = 'off';
    ws.close();
  }

  _onWs(n, txt) {
    let m;
    try { m = JSON.parse(txt); } catch { return; }
    const st = n.st, d = m?.data || {};
    if (m?.type === 'progress' && d.prompt_id) {
      st.progress = { prompt_id: d.prompt_id, value: int(d.value), max: int(d.max), at: Date.now() };
    } else if (m?.type === 'progress_state' && d.prompt_id && d.nodes && typeof d.nodes === 'object') {
      const cur = Object.values(d.nodes).find((x) => x?.state === 'running');
      if (cur && Number(cur.max) > 1) st.progress = { prompt_id: d.prompt_id, value: int(cur.value), max: int(cur.max), at: Date.now() };
    } else if (m?.type === 'execution_start' && d.prompt_id) {
      const at = int(d.timestamp) || Date.now();
      st.wsStart = { prompt_id: d.prompt_id, at };
      if (st.running?.id === d.prompt_id) { st.running.since = at; st.running.exact = true; }
    } else if (m?.type === 'executing' && d.node == null && d.prompt_id) {
      if (st.progress?.prompt_id === d.prompt_id) st.progress = null;
      st.nextAt = 0;
    } else if (m?.type === 'status') {
      st.nextAt = 0;   // the queue moved: let the next tick read it rather than wait out a backoff
    }
  }

  /** today's figures and the last finished image job, from the hub's own table */
  _stats(id, day0) {
    const r = this._today.get(id, day0) || {};
    const last = this._last.get(id);
    const images = Number(r.images) || 0, timed = Number(r.img_timed) || 0;
    return {
      today: {
        images, jobs: Number(r.ok) || 0, failed: Number(r.failed) || 0,
        avg_s: timed > 0 ? round1(Number(r.ms_timed) / timed / 1000) : null,
      },
      last: last ? {
        at: last.end_ms, images: last.images,
        secs: last.start_ms != null ? round1((last.end_ms - last.start_ms) / 1000) : null,
      } : null,
    };
  }

  view() {
    const now = Date.now(), day0 = bjDayStart(now);
    const nodes = {};
    for (const [id, n] of this.nodes) {
      const st = n.st;
      const run = st.reachable === true && st.running ? st.running : null;
      const prog = run && st.progress?.prompt_id === run.id ? st.progress : null;
      nodes[id] = {
        reachable: st.reachable === true,
        checked: st.reachable !== null,
        error: st.err,
        latency_ms: st.reachable === true ? st.latency : null,
        seen_at: st.seenAt,
        running: st.reachable === true ? st.runningN : null,
        pending: st.reachable === true ? st.pending : null,
        job: run ? {
          id: run.id, elapsed_s: Math.max(0, Math.round((now - run.since) / 1000)), exact: run.exact,
          step: prog?.value ?? null, steps: prog?.max ?? null,
        } : null,
        system: st.system,
        ws: st.wsState,
        ...this._stats(id, day0),
      };
    }
    return { at: now, day_start: day0, nodes };
  }

  /** queue samples for the column modal (the store keeps one per 5 s per series) */
  historyRows(targetId, view) {
    const rows = [];
    for (const [id, n] of Object.entries(view.nodes || {})) {
      if (!n.reachable) continue;
      rows.push([targetId, `${id}_running`, n.running ?? 0]);
      rows.push([targetId, `${id}_pending`, n.pending ?? 0]);
    }
    return rows;
  }

  /**
   * Completed jobs and images per hour since `sinceMs`, in /api/history's series shape. Hours
   * with nothing are 0 -- but only from when the hub first read this node's job list; before
   * that it does not know, and draws nothing.
   */
  hourly(id, sinceMs) {
    const first = this._firstGet.get(id)?.first_ms;
    const now = Date.now();
    const out = { [`${id}_images_h`]: [], [`${id}_jobs_h`]: [] };
    if (first == null) return out;
    const by = new Map(this._hourly.all(id, sinceMs).map((r) => [Number(r.h), r]));
    const H = 3600000;
    for (let h = Math.floor(Math.max(sinceMs, first) / H) * H; h <= now; h += H) {
      const r = by.get(h);
      out[`${id}_images_h`].push({ ts: h / 1000, value: Number(r?.images) || 0 });
      out[`${id}_jobs_h`].push({ ts: h / 1000, value: Number(r?.jobs) || 0 });
    }
    return out;
  }
}
