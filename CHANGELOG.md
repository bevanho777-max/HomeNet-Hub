# Changelog

All notable changes since the initial release (`bf92853`).

Deploy on the host with:

```bash
cd <repo> && git pull && docker compose up -d --build
```

**Rebuild note:** `--build` is required whenever `server/` or `web/` changed (the
frontend is baked into the image). Commits that only touch `agents/` or `docs/`
need `git pull` alone. Each entry below is tagged accordingly.

**Releasing:** bump `version` in `package.json` and add the matching section heading
here, in the same commit. The panel reads that field at startup and shows it in the
page footer, so `package.json` is the authority — if the two ever disagree, the version
on screen is the one from `package.json`, and this file is what needs fixing.

> **发布约定:** 改 `package.json` 的 `version` 与新增本文件的章节标题,放在同一个提交里。
> 面板启动时读的是那个字段并显示在页脚,所以 `package.json` 是准的 —— 两者不一致时,
> 屏幕上显示的是 `package.json` 里的版本,该改的是本文件。

---

## v2.3 — 2026-09-01

**Add a machine by typing its IP.** Point the panel at a private IPv4 address and it
probes what is there — open ports, HTTP banners, TLS certificates, node_exporter — then
offers the capabilities those findings support. Pick some, and they become real targets
and cards, persisted in the database rather than in the read-only YAML. Four collectors
landed to serve them (tcp, tls, prometheus, plus discovery itself), and a capability
catalog is the one place that decides how a finding turns into something monitored.

> **输入一个 IP 就能加一台机器。** 给面板一个私网 IPv4 地址,它去探这台机器上有什么 ——
> 开放端口、HTTP 指纹、TLS 证书、node_exporter —— 然后列出这些发现能支撑的能力。勾选,
> 它们就变成真正的 target 和卡片,持久化在数据库里而不是只读挂载的 YAML 里。为此新增了
> 四个采集器(tcp / tls / prometheus,以及发现本身),并用一份能力目录作为"发现如何变成
> 被监控的东西"的唯一真源。

**Deploying this release:** everything below is `server/`+`web/`, so it needs
`docker compose up -d --build` on the host. Nothing new is required in `config/` —
runtime-added targets and credentials live in `data/homenet.db`, which the compose file
already mounts read-write. One **optional** new env: `VAULT_KEY`. Leave it unset and the
panel behaves exactly as it did, minus credential storage; set it (`openssl rand -base64
32`) to unlock the credential vault and the SSH capability.

> **本次部署方式:** 以下全部是 `server/`+`web/` 改动,要在宿主机上
> `docker compose up -d --build` 才生效。`config/` 无新增必填项 —— 运行时新增的目标与
> 凭据都存在 `data/homenet.db` 里,compose 早已把它挂成可写。新增一个**可选** env:
> `VAULT_KEY`。不设,面板行为和以前完全一样,只是不能存凭据;设了
> (`openssl rand -base64 32`)才解锁凭据金库与 SSH 能力。

### Discovery → add → see (发现→加→看见)

