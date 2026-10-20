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
"""
import argparse
import json
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RELEASE = re.compile(r'slot\s+release:.*\| task (\d+) \| stop processing: n_tokens = (\d+)')

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=9877)
ap.add_argument('--bind', default='0.0.0.0')
ap.add_argument('--unit', action='append', required=True)
args = ap.parse_args()

UNITS = {}                       # unit -> {embed, inv, start, requests, tokens}
for spec in args.unit:
    name, _, kind = spec.partition(':')
    UNITS[name] = {'embed': kind == 'embed', 'inv': None, 'start': 0.0, 'requests': 0, 'tokens': 0}
LOCK = threading.Lock()
STATE = {'lines': 0, 'started': time.time(), 'follower_restarts': 0, 'replayed': 0}


def show(unit, prop):
    return subprocess.run(['systemctl', 'show', unit, '-p', prop, '--value'],
                          capture_output=True, text=True).stdout.strip()


OLD_INVOCATIONS = set()         # invocation ids known to be older than the unit's current one


def journal(extra):
    cmd = ['journalctl', '-o', 'json', '--no-pager'] + extra
    for u in UNITS:
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
            st.update(inv=inv, requests=0, tokens=0, start=0.0)
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
    # 1. Replay this boot's journal into a private copy, then swap it in at once. The
    #    counters are never visible half-replayed: a scrape mid-replay would see a value
    #    lower than before and the hub would treat it as a server restart.
    fresh = {u: {**st, 'inv': show(u, 'InvocationID') or None, 'start': 0.0, 'requests': 0, 'tokens': 0}
             for u, st in UNITS.items()}
    cursor = None
    p = journal(['-b'])
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
        UNITS.update(fresh)
        STATE['replayed'] = 1
    # 2. Follow from where the replay stopped; if journalctl ever exits, resume from the
    #    last cursor -- never replay again, so nothing is counted twice.
    while True:
        p = journal(['-f'] + (['--after-cursor', cursor] if cursor else ['-n', '0']))
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
        with LOCK:
            STATE['follower_restarts'] += 1
        time.sleep(2)


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/metrics', '/'):
            self.send_error(404)
            return
        with LOCK:
            if not STATE['replayed']:
                # Not ready: report nothing rather than a partial count.
                self.send_error(503, 'replaying journal')
                return
            out = ['# HELP homenet_llama_requests_total Finished llama-server tasks (one "slot release" log line each).',
                   '# TYPE homenet_llama_requests_total counter']
            out += [f'homenet_llama_requests_total{{unit="{u}"}} {s["requests"]}' for u, s in UNITS.items()]
            out += ['# HELP homenet_llama_tokens_total Embedding input tokens (n_tokens of each finished task).',
                    '# TYPE homenet_llama_tokens_total counter']
            out += [f'homenet_llama_tokens_total{{unit="{u}"}} {s["tokens"]}' for u, s in UNITS.items() if s['embed']]
            out += ['# TYPE homenet_llama_invocation_start_seconds gauge']
            out += [f'homenet_llama_invocation_start_seconds{{unit="{u}"}} {s["start"]:.3f}' for u, s in UNITS.items()]
            out += ['# TYPE homenet_llama_exporter_lines_total counter', f'homenet_llama_exporter_lines_total {STATE["lines"]}',
                    '# TYPE homenet_llama_exporter_follower_restarts_total counter',
                    f'homenet_llama_exporter_follower_restarts_total {STATE["follower_restarts"]}']
        body = ('\n'.join(out) + '\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; version=0.0.4')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


threading.Thread(target=follow, daemon=True).start()
ThreadingHTTPServer((args.bind, args.port), H).serve_forever()
