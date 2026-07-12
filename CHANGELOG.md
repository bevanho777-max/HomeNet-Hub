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

**From demo to production.** This release standardizes a machine-initiated **push
protocol** and ships zero-dependency agents for both Linux and Windows, so real
nodes stream live data with **no inbound ports opened**; five production nodes now
run the resident agents. The theme was reconciled **value-for-value with the v1
panel** (warm palette, layered card glow, ring geometry). Token accounting connects
directly to Postgres with a **cumulative all-time** figure plus a live tokens/sec
sample. Identity color can be **decided automatically from live hardware state**
(GPU present → orange, host-only → blue), and new layout primitives — stacked
service cards, N-pane history — landed alongside mobile polling resilience.

> **从 demo 到生产。** 本次发布标准化了机器主动推送协议,并交付 Linux/Windows 双平台
> 零依赖 agent,被监控机**不开任何入站端口**即可常驻上报;五个生产节点已接入真实数据。
> 主题与 v1 面板**逐值对齐**(暖色调、卡片分层辉光、环形几何)。token 记账直连 Postgres,
> 给出**全量累计**口径外加实时 tokens/秒采样。身份色可**随硬件状态自动判定**(有 GPU→橙、
> 纯主机→蓝);另新增堆叠 service 卡、N 屏历史等布局能力,以及移动端轮询韧性。

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
| `4381512` | B10 history N-pane compare via `layout.panes` (backward-compatible with `default`) · B11 service `/stats` phase-2 contract in example | **yes** (web+config) |
| `93428f8` | B12 `type: stack` card — multiple service targets in one frame, backward-compatible | **yes** (server+web) |
| `df766f8` | B12-addendum stack `direction: row\|column` with narrow fallback · empty-`items` shows a note instead of a silent blank card | **yes** (server+web) |
| `59ca08e` | B12-addendum stack **requires `items`** — a stack with no `items` is now a config validation error (previous good config kept) | **yes** (server) |
| `1496213` | B13 machine `header_right` array (`[badge, uptime]` → "machine-1 │ 15d 7h") with a vertical hairline, backward-compatible | **yes** (server+web) |
| `50f4d79` | B14 `color: auto` — identity color decided by role (gpu/host/service) from live `gpus[]`; manual `color` wins; `theme.roles` overridable | **yes** (server+web) |
| `086e7d9` | B15 resilient polling — visibility-aware refresh, fetch AbortController timeouts, reconnect badge (Online/Reconnecting/Disconnected), mobile cadence relaxation | **yes** (web) |
| `527a1b1` | B12-row width-measured row/column threshold (`min_row_width`, default children×180) so a ~400px card slot rows and a narrow one wraps; robust vs overflow feedback | **yes** (server+web) |

### Config surface added this release

- `targets[].source`: `stale_after_s`, `token_env`, `speed_query_file`, `speed_samples`, `total_query_file`
- `targets[].color: auto` (role-based auto identity color)
- `layout.grid[]`: `type: stack`, `children`, `direction`, `min_row_width`, `header_right: [array]`
- `layout.history`: `panes: [...]`
- `layout.text`: `conn_reconnecting`
- `theme`: `roles: { gpu, host, service }`
- queries: `queries/token_speed.sql`, `queries/token_total.sql`

### Notes

- **Stack row threshold** — a `direction: row` stack lays out horizontally only when
  its card is at least `min_row_width` wide (default `children × 180`); a narrower
  slot (e.g. a 4-column grid or a phone) wraps back to column. Lower `min_row_width`
  if your card slots are tighter than ~392px.

---

Initial release: `bf92853` — config-driven self-hosted homelab monitor (v2.0).
