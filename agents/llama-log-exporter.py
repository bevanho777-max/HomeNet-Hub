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

v2.46 -- each finished request's own timings, as llama-server logs them when it releases the
slot ("prompt eval time = X ms / N tokens" and "eval time = Y ms / M tokens", then "slot
release"), for the hub's Prefill / Decode history:

  GET /requests[?unit=U][&since=T][&limit=N]
      {"replayed": true, "units": {"<unit>": {"start": <unix>, "requests": [
         {"task": 626870, "at": <release, unix>, "prompt_n": 4096, "prompt_ms": 19337.84,
          "gen_n": 7662, "gen_ms": 212092.5}, ...]}}}
      oldest first, at > T only, the newest N (default 2000); chat units only. The last
      REQ_KEEP requests of the unit's current run are kept (the replay rebuilds them).

v2.47 -- --state FILE: where it has read up to in the journal (the journal CURSOR of the last entry
counted: it names the entry itself, so it stays valid when journald rotates its files -- the
journal's equivalent of a file's inode + offset) and everything counted up to there (the counters,
each unit's invocation, the finished requests above), written atomically (temp file + rename) at
most every 10 s while something changed, and on SIGTERM. At start it continues right after that
cursor -- no replay of the boot's journal (on m26 that took ~8 minutes, /metrics answering 503 the
whole time): the counters carry on from the saved values, the entries written while it was down
are counted on the way. A file for other units, a cursor journalctl no longer finds (journald
vacuumed past it while the exporter was down), or no file: the full replay, as before.
  e.g. --state /var/lib/homenet-llama-exporter/state.json   (systemd: StateDirectory=homenet-llama-exporter)
"""
import argparse
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RELEASE = re.compile(r'slot\s+release:.*\| task (\d+) \| stop processing: n_tokens = (\d+)')
# v2.46 the request's own timings, logged just before its release line (prompt eval = prefill)
TIMING = re.compile(r'\| task (\d+) \|\s+(prompt eval|eval) time =\s*([\d.]+) ms /\s*(\d+) tokens')
REQ_KEEP = 20000                 # finished requests kept per unit (a few days of m26)
PEND_MAX = 64                    # timing lines whose release never came (a crash): forgotten
DISCOVER_EVERY = 15
UPSTREAM_TIMEOUT = 3

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=9877)
ap.add_argument('--bind', default='0.0.0.0')
ap.add_argument('--unit', action='append', required=True)
ap.add_argument('--mirror', type=int, default=0)
ap.add_argument('--allow', action='append', default=[])
ap.add_argument('--state', default='')
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
CUR = {'proc': None, 'units': None, 'cursor': None, 'dirty': False, 'replay': False}
SAVE_EVERY = 10
CURSOR_FAILS = 3                 # journalctl refusing the saved cursor this often in a row -> replay


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
    # only the release and timing lines when journalctl can filter (a verbose server writes
    # ~10^5 other lines a day; the replay would read them all)
    cmd = ['journalctl', '-o', 'json', '--no-pager'] + (['-g', r'slot\s+release|eval time ='] if GREP else []) + extra
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
            # (the finished requests of the earlier run stay: they did happen)
            st.update(inv=inv, requests=0, tokens=0, start=unit_start(u), pend={})
        else:
            OLD_INVOCATIONS.add(inv)                 # an earlier run of the unit, this boot
            return
    if not st['start']:
        st['start'] = int(e.get('__REALTIME_TIMESTAMP', '0')) / 1e6
    msg = e.get('MESSAGE', '')
    if isinstance(msg, list):
        msg = bytes(msg).decode(errors='replace')
    t = TIMING.search(msg)
    if t and not st['embed']:
        rec = st['pend'].setdefault(t.group(1), {})
        k = 'prompt' if t.group(2) == 'prompt eval' else 'gen'
        rec[k + '_ms'] = float(t.group(3))
        rec[k + '_n'] = int(t.group(4))
        if len(st['pend']) > PEND_MAX:
            st['pend'].pop(next(iter(st['pend'])))
        return
    m = RELEASE.search(msg)
    if m:
        st['requests'] += 1
        if st['embed']:
            st['tokens'] += int(m.group(2))
        rec = st['pend'].pop(m.group(1), None)
        if rec:
            at = int(e.get('__REALTIME_TIMESTAMP', '0')) / 1e6
            st['done'].append((at, int(m.group(1)), rec.get('prompt_n'), rec.get('prompt_ms'), rec.get('gen_n'), rec.get('gen_ms')))


def load_state(want):
    """(units, cursor) from --state when it is for these units, else None"""
    if not args.state:
        return None
    try:
        with open(args.state) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    us = d.get('units') or {}
    if d.get('version') != 1 or not d.get('cursor') or set(us) != set(want) \
            or any(bool(us[u].get('embed')) != bool(want[u]) for u in want):
        print('saved state is not for these units: replaying', flush=True)
        return None
    out = {}
    for u, x in us.items():
        out[u] = {'embed': bool(x.get('embed')), 'inv': x.get('inv'), 'start': float(x.get('start') or 0),
                  'requests': int(x.get('requests') or 0), 'tokens': int(x.get('tokens') or 0),
                  'pend': {str(k): dict(v) for k, v in (x.get('pend') or {}).items()},
                  'done': deque((tuple(r) for r in x.get('done') or []), maxlen=REQ_KEEP)}
    OLD_INVOCATIONS.update(d.get('old_invocations') or [])
    return out, d['cursor']


def save_state():
    """write the position and the counts together (one consistent moment), atomically"""
    if not args.state:
        return
    with LOCK:
        if not STATE['replayed'] or not CUR['cursor'] or not CUR['dirty']:
            return
        d = {'version': 1, 'saved': time.time(), 'cursor': CUR['cursor'], 'old_invocations': sorted(OLD_INVOCATIONS)[-64:],
             'units': {u: {'embed': x['embed'], 'inv': x['inv'], 'start': x['start'], 'requests': x['requests'],
                           'tokens': x['tokens'], 'pend': {k: dict(v) for k, v in x['pend'].items()}, 'done': list(x['done'])}
                       for u, x in UNITS.items()}}
        CUR['dirty'] = False
    tmp = args.state + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(d, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, args.state)
        STATE['saved'] = time.time()
    except OSError as e:
        CUR['dirty'] = True
        print(f'cannot write {args.state}: {e}', flush=True)


def saver():
    while True:
        time.sleep(SAVE_EVERY)
        save_state()


def on_term(signum, frame):
    save_state()
    os._exit(0)


def follow():
    while True:
        want = wanted()
        CHANGED.clear()
        CUR['units'] = want
        # 1. Replay this boot's journal into a private copy, then swap it in at once. The
        #    counters are never visible half-replayed: a scrape mid-replay would see a value
        #    lower than before and the hub would treat it as a server restart.
        fresh = {u: {'embed': embed, 'inv': show(u, 'InvocationID') or None, 'start': unit_start(u), 'requests': 0, 'tokens': 0,
                     'pend': {}, 'done': deque(maxlen=REQ_KEEP)}
                 for u, embed in want.items()}
        cursor = None
        # v2.47 the saved position (only when the process starts: a change of units, or a cursor the
        # journal no longer has, replays)
        loaded = load_state(want) if want and not STATE.get('state_tried') and not CUR['replay'] else None
        STATE['state_tried'] = 1
        CUR['replay'] = False
        if loaded:
            fresh, cursor = loaded
            STATE['resumed'] = 1
            print('resumed from the saved position: ' + ', '.join(f"{u} {s['requests']}" for u, s in fresh.items()), flush=True)
        elif want:
            STATE['resumed'] = 0
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
            CUR['cursor'] = cursor
            CUR['dirty'] = True
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
            got = 0
            try:
                for line in p.stdout:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    with LOCK:
                        apply(e, UNITS)
                        STATE['lines'] += 1
                        if e.get('__CURSOR'):
                            CUR['cursor'] = e['__CURSOR']
                            CUR['dirty'] = True
                    cursor = e.get('__CURSOR', cursor)
                    got += 1
            finally:
                p.kill()
                p.wait()
                CUR['proc'] = None
            if CHANGED.is_set():
                break
            with LOCK:
                STATE['follower_restarts'] += 1
            # a cursor journalctl will not seek to (vacuumed away while we were down): count it, and
            # after a few in a row start over with the full replay
            STATE['cursor_fails'] = STATE.get('cursor_fails', 0) + 1 if not got and p.returncode not in (0, -9) else 0
            if STATE['cursor_fails'] >= CURSOR_FAILS:
                print(f'journalctl refuses the saved cursor ({p.returncode}): replaying the journal', flush=True)
                STATE['cursor_fails'] = 0
                CUR['replay'] = True
                break
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


def requests_json(query):
    q = parse_qs(query)
    unit = (q.get('unit') or [None])[0]
    try:
        since = float((q.get('since') or ['0'])[0])
        limit = max(1, min(REQ_KEEP, int((q.get('limit') or ['2000'])[0])))
    except ValueError:
        return None
    out = {}
    for u, s in UNITS.items():
        if s['embed'] or (unit and u != unit):
            continue
        rows = [r for r in s['done'] if r[0] > since][-limit:]
        out[u] = {'start': s['start'], 'requests': [
            {'task': r[1], 'at': round(r[0], 3), 'prompt_n': r[2], 'prompt_ms': r[3], 'gen_n': r[4], 'gen_ms': r[5]} for r in rows]}
    return {'replayed': True, 'units': out}


class H(Quiet):
    def do_GET(self):
        if not self.allowed():
            return
        path, _, query = self.path.partition('?')
        if path == '/requests':
            with LOCK:
                if not STATE['replayed']:
                    self.send_error(503, 'replaying journal')
                    return
                body = requests_json(query)
            if body is None:
                self.send_error(400, 'bad since / limit')
                return
            self.send(200, json.dumps(body, separators=(',', ':')).encode(), 'application/json')
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
            out += ['# TYPE homenet_llama_exporter_resumed gauge', f'homenet_llama_exporter_resumed {STATE.get("resumed", 0)}']
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
if args.state:
    threading.Thread(target=saver, daemon=True).start()
    signal.signal(signal.SIGTERM, on_term)
if AUTO:
    threading.Thread(target=watch_units, daemon=True).start()
if args.mirror:
    threading.Thread(target=find_upstream, daemon=True).start()
    ms = ThreadingHTTPServer((args.bind, args.mirror), M)
    threading.Thread(target=ms.serve_forever, daemon=True).start()
ThreadingHTTPServer((args.bind, args.port), H).serve_forever()
