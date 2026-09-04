# HomeNet Hub

**English** · [简体中文](README.zh-CN.md)

A **config-driven, self-hosted LAN monitoring dashboard**. Point it at your machines
and services with a few lines of YAML — or just type an IP and let the panel find what
is there. Clone it and it boots straight into a live **demo with synthetic data**, so
you see the whole thing working before wiring up anything real.

![HomeNet Hub dashboard](docs/screenshot.png)

> All display text (titles, labels, categories, theme) is configuration — write it in
> **any language**. The shipped example is English; your `config/` is yours.

---

## Features

- **Config-driven** — add a machine/service by editing YAML; the card appears on save.
  Nothing is hardcoded.
- **Discovery → add → see** — type a private IPv4 and the panel probes what is there,
  then offers the capabilities those findings support. Tick some and they become real
  targets and cards, stored in the database rather than in the read-only YAML. No
  credentials are involved at this layer.
- **Machine metrics with or without credentials** — a host running **node_exporter**
  becomes a full machine card from one scrape, no secret anywhere; a host that only
  offers **SSH** becomes the same card over one session, with the password or key held
  in an encrypted vault. (WinRM/Windows is catalogued but its collector is not written
  yet.)
- **Credential vault** — secrets are encrypted at rest with **AES-256-GCM** under a key
  derived from `VAULT_KEY`, and the API is a write-only door: nothing ever reads a
  credential back out. SSH host keys are trust-on-first-use, and a changed key aborts
  the handshake *before* the credential is sent.
- **Admin auth** — discovery, runtime targets and the credentials API sit behind an
  admin password, set from the browser on first run or from `ADMIN_PASSWORD`. With
  neither, those endpoints answer `401`, never "open". Reading
  the board stays public unless `REQUIRE_LOGIN_TO_VIEW` says otherwise.
- **Hot-reload** — edit YAML on the host and the panel re-shapes in ~3 s. A bad edit is
  rejected and the last good config stays live (the panel never goes dark).
- **Push agents, zero inbound ports** — monitored machines POST to the hub, opening
  **no listening port** of their own. Zero-dependency agents ship for **Linux**
  (bash + `/proc` + amdgpu sysfs / `nvidia-smi`) and **Windows** (PowerShell 5.1 +
  `nvidia-smi`).
- **Auto identity color** — `color: auto` decides a card's color from live hardware:
  GPU present → orange, host-only → blue, service → violet — switching in real time as
  cards come and go. Role colors are overridable in `theme.yaml`.
- **Composite layout** — `stack` cards fold multiple service backends into one frame
  (row/column, responsive); N-pane history compare via `panes: [...]`.
- **Collectors** — `http` (pull), `http_push` (machine pushes to you), `sql`
  (read-only Postgres), `exec` (allowlisted local commands), `tcp`, `tls`,
  `prometheus` (node_exporter scrape), `ssh` (credentialed Linux metrics),
  `demo` (synthetic).
- **Metric templates** — one metric key says how a value is read *and* how it is drawn:
  `value/max` composites, `divide` scaling, `level_map` for colouring text states, and
  per-segment colouring with superscript labels (that is how NAS drive temperatures
  carry their drive number, and the gateway card its per-model request counts).
- **Time-series & token accounting** — built-in **SQLite** history with compare charts,
  tiered downsampling (raw samples for the recent days, folded into 5-minute aggregate
  buckets for about a month, each bucket keeping min/max so spikes are not flattened)
  over a covering index, which keeps long-range queries cheap; **Postgres** token
  accounting with a cumulative all-time total, a live tokens/sec, and a per-project
  breakdown by API key.
- **Themeable & resilient** — fonts/colors via `theme.yaml`; visibility-aware polling
  with a reconnect badge for flaky mobile networks.
- **Set up in the browser** — a fresh install asks for an admin password on first load
  (LAN only, once) and says out loud that its board is demo data, with one button to
  clear it. No editor, no restart.
- **Single container** — `docker compose up` and you're done.

---

## Discover → add → see