| Commit | Change | Rebuild |
|---|---|---|
| `3ebd37c` | read-only surface discovery — `GET /api/discover?host=`: bounded TCP port sweep, unauthenticated HTTP fingerprint (status / Server / `<title>`), TLS expiry, node_exporter detection; `server/net_guard.js` centralises the private-IPv4 rule and refuses link-local `169.254.0.0/16` | **yes** (server) |
| `25aa031` | runtime user store + effective-config layer — `user_targets` / `user_cards` in the existing SQLite file, merged onto the file config behind the same validate/crossValidate gate. With an empty store the effective config **is** the file config object, so an untouched install is byte-identical | **yes** (server) |
| `3d9078b` | `POST/GET/DELETE /api/user_targets` + capability catalog. The client sends `{host, capability, name?}` and nothing else: a target's `source` is what the scheduler executes, so it is built server-side from constants | **yes** (server) |
| `5f71da0` | catalog becomes the single source of truth (discovery's suggestions are generated from it, so a preview **is** what gets stored); tcp + tls collectors land | **yes** (server) |
| `39be889` | "＋ 添加目标" panel — discover, pick, add, and an added-list with delete. Pending capabilities stay visible and greyed with the reason | **yes** (web) |
| `56f2adf` | `config.example`: tcp/tls source shapes, and `interval`'s h/d units | no (config example) |

### Machine metrics without credentials (零凭据的机器指标)

| Commit | Change | Rebuild |
|---|---|---|
| `cb6aae9` | prometheus collector — one `/metrics` scrape becomes a standard machine card (CPU ring, memory, disk, network, uptime). The four `node_cpu/mem/disk/net` ideas collapse into ONE `node_metrics` capability: four targets would have scraped the same endpoint four times for one host's numbers | **yes** (server) |

### Credentials: encrypted vault + SSH deep collection (凭据金库 + SSH 深度采集)

Deep metrics for a host that runs no exporter and no agent — over SSH, with the password
or key encrypted at rest. A locked vault (no `VAULT_KEY`) refuses writes rather than
degrading to plaintext, so the feature is opt-in and its absence changes nothing.

> **凭据金库 + SSH 深度采集。** 既没有 exporter 也没有 agent 的机器,现在也能拿到深度
> 指标 —— 走 SSH,密码或私钥静态加密存放。金库未配置(无 `VAULT_KEY`)时拒绝写入而不是
> 退化成明文,所以这是个纯可选能力,不启用就等于不存在。

| Commit | Change | Rebuild |
|---|---|---|
| `48cd276` | credential vault — AES-256-GCM over `node:crypto`; key = `scrypt(VAULT_KEY, per-install salt)` derived once at boot; an encrypted verifier catches a WRONG key at startup instead of at first use (which would otherwise leave one database holding two generations of ciphertext). `POST/GET/DELETE /api/credentials` is a write-only door: no plaintext column, the listing never `SELECT`s the ciphertext, and no route returns a secret in any shape | **yes** (server+web) |
| `48cd276` | `ssh` collector + `ssh_metrics` capability — one session, one **constant** remote command (`/proc/stat`, `/proc/meminfo`, `df -kP /`, `/proc/net/dev`, `/proc/uptime`), parsed into the push agent's payload shape so it reuses the same map, templates and machine card. The target stores `credential_id`, never a secret. Host keys are TOFU and a **changed** key aborts in `hostVerifier` — before authentication, so an impostor on that address never receives the credential. `ssh_cpu`/`ssh_mem`/`ssh_disk` collapse into ONE capability for the same reason `node_metrics` is one | **yes** (server+web) |

### Version on screen (版本号上屏)

| Commit | Change | Rebuild |
|---|---|---|
| `3c7273b` | `package.json`'s `version` becomes the single source of truth (it had sat at `1.0.0` since the first release, so "which version is running" was unanswerable on a live system). Read once at startup, exposed through `/api/config` and `/healthz`, shown in the page footer. `VERSION` is folded **into** `computeEtag`, without which a tab polling with `If-None-Match` would keep getting 304 after a deploy and show the old version until someone hard-refreshed | **yes** (server+web) |

### Fixes (修复)

| Commit | Change | Rebuild |
|---|---|---|
| `eb6e4a3` | **chart**: a history line crossing a gap in the data was drawn as one straight segment between the samples either side, inventing a trend across a window where nothing was recorded. The line now breaks instead | **yes** (web) |
| `016e7d3` | **exec**: `sysreport_local`'s `net` returned kbps while `normalize.js` documents that field as bytes/sec — an ~8x error with the wrong unit suffix. Dormant (no target maps it), fixed before the first one does | **yes** (server) |
| `3ebd37c` `5f71da0` | private-IPv4 guard now refuses a leading-zero octet: `010.0.0.1` passed the old `\d{1,3}` check as 10.x while the resolver reads the leading zero as octal and dials 8.0.0.1. `exec.js` shares the guard instead of carrying its own copy | **yes** (server) |

### Config surface added this release

- `targets[].source.type`: `tcp` / `tls` (each requires `host` + `port`), `prometheus`
  (requires `url`), `ssh` (requires `host` + `credential_id`)
- `interval` / `timeout` accept `h` and `d` (`"1h"` previously parsed as one **second**)
- one new **optional** env: `VAULT_KEY` (≥16 chars; unset → the vault stays locked and
  the panel runs exactly as before). No new required field in `config/`.

### Notes

- Runtime-added targets are stored as the same object shape the YAML uses, so the
  scheduler, normalize, `publicConfig` and the whole frontend needed no changes.
- First boot on an existing database creates five empty tables (`user_targets`,
  `user_cards`, `credentials`, `vault_meta`, `ssh_known_hosts`). Rolling back to an
  earlier image leaves them in place, unread.
- **Losing `VAULT_KEY` means losing every stored credential** — they cannot be recovered
  from the database, which is the point. Changing it locks the existing ones out
  permanently; the cure is to delete and re-enter them under the new key.

---

## v2.2 — 2026-09-01

**Deeper views, cheaper history.** Machine cards now open their own multi-metric history
modal, charts name every line **on the plot** in the line's own colour instead of leaving
you to match colours against a legend, and the time-series store moved to a tiered layout
so long-range queries stay cheap as history accumulates. An LLM gateway card, per-drive
NAS temperatures and a dual-timezone header round out the panel.

> **视图更深,历史更省。** 机器卡可以点开自己的多指标历史弹窗;图表把每条线的名字**直接
> 标在图上**、用线本身的颜色,不再让人对着底部图例比色;时序库改为分级存储,历史越积越多
> 也不会拖慢长时段查询。另新增 LLM 网关卡、NAS 逐盘温度与双时区页眉。

**Deploying this release:** the view and time-series entries are `server/`+`web/`, so
they land only after `docker compose up -d --build` on the host. The agent-side entries
travel a different path — install the script on the machine that runs it and restart its
service (`sudo install -m 0755 agents/homenet-agent.sh /opt/homenet-agent/` +
`sudo systemctl restart homenet-agent`); rebuilding the hub does nothing for them.

> **本次部署方式:** 视图与时序两组是 `server/`+`web/` 改动,要在宿主机上
> `docker compose up -d --build` 才生效;agent 那两组走的是另一条路 —— 在跑它的机器上
> 安装脚本并重启服务(`sudo install -m 0755 agents/homenet-agent.sh /opt/homenet-agent/`
> + `sudo systemctl restart homenet-agent`),重建 hub 镜像对它们没有任何作用。

### Views (面板视图)

| Commit | Change | Rebuild |
|---|---|---|
| `b183fd6` | machine card → multi-metric history modal (24h/7d/30d, role-driven series, missing lines noted instead of drawn empty) | **yes** (server+web) |
| `06f02c0` | chart series named on the plot in their own colour — label gutter outside the plot area, collision-resolved with leader lines; shared by the modal and the compare panes | **yes** (web) |
| `0633b7c` | LLM gateway card — CPU / cache-hit / success rings, per-model request counts, 5-minute inbound rate | no (agents) |
| `a8bfe94` | NAS drive temperatures on the card — composite metrics gained per-segment colouring and superscript labels | **yes** (server+web) |
| `ca96b12` `7cafb31` `51b14d5` | dual-timezone header clock; day/night as an inline SVG sun / crescent | **yes** (web) |

### Time-series store (时序库)

| Commit | Change | Rebuild |
|---|---|---|
| `aec7155` | `metrics` covering index — history reads stop going back to the row | **yes** (server) |
| `b9697c6` | tiered downsampling — raw samples for the recent days, 5-minute buckets (min/max/avg/n) for about a month; the rolling job chunks its work and yields between chunks, and a delete is verified against its own aggregate inside the same transaction before it commits | **yes** (server) |
| `57b57e4` | read-side bucketing; fix a full-index scan when listing metric names | **yes** (server) |

### Gateway metrics (网关指标)

| Commit | Change | Rebuild |
|---|---|---|
| `dbd84ff` | litellm same-day figures read the `DailyUserSpend` pre-aggregate, bucketed by local date | no (agents) |
| `436a08c` | `reqs_5m` sums every litellm instance's inbound log — it counted one container, so it read 0 whenever traffic moved to another instance | no (agents) |
| `867abd9` | `LITELLM_CONTAINERS` documented in the agent protocol doc and the config examples | no (docs) |

### Fixes (修复)

| Commit | Change | Rebuild |
|---|---|---|
| `08dc7ea` `0576a4b` `2d91c34` et al. | assorted view and rendering fixes — VRAM series key, ring label not refreshing after a metric swap, card glow, history overlay/timeout handling, resize debounce and per-pane request de-duplication | **yes** (web) |

### Config surface added this release

- `metrics[]`: `divide` scaling, `level_map` text colouring, per-segment colours and
  superscript labels on composite metrics
- agent side (on the gateway host's `/etc/homenet-agent.env`, see
  [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md) §6.1): `LITELLM_PG_DSN`,
  `LITELLM_DB_CONTAINER`, `LITELLM_CONTAINERS`

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
