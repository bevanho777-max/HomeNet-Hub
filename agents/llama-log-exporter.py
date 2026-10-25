#!/usr/bin/env python3
"""HomeNet llama-server log exporter -- request (and embedding token) counters that
llama.cpp's own /metrics does not have.

llama.cpp exposes prompt/generated token counters but NO request counter, and an
--embedding server counts nothing at all. Every finished task does write one line,
though:

    slot      release: id  0 | task 4198 | stop processing: n_tokens = 9, truncated = 0

This follows the systemd journal of the given units (read-only: the inference servers
are never touched), counts those lines and serves Prometheus text on a port:

    homenet_llama_requests_total{unit="llama-qwen38"}      finished tasks
    homenet_llama_tokens_total{unit="mxbai-embed"}         sum of n_tokens (embedding units only)
    homenet_llama_invocation_start_seconds{unit="..."}     when the counted server started

Counter lifetime = the server's lifetime. On start the exporter replays the journal from
each unit's CURRENT invocation, so restarting the exporter loses nothing; when a unit
restarts (new systemd invocation id) its counters go back to 0, exactly like a real
in-process counter -- the hub's reset-aware sum handles that. For an embedding server
n_tokens is the input length; for a chat server it is the whole context (prompt + cache +
output), so it is NOT exported as usage there -- use llama.cpp's own token counters.

usage: llama-log-exporter.py --port 9877 --unit llama-qwen38.service --unit mxbai-embed.service:embed
       (full unit names, as the journal records them in _SYSTEMD_UNIT)
       (":embed" marks a unit whose n_tokens are counted as tokens)
Stdlib only. Needs to read the journal: run as a user in group systemd-journal.

v2.29 -- for a machine whose llama-server listens on 127.0.0.1 only, behind some other
service on the public port (m25: a gateway on :8080, llama-server on 127.0.0.1:18081):

  --unit auto      count the units that run a llama-server RIGHT NOW (found in /proc,
                   checked every 15 s, so a new unit or a restart elsewhere is followed);
                   a server started with --embedding counts its tokens. In this mode every
                   series also carries role="chat" | "embed", so a selector need not name
                   the unit. (Static --unit output is unchanged: no role label.)
  --mirror PORT    also serve a READ-ONLY mirror of the local chat llama-server on PORT,
                   for the hub's live view and for Prometheus:
                     /health /v1/models           as the server answers them
                     /metrics                     the server's, + homenet_llama_process_start_seconds
                     /slots                       numbers only -- no prompt, no parameter text
                     /props                       slot count, alias, build, context size
                   GET only; anything else is 404. The upstream is the newest chat
                   llama-server in /proc (its --host/--port and --api-key / --api-key-file,
                   re-read every 15 s): a restart on another port or with a new key is
                   followed without touching this service. The key never leaves the machine.
  --allow IP       answer only these client addresses (repeatable; default: anyone)

  e.g. llama-log-exporter.py --port 9877 --unit auto --mirror 9878 --allow 192.168.1.24
  (the mirror needs to read the server's key file: run it as the user that owns it)
"""
import argparse
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RELEASE = re.compile(r'slot\s+release:.*\| task (\d+) \| stop processing: n_tokens = (\d+)')
DISCOVER_EVERY = 15
UPSTREAM_TIMEOUT = 3

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=9877)
ap.add_argument('--bind', default='0.0.0.0')
ap.add_argument('--unit', action='append', required=True)
ap.add_argument('--mirror', type=int, default=0)
ap.add_argument('--allow', action='append', default=[])
args = ap.parse_args()

AUTO = args.unit == ['auto']
ALLOW = set(args.allow) | ({'127.0.0.1'} if args.allow else set())


def static_units():
    out = {}
    for spec in args.unit:
        name, _, kind = spec.partition(':')
        out[name] = kind == 'embed'
    return out


UNITS = {}                       # unit -> {embed, inv, start, requests, tokens}
LOCK = threading.Lock()
STATE = {'lines': 0, 'started': time.time(), 'follower_restarts': 0, 'replayed': 0, 'rescans': 0}
CHANGED = threading.Event()      # (auto) the set of llama-server units changed: replay again
CUR = {'proc': None, 'units': None}


# ── local llama-server processes ────────────────────────────────────
def _btime():
    with open('/proc/stat') as f:
        for line in f:
            if line.startswith('btime '):
                return int(line.split()[1])
    return 0


BOOT = _btime()
HZ = os.sysconf('SC_CLK_TCK')
VALUE_OPTS = {'--host', '--port', '--api-key', '--api-key-file', '--alias', '-a', '--parallel', '-np'}