Click **＋ 添加目标**, type a private IPv4, and the panel probes the host without any
credentials: a bounded TCP port sweep, an unauthenticated HTTP fingerprint (status /
`Server` / `<title>`), TLS certificate expiry, and node_exporter detection. What comes
back is a manifest plus the capabilities those findings support — tick the ones you
want and they are created as real targets and cards.

![Discovery panel](docs/discovery.png)

| Capability | What it creates | Requires |
|---|---|---|
| `reachability` | service card — ping status + latency | nothing (offered even for a host that answered nothing) |
| `port_check:<port>` | service card — TCP connect + latency | the port open, and in the known set |
| `http_check:<port>` | service card — HTTP status + latency | a **plaintext** HTTP port (443 is covered by `tls_cert`) |
| `tls_cert:<port>` | info card — days until certificate expiry | a TLS port whose handshake actually returned a certificate |
| `node_metrics` | machine card — CPU / memory / disk / network / uptime | node_exporter answering on `:9100` with the families the card draws |
| `ssh_metrics` | machine card — the same set, over SSH | port 22 open **and** a stored credential |
| `winrm_cpu` · `winrm_mem` · `winrm_disk` | *(planned)* | listed as pending; no collector yet |

What keeps this from being a remote-command endpoint:

- **Private IPv4 only.** `net_guard.js` is the one authority: public addresses,
  link-local `169.254.0.0/16` and leading-zero octets (`010.0.0.1`, which a resolver
  would read as octal) are all refused, and only the canonical form it returns is
  connected to.
- **The port set is a constant** (`server/capabilities/ports.js`). Callers cannot name
  a port, so neither discovery nor a stored target can be aimed at an arbitrary
  internal service.
- **The client never sends a `source`.** It sends `{host, capability, name?,
  credential_id?}` and nothing else; what gets stored is built server-side by the
  capability catalog from constants. A target's `source` is exactly what the scheduler
  executes, so accepting one from the browser would turn "add this to my panel" into
  "run this for me".
- **The preview is the thing.** A capability's `source_preview` is literally the object
  that materialisation stores, not a hand-written lookalike, so the two cannot drift.

Runtime-added targets are listed under **已添加** in the same panel and can be deleted
there. They live in `data/homenet.db`, never in `config/`.

---

## Machine metrics, two ways

### Without credentials — node_exporter

One `/metrics` scrape becomes a standard machine card: CPU ring, memory, disk, network
and uptime, drawn by the same widget and the same metric templates a push-agent host
uses.

![Machine card from a node_exporter scrape](docs/machine-card.png)

`node_cpu_seconds_total` and the network counters only mean something as a rate, so the
collector keeps the previous reading and reports the delta — the **first** scrape of a
target shows `—` for CPU and network rather than a fabricated zero. This is **one**
capability, not four: separate CPU / memory / disk / network capabilities would have
scraped the same endpoint four times on the same interval for one host's numbers, and
produced four one-metric cards where the panel already has a card type showing exactly
this set.

### With credentials — SSH (Linux)

A host that offers nothing but sshd can still produce the same card. One session runs
one **fixed** command — `cat /proc/stat`, `cat /proc/meminfo`, `df -kP /`,
`cat /proc/net/dev`, `cat /proc/uptime`, joined by a constant separator — and the
output is parsed into the push agent's payload shape, so it renders through the same
map, templates and card.

- The stored target holds a **`credential_id`, never a secret**. The plaintext exists
  only inside the collector, between `vault.decrypt()` and the moment ssh2 has consumed
  it, and every reference is dropped immediately afterwards.
- **Host keys are trust-on-first-use, and a changed key is a hard refusal.** The check
  runs in `hostVerifier`, which aborts the handshake *before* authentication — so an
  impostor answering on that LAN address never receives the credential. The fingerprint
  is OpenSSH's `SHA256:…` format, so you can compare it with `ssh-keyscan`.
- Like `node_metrics`, this is **one** capability (`ssh_metrics`), not three: one
  session yields CPU, memory, disk and network together.

Windows is catalogued (`winrm_cpu` / `winrm_mem` / `winrm_disk`, offered when the OS
hint says Windows and a login port is open) but stays **pending** — discovery lists it
greyed out with the reason, and the API refuses to materialise it, until the collector
exists.

---

## LLM token accounting

