# Changelog

All notable changes since the initial release (`bf92853`).

Deploy on the host with:

```bash
cd <repo> && git pull && docker compose up -d --build
```

**Rebuild note:** `--build` is required whenever `server/` or `web/` changed (the
frontend is baked into the image). Commits that only touch `agents/` or `docs/`
need `git pull` alone. Each entry below is tagged accordingly.

---

## v2.1 — 2026-07-13

Windows/Linux push agents, a v1 visual-parity pass, and 14 UI/data features (B1–B14).

### Agents & push protocol

| Commit | Change | Rebuild |
|---|---|---|
| `ac95884` | push server: 400 validation layer, per-target `stale_after_s`, preserve `extra` in snapshot; align `AGENT_PROTOCOL.md` | **yes** (server) |
| `35b469d` | Linux push agent (`agents/homenet-agent.sh`) — zero-dep, amdgpu sysfs + nvidia-smi | no (agents/docs) |
| `9edf6e9` | Windows push agent (`agents/homenet-agent.ps1`) — ASCII-only, nvidia-smi + Claude-window passthrough | no (agents/docs) |

### Fixes

| Commit | Change | Rebuild |
|---|---|---|
| `8487655` | **net**: treat `rx_bps`/`tx_bps` as bytes-per-sec (was inflating ~1000×) | **yes** (server) |

### Theme — v1 visual parity (A-series)

| Commit | Change | Rebuild |
|---|---|---|
| `941d064` | A1 warm text (`#cdc4a8`) · A2 KV identity glow + status border + ring glow · A3 card glass layer · unify `--violet` (`#b18cff`) | **yes** (web) |
| `fac0493` | B7 card outer glow → v1 3-layer · B6-addendum Token-card hairline dividers | **yes** (web) |

> B6 (ring geometry) needed no change — verified value-for-value identical to v1.
> §0 hard constraints held throughout (no blur, no conic border-flow, card-bg fixed, 20px accent glow).

### UI & data features (B-series)

| Commit | Change | Rebuild |
|---|---|---|
| `296d985` | B1 status normalization (healthy vocab → green, only failure vocab → red) · B2 ring center always integer `%` | **yes** (web) |
| `d796078` | B3 token `speed` second query (`token_speed.sql`) · B4 cumulative all-time totals (10-min cached) | **yes** (server) |
| `00f99bc` | B5 static assets served `no-cache` + ETag — no more hard-refresh after deploy | **yes** (server) |
| `e13c79b` | B8 `uptime_s` → `{d}d {h}h` in card header (conversion in normalize) + fix tagless-mount header persist | **yes** (server+web) |
| `c9d6f9d` | B9 history series aligned to v1 (GPU% / VRAM% / Temp / Power; dropped CPU + mem) | **yes** (web) |
| `4381512` | B10 history N-pane compare via `layout.panes` (backward-compatible with `default`) · B11 OpenClaw `/stats` phase-2 contract in example | **yes** (web+config) |
| `93428f8` | B12 `type: stack` card — multiple service targets in one frame, backward-compatible | **yes** (server+web) |
| `df766f8` | B12-addendum stack `direction: row\|column` with narrow-container fallback · empty-`items` note (no silent blank card) | **yes** (server+web) |
| `1496213` | B13 machine `header_right` array (`[badge, uptime]` → "RX 7900XTX │ 15d 7h"), backward-compatible | **yes** (server+web) |
| `50f4d79` | B14 auto identity color by role (gpu/host/service) from live `gpus[]`; manual `color` wins; `theme.roles` overridable | **yes** (server+web) |

### Config surface added this release

- `targets[].source`: `stale_after_s`, `token_env`, `speed_query_file`, `speed_samples`, `total_query_file`
- `targets[].color: auto` (role-based auto identity color)
- `layout.grid[]`: `type: stack`, `children`, `direction`, `header_right: [array]`
- `layout.history`: `panes: [...]`
- `theme`: `roles: { gpu, host, service }`
- queries: `queries/token_speed.sql`, `queries/token_total.sql`

---

Initial release: `bf92853` — config-driven self-hosted homelab monitor (v2.0).