def _opts(argv):
    o, i = {}, 1
    while i < len(argv):
        a = argv[i]
        if a.startswith('--') and '=' in a:
            k, v = a.split('=', 1)
            o[k] = v
        elif a in VALUE_OPTS and i + 1 < len(argv):
            o[a] = argv[i + 1]
            i += 1
        else:
            o[a] = True
        i += 1
    return o


def _unit_of(pid):
    try:
        with open(f'/proc/{pid}/cgroup') as f:
            for line in f:
                for part in reversed(line.strip().split(':', 2)[-1].split('/')):
                    if part.endswith('.service'):
                        return part
    except OSError:
        pass
    return None


def llama_servers():
    """Running llama-server processes, newest first."""
    out = []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open(f'/proc/{d}/cmdline', 'rb') as f:
                argv = [a.decode(errors='replace') for a in f.read().split(b'\0') if a]
            if not argv or os.path.basename(argv[0]) != 'llama-server':
                continue
            with open(f'/proc/{d}/stat') as f:
                start = BOOT + int(f.read().rsplit(')', 1)[1].split()[19]) / HZ
        except (OSError, ValueError, IndexError):
            continue
        env = {}
        try:
            with open(f'/proc/{d}/environ', 'rb') as f:
                env = dict(x.decode(errors='replace').split('=', 1) for x in f.read().split(b'\0') if b'=' in x)
        except OSError:
            pass              # another user's process: its environment is not ours to read
        o = _opts(argv)
        host = str(o.get('--host') or env.get('LLAMA_ARG_HOST') or '127.0.0.1')
        out.append({
            'pid': int(d), 'start': start, 'unit': _unit_of(d),
            'host': '127.0.0.1' if host in ('0.0.0.0', '::', '') else host,
            'port': int(o.get('--port') or env.get('LLAMA_ARG_PORT') or 8080),
            'key': o.get('--api-key') if isinstance(o.get('--api-key'), str) else env.get('LLAMA_API_KEY'),
            'key_file': o.get('--api-key-file') if isinstance(o.get('--api-key-file'), str) else None,
            'embed': bool(o.get('--embedding') or o.get('--embeddings') or env.get('LLAMA_ARG_EMBEDDINGS')),
            'alias': o.get('--alias') if isinstance(o.get('--alias'), str) else (o.get('-a') if isinstance(o.get('-a'), str) else ''),
        })
    return sorted(out, key=lambda s: -s['start'])


def wanted():
    """unit -> counts tokens (embedding): static from --unit, or (auto) from /proc"""
    if not AUTO:
        return static_units()
    out = {}
    for s in llama_servers():
        if s['unit']:
            out[s['unit']] = out.get(s['unit'], False) or s['embed']
    return out


# ── journal counters ────────────────────────────────────────────────
def show(unit, prop, *extra):
    return subprocess.run(['systemctl', 'show', unit, '-p', prop, '--value', *extra],
                          capture_output=True, text=True).stdout.strip()


def unit_start(unit):
    """when the unit's current run began (unix seconds), or 0 when systemd will not say"""
    v = show(unit, 'ActiveEnterTimestamp', '--timestamp=unix').lstrip('@')
    try:
        return float(v)
    except ValueError:
        return 0.0


GREP = '+PCRE2' in subprocess.run(['journalctl', '--version'], capture_output=True, text=True).stdout
OLD_INVOCATIONS = set()         # invocation ids known to be older than the unit's current one


def journal(units, extra):
    # only the release lines when journalctl can filter (a verbose server writes ~10^5
    # other lines a day; the replay would read them all)
    cmd = ['journalctl', '-o', 'json', '--no-pager'] + (['-g', r'slot\s+release'] if GREP else []) + extra
    for u in units:
        cmd += ['-u', u]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1)


def apply(e, units):
    """Count one journal entry into `units` (a dict shaped like UNITS)."""
    u = e.get('_SYSTEMD_UNIT', '')
    st = units.get(u)
    if st is None:
        return
    inv = e.get('_SYSTEMD_INVOCATION_ID')
    if inv and inv != st['inv']:
        if inv in OLD_INVOCATIONS:
            return
        if inv == show(u, 'InvocationID'):
            # the unit restarted while we were following: its counters start again at 0
            st.update(inv=inv, requests=0, tokens=0, start=unit_start(u))
        else:
            OLD_INVOCATIONS.add(inv)                 # an earlier run of the unit, this boot
            return
    if not st['start']:
        st['start'] = int(e.get('__REALTIME_TIMESTAMP', '0')) / 1e6
    msg = e.get('MESSAGE', '')
    if isinstance(msg, list):
        msg = bytes(msg).decode(errors='replace')
    m = RELEASE.search(msg)
    if m:
        st['requests'] += 1
        if st['embed']:
            st['tokens'] += int(m.group(2))