If you run a **LiteLLM** gateway, a read-only Postgres DSN turns its accounting tables
into cards: a by-model token card (cumulative total, day trend, live tokens/sec) and a
**per-project** table card.

The per-project card groups by **`api_key`** — which key the request came in on. That is
a deliberate choice among LiteLLM's three notions of "who":

| | what it is | why not it |
|---|---|---|
| `user_id` | the owner of the key | everything on the proxy master key collapses into one row |
| `end_user` | the OpenAI `user` field in the request body | precise, but only filled in for clients that actually send it — most send nothing |
| **`api_key`** | **which key the call arrived on** | **always populated, needs no client cooperation** |

So **a project gets its own row the moment it gets its own virtual key** — a credential
it has to configure anyway. Until you mint per-project keys, expect one large
`(master key)` row; that is the honest answer, not a broken card. Rows are labelled
`(master key)`, `key:<8 hex>` for a minted key, and the literal (truncated) for anything
else, so health-check pseudo-keys and scanner probes stay visible instead of vanishing.
Keys that produced no chat tokens at all are dropped — those are rejected probes, not
usage.

**Embedding and rerank models are excluded.** On a gateway doing RAG they are >99% of
requests and <0.1% of tokens; leaving them in makes the request column measure indexing
runs instead of conversations. The exclusion list is a `VALUES` block at the top of
[`config.example/queries/project_tokens.sql`](config.example/queries/project_tokens.sql)
— add a row for any embedding family your gateway serves.

Readable key aliases (`key_alias`) live in a table a read-only role needs a **separate**
grant for, and that join still cannot name the master key — it is a config literal with
no row there. Mint a couple of real keys first; the alias grant is worth adding after
that, not before. The query file carries the exact `LEFT JOIN` and `GRANT` to use.

