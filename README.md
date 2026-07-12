# HomeNet Hub

**English** · [简体中文](README.zh-CN.md)

A **config-driven, self-hosted LAN monitoring dashboard**. Point it at your machines
and services with a few lines of YAML — no code changes, no rebuilds. Clone it and it
boots straight into a live **demo with synthetic data**, so you see the whole thing
working before wiring up anything real.

![HomeNet Hub dashboard](docs/screenshot.png)

> All display text (titles, labels, categories, theme) is configuration — write it in
> **any language**. The shipped example is English; your `config/` is yours.

---

## Features

- **Config-driven** — add a machine/service by editing YAML; the card appears on save.
  Nothing is hardcoded.
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
  (read-only Postgres), `exec` (allowlisted local commands), `demo` (synthetic).
- **Time-series & token accounting** — built-in **SQLite** history with compare charts;
  **Postgres** token accounting with a cumulative all-time total plus a live tokens/sec.
- **Themeable & resilient** — fonts/colors via `theme.yaml`; visibility-aware polling
  with a reconnect badge for flaky mobile networks.
- **Single container** — `docker compose up` and you're done.

---

## Architecture

```text
monitored machines
  ├─ Linux / Windows push agent ──POST /api/push/:id (X-Push-Token)──┐  (no inbound port on the machine)
  └─ http / sql / exec sources ───pulled on interval────────────────┤
                                                                     ▼
  collectors ─► normalize (JSONPath map + metric templates ─► value / level / display)
                                                                     │
                       ┌─────────────────────────────┬──────────────┴───────────────┐
                       ▼                              ▼                              ▼
              snapshot (in-memory)            tsdb (SQLite)                Postgres (token acct)
                /api/snapshot                  /api/history                 /api/token_detail

  config/*.yaml ──(chokidar watch + ajv validate)──► /api/config (ETag)
                                                                     ▼
                              web/ (vanilla JS) renders from /api/config + /api/snapshot
```

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

---

## Connect real machines (4 steps)

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
   PUSH_TOKEN_MACHINE1=<your-token>       # generate: openssl rand -hex 24
   ```

4. **Run the agent** on the machine (fill in hub URL / id / token at the top of the
   script). It runs a resident loop and pushes every ~2 s:
   - Linux: `agents/homenet-agent.sh` — systemd service
   - Windows: `agents/homenet-agent.ps1` — Task Scheduler at startup

Add a card for it in `config/layout.yaml`, save, and it appears within ~3 s.

---

## Contracts & protocol

- **Push protocol** — the machine→hub JSON contract, agent requirements, and install
  shapes: [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md).
- **Service `/stats`** — optional real-value integration for a service card
  (`{ procs, sessions, skills }`); see the disabled `*_real_example` blocks in
  [`config.example/targets.yaml`](config.example/targets.yaml).

---

## Security

- **exec** runs only built-in allowlisted commands with validated args (`ping_host`
  requires a private RFC1918 IP); arbitrary command strings are never accepted.
- **sql** is read-only; SQL comes only from `queries/*.sql`; the single bound parameter
  is a whitelisted integer. No config- or client-supplied SQL is ever executed.
- **http_push** requires a matching `X-Push-Token`; unknown/invalid tokens are rejected.
- Secrets (`PG_DSN`, push tokens) live in `.env`; `config/`, `data/`, and `.env` are
  git-ignored, and `config.example/` is safe to publish. There is **no built-in auth** —
  put it behind an authenticated reverse proxy if you expose it beyond a trusted LAN.

---

## License

[MIT](LICENSE).