def follow():
    while True:
        want = wanted()
        CHANGED.clear()
        CUR['units'] = want
        # 1. Replay this boot's journal into a private copy, then swap it in at once. The
        #    counters are never visible half-replayed: a scrape mid-replay would see a value
        #    lower than before and the hub would treat it as a server restart.
        fresh = {u: {'embed': embed, 'inv': show(u, 'InvocationID') or None, 'start': unit_start(u), 'requests': 0, 'tokens': 0}
                 for u, embed in want.items()}
        cursor = None
        if want:
            p = journal(want, ['-b'])
            for line in p.stdout:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                apply(e, fresh)
                cursor = e.get('__CURSOR', cursor)
                STATE['lines'] += 1
            p.wait()
        with LOCK:
            UNITS.clear()
            UNITS.update(fresh)
            STATE['replayed'] = 1
        if want and AUTO:
            print('counting ' + ', '.join(u + (' (embed)' if e else '') for u, e in want.items()), flush=True)
        # 2. Follow from where the replay stopped; if journalctl ever exits, resume from the
        #    last cursor -- never replay again, so nothing is counted twice. (auto: a change
        #    of units kills the follower and starts over at 1.)
        while not CHANGED.is_set():
            if not want:
                CHANGED.wait(DISCOVER_EVERY)
                continue
            p = journal(want, ['-f'] + (['--after-cursor', cursor] if cursor else ['-n', '0']))
            CUR['proc'] = p
            try:
                for line in p.stdout:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    with LOCK:
                        apply(e, UNITS)
                        STATE['lines'] += 1
                    cursor = e.get('__CURSOR', cursor)
            finally:
                p.kill()
                CUR['proc'] = None
            if CHANGED.is_set():
                break
            with LOCK:
                STATE['follower_restarts'] += 1
            time.sleep(2)


def watch_units():
    while True:
        time.sleep(DISCOVER_EVERY)
        STATE['rescans'] += 1
        if wanted() != CUR['units']:
            CHANGED.set()
            p = CUR['proc']
            if p:
                p.kill()


class Quiet(BaseHTTPRequestHandler):
    HEADERS = {}

    def allowed(self):
        if ALLOW and self.client_address[0] not in ALLOW:
            self.send_error(403)
            return False
        return True

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in self.HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class H(Quiet):
    def do_GET(self):
        if not self.allowed():
            return
        if self.path not in ('/metrics', '/'):
            self.send_error(404)
            return
        lbl = (lambda u, s: f'unit="{u}",role="{"embed" if s["embed"] else "chat"}"') if AUTO else (lambda u, s: f'unit="{u}"')
        with LOCK:
            if not STATE['replayed']:
                # Not ready: report nothing rather than a partial count.
                self.send_error(503, 'replaying journal')
                return
            out = ['# HELP homenet_llama_requests_total Finished llama-server tasks (one "slot release" log line each).',
                   '# TYPE homenet_llama_requests_total counter']
            out += [f'homenet_llama_requests_total{{{lbl(u, s)}}} {s["requests"]}' for u, s in UNITS.items()]
            out += ['# HELP homenet_llama_tokens_total Embedding input tokens (n_tokens of each finished task).',
                    '# TYPE homenet_llama_tokens_total counter']
            out += [f'homenet_llama_tokens_total{{{lbl(u, s)}}} {s["tokens"]}' for u, s in UNITS.items() if s['embed']]
            out += ['# TYPE homenet_llama_invocation_start_seconds gauge']
            out += [f'homenet_llama_invocation_start_seconds{{{lbl(u, s)}}} {s["start"]:.3f}' for u, s in UNITS.items()]
            out += ['# TYPE homenet_llama_exporter_lines_total counter', f'homenet_llama_exporter_lines_total {STATE["lines"]}',
                    '# TYPE homenet_llama_exporter_follower_restarts_total counter',
                    f'homenet_llama_exporter_follower_restarts_total {STATE["follower_restarts"]}']
        self.send(200, ('\n'.join(out) + '\n').encode(), 'text/plain; version=0.0.4')


# ── read-only mirror of the local llama-server ──────────────────────
UP = {'srv': None, 'key': None, 'err': 'not looked yet', 'desc': None}