> Every `sql` collector reads its SQL from a file under `queries/` — never from config
> and never from the frontend — with at most one whitelisted integer parameter. See
> [Security](#security).

---

## Credential vault

![Credentials panel](docs/credentials.png)

Set a key, restart, and the **凭据** panel opens. Names, usernames and types are listed;
the secret goes in and never comes back out.

### 1. Generate and configure `VAULT_KEY`

```bash
openssl rand -base64 32          # generate
```

Put it in `.env` on the host (git-ignored; `docker-compose.yml` already passes
`VAULT_KEY=${VAULT_KEY:-}` through to the container):

```bash
VAULT_KEY=<the string you just generated>
```

Then restart the container. **Keep that string somewhere you will still have it after a
rebuild.**

> **Losing `VAULT_KEY` means losing every stored credential.** They cannot be recovered
> from the database — that is the entire point of encrypting them. Changing the key
> locks the existing ones out permanently: the panel detects the mismatch at startup,
> stays locked, and the cure is to delete the old credentials and enter them again
> under the new key.

### 2. What "locked" means

With no `VAULT_KEY` (unset, empty, whitespace, or shorter than 16 characters) the vault
is **locked**, and locked never degrades to plaintext:

- the panel runs exactly as before, minus credential storage;
- the credentials panel says it is locked and why;
- every write path answers `503 vault not configured`;
- existing ciphertext simply stays unreadable.

### 3. How it is stored

- **AES-256-GCM** (`node:crypto`, no dependencies). The encryption key is
  `scrypt(VAULT_KEY, per-install salt)`, derived **once** at startup; the 16-byte salt
  is minted on first unlock and stored beside the ciphertext, so it travels with a
  restored backup. The IV — the thing that must never repeat — is per ciphertext.
- An encrypted **verifier** is written at first unlock and re-checked at every boot.
  Without it, booting with the *wrong* key would look fine until something tried to
  decrypt a real credential, and new credentials would be written under the new key —
  leaving one database holding two generations of ciphertext that no single key can
  read.
- The credentials table has **no plaintext column at all**. The listing query does not
  even `SELECT` the ciphertext, so a listing cannot leak it by accident, and no route
  returns a secret in any shape — not plaintext, not ciphertext, not in an error
  message. The only reader is the ssh collector, in memory, at connect time.
- Deleting a credential that a target still references is refused with `409` and the
  list of targets using it.

Credential types are `ssh_password`, `ssh_key` and `winrm_password` (stored now, used
when the WinRM collector lands).

### 4. Using one

A credential-backed capability shows a **picker instead of a name field** — the browser
only ever sees credential names, and sends back an id:

![Adding an SSH target with a credential picker](docs/add-target-credential.png)

---

## Admin auth

Everything on the previous two pages — discovery, adding and deleting runtime targets,
the whole credentials API — is a **write** to your network's monitoring. All of it is
behind an admin password.

Set one when you deploy:

```bash
openssl rand -base64 24        # >= 8 chars
# -> .env:  ADMIN_PASSWORD=...
```

**With no `ADMIN_PASSWORD` set, those endpoints answer `401` — never "open".** A
forgotten env var yields a locked install, not a public write API. That is the same
fail-closed default the vault takes, for the same reason.

### What is gated, and what is not

| Endpoint | Gate |
|---|---|
| `GET /api/discover`, `GET /api/credentials` | admin session |
| `POST`/`DELETE /api/credentials`, `POST`/`DELETE /api/user_targets`, `POST /api/demo/dismiss` | admin session **+** same-origin check |
| `GET /api/config`, `/api/snapshot`, `/api/history`, `/api/token_detail`, `GET /api/user_targets` | public by default; admin session when `REQUIRE_LOGIN_TO_VIEW` is on |
| `/healthz`, `/api/login`, `/api/logout`, `/api/session` | always reachable |
| `POST /api/admin/setup` | same-origin **+** private client address **+** *only* while no admin exists; `409` forever after |
| `POST /api/admin/password` | admin session **+** same-origin **+** the current password |
| `POST /api/push/:targetId` | its target's `X-Push-Token`, unchanged |

Reading the board stays public, because that is what an existing install already did and
a monitor on a trusted LAN is usually meant to be glanceable. Flip
`REQUIRE_LOGIN_TO_VIEW=1` and the whole panel — data included — needs a session.

### The controls follow the session

Logged out, the header offers one button:

![Header with no admin session — only a login button](docs/auth-logged-out.png)

Logged in, the management controls appear:

![Header after logging in — add-target, credentials and logout](docs/auth-logged-in.png)

The buttons start hidden and are revealed by `/api/session`, so the header never flashes
a control the server would refuse. **This is cosmetic.** Nothing about the UI is a
security boundary: the endpoints refuse an unauthenticated caller whether or not a
button was ever drawn.

### Changing it

Logged in, the header carries a **改密** button. It asks for the current password and
the new one twice, and on success the tab you did it in stays logged in while **every
other session is invalidated immediately**.

The endpoint is `POST /api/admin/password`, and it is gated four ways: a valid admin
session, the same-origin check, the *current* password, and the same length rules as
any other password. It shares the **login rate limiter** — the current-password field is
a second place to guess at that secret, and separate budgets would hand an attacker
twice the attempts by alternating endpoints. A new password that is merely too short
does not count against that budget: your own typo about your own account should not lock
you out.

### Where the password lives

| | |
|---|---|
| `admin_auth` row in `data/homenet.db` | **authoritative** once it exists — scrypt hash + random salt, no plaintext column |
| `ADMIN_PASSWORD` | **bootstrap only.** Used to create that row on an install that has none. After that it is inert: it does not override the stored password, and editing it changes nothing |
| first-run wizard | the other way to create that row — see below |
| neither, and never set up | locked — every management endpoint answers `401` |

### First-run setup, and why it is so narrow

`POST /api/admin/setup` is the one endpoint that can create a password without already
having one, so it is the narrowest in the project:

- **Only while nothing can already manage the install** — no `admin_auth` row *and* no
  `ADMIN_PASSWORD`. Afterwards it answers `409` forever. There is no reset path over
  HTTP by design; recovery is the escape hatch below, which needs access to the host.
- **Only from the local network.** Someone who finds a fresh install exposed to the
  internet must not be able to claim it before its owner does. The check does *not* use
  the framework's client IP: with `trustProxy` on, that is the leftmost
  `X-Forwarded-For` entry, which the caller writes. It uses the rightmost entry — the
  one the nearest proxy added and the caller could not forge — and requires the socket
  peer to be private as well. An unusual multi-proxy chain fails **closed**: use the
  `ADMIN_PASSWORD` route instead.
- **One at a time.** Two simultaneous requests yield exactly one `200`; the loser gets
  `409`. The arbiter is the database's `ON CONFLICT DO NOTHING`, so it holds across
  processes, not just within one.
- **Rate limited on its own budget**, so a mistyped confirm box on a brand-new install
  can never walk you toward the login lockout.

The password takes the same path as the other two routes into that row — scrypt over a
fresh random salt, straight into the database — and is never logged, echoed or returned.

**Forgot the password?** That is what the escape hatch is for:

```bash
docker compose exec homenet-hub sh -c \
  "sqlite3 /app/data/homenet.db 'DELETE FROM admin_auth;'"
# or, on the host:  sqlite3 data/homenet.db 'DELETE FROM admin_auth;'
docker compose restart homenet-hub
```

The next boot re-bootstraps the row from whatever `ADMIN_PASSWORD` currently says — which
is the only reason that env var is still read after the first boot. With no
`ADMIN_PASSWORD` set, deleting the row instead re-arms the **first-run wizard**, so you
can set a new password from the browser. Either way, deleting the row invalidates every
session, since the signing secret goes with it.

### How the session works

- The cookie is **signed, not stored** — there is no session table. The signing key is a
  random 32-byte secret in the `admin_auth` row, rotated in the same write that changes
  the password, so **changing the password invalidates every outstanding session** with
  nothing to revoke, while a restart or a rebuild does *not* log everyone out (a random
  per-boot key would, and on this deployment that is often). The secret is its own value
  rather than something derived from the password hash: the hash is what untrusted input
  is *compared* against, the secret is what *mints* sessions, and collapsing the two
  would turn any future accident that exposes the hash into session forgery.
- `HttpOnly`, `SameSite=Strict`, 12-hour lifetime. `Secure` follows the **request's**
  protocol, so a direct `http://192.168.x.x:3100` hit from the LAN still gets a cookie
  the browser will send back.
- **Logout revokes server-side.** Deleting only the browser's copy would leave a cookie
  captured beforehand valid for the rest of its 12 hours.
- The password is stored as **scrypt** over a per-install random salt — never in
  plaintext, and nowhere a route can read it back. Verification is constant-time and
  runs off the event loop, and neither the value, nor its length, nor the hash reaches a
  log line, a response or an error.
- Login is rate-limited in **two tiers**: per client IP, and per socket peer. The second
  is what bounds an attacker rotating `X-Forwarded-For`, a header `trustProxy` means we
  believe. Backoff is exponential from the 6th failure, capped at 15 minutes, and the
  gate is checked *before* the password — a correct password during a lockout is still
  `429`.
- State-changing calls also check `Origin`. A **missing** `Origin` is allowed on
  purpose: browsers attach one to every cross-site request that could carry a cookie, so
  its absence means a non-browser caller (curl, a script, a health check) with no
  ambient cookie to abuse.

The only things persisted are the hash, its salt and the signing secret — one row, no
user table, no session table. The rest is in-memory: a revocation map for logged-out
sessions plus the rate limiter's bounded map, and a restart forgets both.

---

## Architecture

Four nouns carry the whole design:

- **Target** — one monitored thing: an `id`, a `source` (which collector runs it, how
  often) and a `map` (JSONPath → metric keys). It comes from `targets.yaml`, or from
  the user store when it was added at runtime — the stored document is *exactly* the
  object the YAML would have contained.
- **Capability** — what discovery may turn into a target on a given host. The catalog
  (`server/capabilities/catalog.js`) is the single source of truth: it decides which
  findings support which capability *and* builds the `{target, card}` pair, so the
  preview a caller sees is the thing that gets stored.
- **Collector** — the code that produces one target's raw JSON: `http`, `http_push`,
  `sql`, `exec`, `tcp`, `tls`, `prometheus`, `ssh`, `demo` (plus the discovery probe,
  which is never scheduled).
- **Widget** — the card that draws it: `machine`, `service`, `info`, `token`, `table`, `stack`,
  `history`.
  A capability names its widget, which is why an added target arrives with a card that
  already fits it.

```text
monitored machines / services
  ├─ Linux / Windows push agent ─POST /api/push/:id (X-Push-Token)─┐ (no inbound port on the machine)
  ├─ http / sql / exec / tcp / tls sources ──pulled on interval────┤
  ├─ node_exporter :9100/metrics ──prometheus collector────────────┤ (no credentials)
  └─ sshd :22 ──ssh collector, credential decrypted per connect────┤
                                                                    ▼
  collectors ─► normalize (JSONPath map + metric templates ─► value / level / display)
                                                                    │
         ┌──────────────────────┬────────────────────┴──────┬──────────────────────┐
         ▼                      ▼                           ▼                      ▼
  snapshot (in-memory)    tsdb (SQLite)          Postgres (token acct)     widgets: machine /
   /api/snapshot           /api/history            /api/token_detail       service / info /
                    raw samples + 5-min buckets                            token / stack

  GET /api/discover ─► probe (ports · HTTP · TLS · node_exporter)
        └─► capability catalog ─► POST /api/user_targets ─► user store  ─┐
                                                                          │
  config/*.yaml (read-only mount) ─(chokidar watch + ajv validate)─► file config
                                                                          │
                                    effective config = file ++ user rows ◄┘
                                    (same validate/crossValidate gate)
                                                                    ▼
                                            /api/config (ETag, version)
                                                                    ▼
                        web/ (vanilla JS) renders from /api/config + /api/snapshot

  POST /api/credentials ─► vault: AES-256-GCM, key = scrypt(VAULT_KEY, per-install salt)
                             └─► credentials table (ciphertext only) ─► ssh collector
```

### Read-only `config/` vs writable `data/`

Production mounts `config/` **read-only**, so anything added while the panel is running
cannot go into the YAML. It goes into `data/homenet.db` instead — the volume that
already held the timeseries:

| Where | What | Written by |
|---|---|---|
| `config/*.yaml` | targets, layout, metrics, theme | you, on the host (hot-reloaded) |
| `data/homenet.db` → `user_targets`, `user_cards` | runtime-added targets and their cards | the add-target panel |
| `data/homenet.db` → `credentials`, `vault_meta`, `ssh_known_hosts` | encrypted secrets, vault salt + verifier, TOFU host keys | the credentials panel / the ssh collector |
| `data/homenet.db` → metrics tables | raw samples + 5-minute buckets | the scheduler |

The **effective config** is the file config with the user rows concatenated onto it,
put through the same validate/crossValidate gate a YAML edit gets. Two properties fall
out of that: a merge that fails validation is refused and the previous good config
stays live, and with an **empty** user store the effective config *is* the file config
object — same reference, same ETag — so an untouched install behaves byte-identically.

---

## Quick start

```bash
git clone https://github.com/bevanho777-max/HomeNet-Hub.git
cd HomeNet-Hub
docker compose up -d --build
# open http://192.168.x.x:3100
```

Three steps → the **demo dashboard** with animated synthetic data. Nothing in `.env`
and no `config/` is required for the demo; the app falls back to `config.example/`
automatically.

Run without Docker: `npm install && npm start` (→ `http://127.0.0.1:3100`, set `PORT`
to change).

### First run: set the admin password in the browser

Open the panel **from the LAN** and a one-time box asks you to set an admin password.
Set it and you are logged in — no `.env`, no restart.

![First-run admin setup](docs/first-run-setup.png)

It appears only while nothing can already manage the install (no `admin_auth` row and no
`ADMIN_PASSWORD`), and only for a caller on a private address; afterwards the endpoint
answers `409` forever. The env route still works: set `ADMIN_PASSWORD` before the first
boot and the install is already configured, so the wizard never appears. Details and the
recovery path: [Admin auth](#admin-auth).

### From demo to yours

The demo board announces itself, and can be cleared in one click.

![Demo onboarding bar](docs/demo-bar.png)

- **添加你的机器** opens the discovery panel — [Discover → add → see](#discover--add--see).
- **清空演示** clears the example targets and cards for good. It is a management action:
  it needs a session, it is confirmed, and it applies to **everyone** who opens this
  install, not just your browser. The **×** on the right only hides the bar in your own
  browser (`localStorage`) and changes nothing on the server.

Clearing writes a flag rather than deleting files — `config.example/` ships inside the
image and `config/` may be a read-only mount. Metric templates and the theme keep
falling back (without them there is nothing to render your own cards *with*); only the
demo board itself is emptied, and the demo targets stop being polled in the same step.
What is left is an empty board that tells you how to add your first machine. An install
that has its own `config/targets.yaml` was never on the demo board and never sees any of
this.

To bring the demo back, clear the flag on the host and restart:

```bash
sqlite3 data/homenet.db "DELETE FROM settings WHERE k='demo_dismissed';"
```

**Deploying an update on the host:**

```bash
cd <repo> && git pull && docker compose up -d --build
```

`--build` is required whenever `server/` or `web/` changed — the frontend is baked into
the image. Changes confined to `agents/` or `docs/` need `git pull` alone. Every
[CHANGELOG](CHANGELOG.md) entry is tagged with which it needs.

---

## Connect real machines

The panel's own **＋ 添加目标** flow covers reachability, ports, HTTP, certificates and
machine metrics without touching a file. For a push agent (GPU boxes, NAS, gateways) or
anything needing a custom `map`, declare it in YAML:

1. **Copy the examples into your private config** (`config/`, `.env` are git-ignored):

   ```bash
   cp -r config.example/* config/
   cp .env.example .env
   ```

2. **Declare the target** in `config/targets.yaml` — pick a `source` and map its JSON to
   metric keys (JSONPath). Only the `map` changes per backend; the rest stays generic:

   ```yaml
   - id: machine-1
     name: "Machine 1"
     color: auto                 # or a hex; `auto` = role-based (GPU/host/service)
     source: { type: http_push, token_env: PUSH_TOKEN_MACHINE1, stale_after_s: 10 }
     map:
       gpu:        "$.gpus[0].util_pct"
       vram_bytes: { v: "$.gpus[0].vram_used_gb", max: "$.gpus[0].vram_total_gb" }
       uptime:     { s: "$.uptime_s" }
   ```

3. **Set the secret** in `.env` (variable name matches `token_env`):

   ```bash
   PUSH_TOKEN_MACHINE1=<your-token>       # generate: openssl rand -hex 32
   ```

4. **Run the agent** on the machine (fill in hub URL / id / token at the top of the
   script). It runs a resident loop and pushes every ~2 s:
   - Linux: `agents/homenet-agent.sh` — systemd service
   - Windows: `agents/homenet-agent.ps1` — Task Scheduler at startup

Add a card for it in `config/layout.yaml`, save, and it appears within ~3 s.

---

## Environment

Everything below is optional — the demo needs none of it. Copy `.env.example` to `.env`
and fill in what you use.

| Variable | Purpose |
|---|---|
| `VAULT_KEY` | Credential-vault passphrase (≥16 chars; `openssl rand -base64 32`). Unset → the vault is locked and no credential can be stored or decrypted. **Losing it voids every stored credential.** |
| `ADMIN_PASSWORD` | **Bootstrap** password for the management endpoints — discovery, the credentials API, and *writes* to runtime targets (8-256 chars; `openssl rand -base64 24`). Used once, to create the hashed `admin_auth` row on an install that has none; after that the database is authoritative and this var is inert. **Optional since v2.8:** leave it unset and set the password from the browser on first run instead (LAN only). Unset **and** no row **and** never set up → those endpoints answer **401**, never "open". Delete the row to bootstrap again, or to re-arm the first-run wizard — that is the forgotten-password recovery. |
| `REQUIRE_LOGIN_TO_VIEW` | `1`/`true`/`on` → viewing needs a session too (`/api/config`, `/api/snapshot`, `/api/history`, …). Default off: the board stays public and only management is gated. |
| `PG_DSN` | Read-only Postgres DSN for a `sql` token collector. The name is whatever the target's `dsn_env` says; `PG_DSN` is the shipped example. |
| `PUSH_TOKEN_*` | Shared secret per `http_push` target; the name must match that target's `token_env` (`openssl rand -hex 32`). |
| `TELEGRAM_BOT_TOKEN` | Optional, for the built-in `probe_telegram` exec command. |
| `PORT` | Listen port (default `3100`). |
| `LOG_LEVEL` | Fastify log level (default `warn`). |
| `CONFIG_DIR` / `DATA_DIR` | Override the config and database locations (defaults `./config`, `./data`). |
| `RETENTION_DAYS` · `AGG_AFTER_DAYS` · `AGG_RETENTION_DAYS` · `PURGE_AFTER_DAYS` · `PUSH_GRACE_MS` | Time-series tiering and push-staleness knobs; the defaults are what the docs above describe. |

The LiteLLM gateway variables (`LITELLM_PG_DSN`, `LITELLM_DB_CONTAINER`,
`LITELLM_CONTAINERS`) belong on the **gateway host**, in `/etc/homenet-agent.env` — not
here. See [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md) §6.1.

---

## Versioning

`package.json`'s `version` field is the **single source of truth**. The server reads it
once at startup, `/api/config` carries it (so a tab polling with `If-None-Match` picks
up a new version without a reload), `/healthz` reports it, and the page footer shows it.

**Release convention:** bump `version` in `package.json` **and** add the matching
section heading to [`CHANGELOG.md`](CHANGELOG.md) in the same commit. If the two ever
disagree, what is on screen came from `package.json` — the CHANGELOG is what needs
fixing.

---

## Contracts & protocol

- **Push protocol** — the machine→hub JSON contract, agent requirements, and install
  shapes: [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md).
- **Service `/stats`** — optional real-value integration for a service card
  (`{ procs, sessions, skills }`); see the disabled `*_real_example` blocks in
  [`config.example/targets.yaml`](config.example/targets.yaml).
- **LLM gateway collection** — the agent-side environment that fills a gateway card's
  `extra.litellm.*` is documented in
  [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md) §6.1.

---

## Security

- **Discovery and runtime targets** — private RFC1918 IPv4 only (link-local and
  leading-zero octets refused), a fixed port set no caller can extend, and a `source`
  that is always built server-side from constants. Discovery itself writes nothing, is
  capped at 3 concurrent runs, and serves a repeat of the same IP from a 5-second
  cache.
- **Admin auth** — discovery, the credentials API and every *write* to runtime targets
  require a signed session cookie (HttpOnly, SameSite=Strict, Secure whenever the
  request arrived over HTTPS); listing targets follows the view gate with the rest of
  the board. The password is compared in constant time and never logged, echoed or
  returned; no `ADMIN_PASSWORD` means those endpoints answer **401**, not "open". The
  signing key is `scrypt(ADMIN_PASSWORD, …)`, so changing the password invalidates every
  outstanding session; logging out revokes that session server-side rather than only
  deleting the browser's copy. Login is rate-limited per client IP **and** per socket
  peer, and state-changing calls also check `Origin`. Hiding the admin buttons in the UI
  is cosmetic — the server refuses the request either way.
- **Credentials** — AES-256-GCM at rest under a key derived from `VAULT_KEY`; no
  plaintext column, no route that returns a secret, and no fallback to plaintext when
  the vault is locked. SSH host keys are trust-on-first-use and a changed key aborts
  the handshake before authentication.
- **exec** runs only built-in allowlisted commands with validated args (`ping_host`
  requires a private RFC1918 IP); arbitrary command strings are never accepted. The
  same is true of the SSH collector's remote command, which is a constant in the file.
- **sql** is read-only; SQL comes only from `queries/*.sql`; the single bound parameter
  is a whitelisted integer. No config- or client-supplied SQL is ever executed.
- **http_push** requires a matching `X-Push-Token`; unknown/invalid tokens are rejected.
- Secrets (`PG_DSN`, push tokens, `VAULT_KEY`, `ADMIN_PASSWORD`) live in `.env`;
  `config/`, `data/` and `.env` are git-ignored, and `config.example/` is safe to
  publish. Management is gated by `ADMIN_PASSWORD`; the read-only board is public unless
  `REQUIRE_LOGIN_TO_VIEW` says otherwise. Neither is TLS — terminate that at a reverse
  proxy if you expose the panel beyond a trusted LAN.

---

## License

[MIT](LICENSE).