def find_upstream():
    while True:
        chat = [s for s in llama_servers() if not s['embed']]
        srv, key, err = (chat[0] if chat else None), None, None
        if not srv:
            err = 'no llama-server running'
        elif srv['key_file']:
            try:
                with open(srv['key_file']) as f:
                    key = (f.read().strip().splitlines() or [''])[0].strip()
            except OSError as e:
                err = f'cannot read the server key file ({e.strerror})'
        elif srv['key']:
            key = srv['key'].split(',')[0].strip()     # (several keys may be given; any one will do)
        desc = srv and f'{srv["unit"]} pid {srv["pid"]} {srv["host"]}:{srv["port"]}'
        if desc != UP['desc']:
            print(f'mirror upstream: {desc or err}', flush=True)
        UP.update(srv=srv, key=key, err=err, desc=desc)
        time.sleep(DISCOVER_EVERY)


def upstream(path):
    srv = UP['srv']
    if not srv:
        raise RuntimeError(UP['err'])
    if UP['err']:
        raise RuntimeError(UP['err'])
    req = urllib.request.Request(f'http://{srv["host"]}:{srv["port"]}{path}',
                                 headers={'Authorization': f'Bearer {UP["key"]}'} if UP['key'] else {})
    try:
        with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
            return r.status, r.read(), srv
    except urllib.error.HTTPError as e:
        return e.code, e.read(), srv


NUM = (int, float, bool)
SLOT_KEEP = ('id', 'n_ctx', 'speculative', 'is_processing', 'id_task', 'n_prompt_tokens',
             'n_prompt_tokens_processed', 'n_prompt_tokens_cache')


def clean_slot(s):
    if not isinstance(s, dict):
        return {}
    o = {k: s[k] for k in SLOT_KEEP if isinstance(s.get(k), NUM)}
    p = s.get('params') if isinstance(s.get('params'), dict) else {}
    o['params'] = {k: p[k] for k in ('n_predict', 'max_tokens') if isinstance(p.get(k), NUM)}
    o['next_token'] = [{k: t[k] for k in ('has_next_token', 'n_remain', 'n_decoded') if isinstance(t.get(k), NUM)}
                       for t in (s.get('next_token') or []) if isinstance(t, dict)]
    return o


def clean_props(p):
    if not isinstance(p, dict):
        return {}
    o = {k: p[k] for k in ('total_slots', 'endpoint_slots', 'endpoint_metrics', 'is_sleeping') if isinstance(p.get(k), NUM)}
    for k in ('model_alias', 'build_info', 'model_ftype'):
        if isinstance(p.get(k), str):
            o[k] = p[k][:120]
    dg = p.get('default_generation_settings')
    if isinstance(dg, dict) and isinstance(dg.get('n_ctx'), NUM):
        o['n_ctx'] = dg['n_ctx']
    return o


class M(Quiet):
    HEADERS = {'X-HomeNet-Mirror': '1'}      # the hub's engine probe says "via mirror"

    def do_GET(self):
        if not self.allowed():
            return
        path = self.path.split('?', 1)[0]
        if path not in ('/health', '/v1/models', '/metrics', '/slots', '/props'):
            self.send_error(404)
            return
        try:
            code, body, srv = upstream(path)
        except Exception as e:                       # noqa: BLE001 -- told to the caller, nothing else
            msg = str(getattr(e, 'reason', None) or e)[:160]
            self.send(503 if not UP['srv'] else 502, json.dumps({'error': msg, 'mirror': 'homenet'}).encode(), 'application/json')
            return
        if code != 200:
            self.send(502 if code in (401, 403) else code,
                      json.dumps({'error': f'llama-server answered HTTP {code}', 'mirror': 'homenet'}).encode(), 'application/json')
            return
        if path == '/metrics':
            extra = ('# HELP homenet_llama_process_start_seconds When the mirrored llama-server process started (unix seconds).\n'
                     '# TYPE homenet_llama_process_start_seconds gauge\n'
                     f'homenet_llama_process_start_seconds {srv["start"]:.3f}\n')
            self.send(200, body.rstrip(b'\n') + b'\n' + extra.encode(), 'text/plain; version=0.0.4')
            return
        if path in ('/slots', '/props'):
            try:
                j = json.loads(body)
            except ValueError:
                self.send(502, b'{"error":"llama-server sent no JSON","mirror":"homenet"}', 'application/json')
                return
            out = [clean_slot(s) for s in j] if path == '/slots' and isinstance(j, list) else clean_props(j)
            self.send(200, json.dumps(out).encode(), 'application/json')
            return
        self.send(200, body, 'application/json')


threading.Thread(target=follow, daemon=True).start()
if AUTO:
    threading.Thread(target=watch_units, daemon=True).start()
if args.mirror:
    threading.Thread(target=find_upstream, daemon=True).start()
    ms = ThreadingHTTPServer((args.bind, args.mirror), M)
    threading.Thread(target=ms.serve_forever, daemon=True).start()
ThreadingHTTPServer((args.bind, args.port), H).serve_forever()
