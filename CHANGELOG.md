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

## v2.11 — 2026-09-05

**网关卡改 chat-only:`success` 报的一直是 RAG 索引器的重试率,不是对话服务的健康度。**

*No rebuild — `agents/` + `config/` only. Reinstall the agent on the gateway host and
restart it; `config/` hot-reloads.*

这台网关全库 16,711,548 次请求里 16,692,468 次(**99.886%**)是 `mxbai-embed`,而且它
几乎全失败(成功 5,146 / 失败 16,686,876)—— RAG 侧的重试风暴。`success` /
`reqs_today` / `cache_hit` 之前全模型混算,于是卡上那个数由 embedding 的重试次数决定:

| 日期 | 含 embedding(旧) | 只算 chat(新) |
|---|---|---|
| 2026-07-13 | success **0.0%** · reqs 1,760,282 | success **93.9%** · reqs 231 |
| 2026-08-20 | success **0.4%** · reqs 321,276 | success **95.1%** · reqs 588 |
| 2026-08-25 | success 75.6% · reqs 1,151 | success **65.8%** · reqs 821 |
| 全库累计 | success **0.14%** · reqs 16,711,548 | success **92.01%** · reqs 19,080 |

注意 08-25 是**反方向**的:那天失败的是 chat 侧,embedding 把它兑得好看了 —— 两个方向
都失真,因为混合权重跟对话服务无关。`cache_hit` 是 token 加权的,embedding 只占全库
`prompt_tokens` 的 0.066% 且 `cache_read` 恒为 0,实际偏差 ≤0.7pp;一并过滤只是为了让
四个数出自同一个子集,不是因为它算错了。

排除模式复用 `queries/project_tokens.sql` 那一份(`embed` / `bge` / `gte-` / `rerank`),
两处口径从此是同一个定义。

**embedding 没有被藏起来。** `reqs_by_model` 仍是全模型,`emb` 槽照发 —— 风暴期它就是
"数字不对是因为 RAG"的那条线索。四个槽之和因此**不等于** `Chat Requests`,这是刻意的。
近 5 分钟的 embedding 量单独走新字段 `reqs_5m_embed`:默认不上卡,但进 sqlite 时序,
`/api/history` 里能对照 `reqs_5m` 复盘一次暴涨到底来自哪边。

**`reqs_by_model` 补上第四个槽 `other`。** 它此前在 SQL 里算了却从不发出,于是全库请求数
第一的 chat 模型 `qwen3.6-27b-main-128k`(11,548 次)整个落在里面、卡上完全看不到 ——
2026-07-13 那天 226 次请求就是这么消失的,而 `27b` 槽显示 0。同时 `27b` / `35b` 的匹配从
写死的 `%qwen3.8-27b%` / `%qwen3.6-35b%` 放宽到 `%27b%` / `%35b%`,换个小版本号的部署名
不会再静默掉进 `other`。`is_emb` 先判,免得将来名字里同时含 `bge` 和 `27b` 的向量模型
被归进 chat 槽。

**"没数据"和"今天零次对话"分开了。** SQL 多带一个全模型请求数出来判断桶存在性:北京
00:00-08:00 目标桶尚未创建 → `reqs_today` / `reqs_by_model` 整体省略、卡上显 "—"(和以前
一样);桶存在但当天只有 embedding 流量 → `reqs_today` 记 **0**(确实零次对话)而不是
"—",`by_model` 照常发出 `emb` 槽。以前这两种情况在新口径下会被混成同一个"—"。

卡面文案跟着改:`Requests` → `Chat Requests`,`Last 5m` → `Chat · Last 5m`。两个圆环的
label 保持 `Cache` / `Success` 短词 —— `.ring-label` 没有宽度约束,写成 `Chat Success`
会把三环那一行挤换行;口径写在有空间的 KV 项标题和 `docs/AGENT_PROTOCOL.md` 里。

---

## v2.10 — 2026-09-04

**Housekeeping release: one CSS rule that fixes a whole class of bug, and the docs
caught up to v2.9.**

`el.hidden = true` now actually hides the element, everywhere. The browser's own
`[hidden]{display:none}` lives in the UA stylesheet, which **any** author `display`
beats on specificity — so every element this project gave a `display` to silently
ignored its own `hidden` attribute. Five places had already hit this and patched it
locally (`.addOpen`, `.addFoot`, `.credLocked`, `.histErr`, `.demoBar`); the ones nobody
had hit yet were simply broken. `header.clock: false` was one of them: it set the
attribute and the clock stayed on screen. There is now a single global
`[hidden]{display:none!important}` and the five local copies are gone, so the next
element to get a `display` cannot reintroduce the bug.

Documentation is updated to v2.9 throughout: the first-run setup wizard and why its
endpoint is so narrow, the demo bar and what "清空演示" actually does, changing the admin
password from the UI, and the per-project token card — why it groups by API key rather
than by user, why embeddings are excluded, and why rows only appear once you mint
per-project keys. Two new screenshots, the endpoint gate table and the environment table
brought current, and `ADMIN_PASSWORD` correctly described as optional since v2.8.

> **收尾发布:一条 CSS 规则根治一类 bug,文档补齐到 v2.9。**
>
> `el.hidden = true` 现在真的能隐藏元素了,所有地方都是。浏览器自带的
> `[hidden]{display:none}` 在 UA 样式表里,**任何**作者样式的 `display` 都能凭优先级
> 压过它 —— 所以本项目里每个被写了 `display` 的元素,都在悄悄无视自己的 `hidden` 属性。
> 已经有五处踩到并各自打了本地补丁(`.addOpen`、`.addFoot`、`.credLocked`、`.histErr`、
> `.demoBar`);没人踩到的那些就是坏的。`header.clock: false` 就是其中之一:属性设上了,
> 时钟照样显示。现在只有一条全局的 `[hidden]{display:none!important}`,五处本地副本删掉,
> 于是下一个拿到 `display` 的元素不可能再把这个 bug 带回来。
>
> 文档整体补齐到 v2.9:首次运行向导以及它的端点为什么条件这么窄、演示引导条和
> 「清空演示」到底做了什么、在界面里改管理密码、以及每项目 token 卡 —— 为什么按 API key
> 而不是按 user 分组、为什么排除 embedding、为什么要发出分项目的 key 之后才会分行。
> 新增两张截图,端点闸门表和环境变量表更新到位,`ADMIN_PASSWORD` 也正确地标注为
> 自 v2.8 起可选。

**Deploying this release:** `web/` only, but the frontend is baked into the image, so it
still needs `docker compose up -d --build`. No server code changed — `/api/config` is
byte-identical to v2.9, ETag included. No database change.

> **本次部署方式:** 只动了 `web/`,但前端是烤进镜像的,所以仍然需要
> `docker compose up -d --build`。服务端代码一行没改 —— `/api/config` 与 v2.9 逐字节
> 一致,连 ETag 都一样。数据库无需改动。

---

## v2.9 — 2026-09-04

**A fresh install now says that its board is a demo, and can clear it in one click.**
`docker compose up` falls back to `config.example/`, so the first thing anyone sees is
somebody else's machines — with nothing on screen saying so, and no way to get rid of
them short of learning the YAML layout. There is now a banner that says what the board
is, a button that opens the existing add-target flow, and a button that clears the demo
for good.

Clearing writes a flag rather than deleting anything: `config.example/` ships inside the
image and `config/` may be a read-only mount. The loader then keeps falling back for
metric templates and theme — without those there is nothing to render your own card
*with* — and empties only the demo board itself: the example targets, their cards, the
status bar, and the history pane. The collectors are rescheduled in the same step, so the
example targets stop being polled as well as stop being drawn. What is left is an empty
board that says how to add your first machine, plus anything you have already added.

Two dismissals that deliberately do not share state: the banner's **×** hides it in your
browser only (`localStorage`), while **清空演示** is a management action — it needs a
session, it is confirmed, and it applies to everyone who opens this install. An install
with a real `config/` was never on the demo board and never sees any of this.

> **新装的实例现在会说清楚"这块板子是演示",并且一键就能清掉。** `docker compose up`
> 会回退到 `config.example/`,所以打开第一眼看到的是别人的机器 —— 而屏幕上没有任何
> 说明,想去掉还得先学会 YAML 布局。现在有一条横幅说明这块板子是什么,一个按钮直接
> 打开原有的添加目标流程,还有一个按钮把演示彻底清掉。
>
> 清空写的是一个标志位,而不是删文件:`config.example/` 打包在镜像里,`config/` 还可能
> 是只读挂载。清空之后 loader 仍然为指标模板和主题回退 —— 没有它们,你自己的卡片根本
> 没东西可渲染 —— 只清掉演示板本身:示例目标、它们的卡片、状态栏、以及历史面板。
> 采集器在同一步重新调度,所以示例目标不只是不再显示,而是真的不再被轮询。剩下的是一块
> 空板,上面写着怎么添加你的第一台机器,以及你自己已经加过的东西。
>
> 两种"关掉"故意不共用状态:横幅上的 **×** 只在你这个浏览器里隐藏(`localStorage`),
> 而**清空演示**是管理操作 —— 要登录、要确认,而且对所有打开这个实例的人都生效。
> 已经有真实 `config/` 的实例从来就不在演示板上,这一切都不会出现。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
No database change — the flag's table is created on demand. An install with its own
`config/` sees no behaviour change at all; `/api/config` gains one boolean, `demo_mode`,
and is otherwise byte-identical.

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> 数据库无需改动 —— 存标志位的表按需创建。已有自己 `config/` 的实例行为完全不变;
> `/api/config` 多了一个布尔字段 `demo_mode`,其余逐字节一致。

---

## v2.8 — 2026-09-04

**A fresh install can now get its admin password from the browser instead of from a text
editor.** Until now the only way to unlock the management endpoints was to write
`ADMIN_PASSWORD` into `.env` and restart — fine for the person who built the thing, a
cliff for anyone else. A brand-new install now shows a one-time "set the admin password"
box on first load, and setting it logs you straight in.

Nothing about the fail-closed contract moved. The endpoint that creates the password is
the narrowest one in the project:

- **It exists only while nothing can already manage the install** — no `admin_auth` row
  and no `ADMIN_PASSWORD`. After that it answers `409` forever. There is no reset path
  over HTTP, deliberately; recovery is still `DELETE FROM admin_auth;` and a restart,
  which needs access to the host.
- **It only answers callers on the local network.** Someone who finds a fresh install
  exposed to the internet must not be able to claim it before its owner does. The check
  does *not* use the framework's client IP: with `trustProxy` on, that is the leftmost
  `X-Forwarded-For` entry, which the caller writes. It uses the rightmost entry — the one
  the nearest proxy added and the caller could not forge — and requires the socket peer
  to be private as well.
- **One at a time.** Two simultaneous requests produce exactly one `200`; the loser gets
  `409`. The real arbiter is the database's `ON CONFLICT DO NOTHING`, so it holds across
  processes and not just within one.
- Rate limited on its own budget, so a mistyped confirm box on a new install can never
  walk anyone toward the login lockout.

The password takes the same path as the other two ways that row is created — scrypt over
a fresh random salt, straight into the database. It is never logged, echoed, or returned.
Setting `ADMIN_PASSWORD` still works exactly as before and simply means the wizard never
appears.

> **新装的实例现在可以在浏览器里设管理员密码,不用再去编辑器里改文件。** 在此之前解锁
> 管理端点的唯一办法是往 `.env` 里写 `ADMIN_PASSWORD` 再重启 —— 对自己搭的人没问题,
> 对别人是道坎。全新实例第一次打开时会出现一次性的"设置管理员密码"框,设完直接登录。
>
> fail-closed 的约定一条没动。创建密码的这个端点是全项目条件最窄的一个:
>
> - **只在"还没有任何东西能管理这台机器"时存在** —— 既没有 `admin_auth` 行,也没有
>   `ADMIN_PASSWORD`。设过之后永远返回 `409`。HTTP 上没有重置路径,这是故意的;
>   找回密码仍然是 `DELETE FROM admin_auth;` 加重启,那需要机器本身的访问权。
> - **只接受局域网内的调用方。** 谁要是发现一台暴露在公网上的新实例,不能让他抢在
>   主人前面把管理员占了。这个判断**没有**用框架给的 client IP:开了 `trustProxy` 之后
>   那是 `X-Forwarded-For` 最左边一项,而那一项是调用方自己写的。用的是最右边一项 ——
>   最近一跳代理自己加的、调用方伪造不了的那个 —— 并且要求 socket 对端也是私网地址。
> - **同一时刻只允许一个。** 两个并发请求恰好只有一个 `200`,另一个 `409`。真正裁决的是
>   数据库的 `ON CONFLICT DO NOTHING`,所以跨进程也成立,不只是进程内。
> - 限速用自己独立的额度,所以新装机上把确认框打错几次,绝不会把人推向登录的锁定。
>
> 密码走的是那一行本来就有的两条创建路径同一条:新随机盐上的 scrypt,直接进数据库。
> 不记日志、不回显、不返回。设了 `ADMIN_PASSWORD` 的行为和以前完全一样,只是向导不出现。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
An install that already has an admin password sees no change at all — same login box,
same everything. No database change.

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> 已经设过管理员密码的实例完全没有变化 —— 还是那个登录框,一切照旧。数据库无需改动。

---

## v2.7 — 2026-09-04

**The per-project token card now splits by API key instead of by the client's `user`
field.** v2.6 grouped on LiteLLM's end-user table, which is exact but only fills in for
callers that bother to send `user` — in practice almost nobody does, so the card sat at
one row waiting on changes to every client. Grouping on `api_key` needs no client
cooperation at all: a project gets its own row the moment it gets its own virtual key,
which is a credential it already has to configure anyway.

Rows are labelled `(master key)` for traffic on the configured master key, `key:<8 hex>`
for a minted key, and the literal (truncated) for anything else — health-check
pseudo-keys and scanner probes stay visible rather than silently vanishing. Keys that
produced no chat tokens at all are dropped: those are rejected probes, not usage.

Readable aliases are deliberately not joined. LiteLLM keeps `key_alias` in a table a
read-only role needs a second grant for, and that join still cannot name the master key
— it is a config literal with no row there, and on a gateway where everything shares one
credential that is the row carrying essentially all the traffic. Mint a couple of real
keys first; the alias grant is worth adding after that, not before.

> **每项目 token 卡改成按 API key 拆,不再按客户端传的 `user` 字段。** v2.6 用的是
> LiteLLM 的 end-user 表,准是准,但只有主动传 `user` 的调用方才有数据 —— 实际上几乎
> 没人传,于是卡停在一行,等着每个客户端都改一遍。按 `api_key` 分组完全不需要客户端
> 配合:项目拿到自己的 virtual key 就自动有了自己的一行,而 key 本来就是它要配的东西。
>
> 行标签:走配置里主口令的流量显示 `(master key)`,签发出来的 key 显示 `key:<8位hex>`,
> 其余字面量原样截断 —— 健康检查的伪 key 和扫描探测仍然可见,而不是被悄悄抹掉。
> 完全没产生 chat token 的 key 会被滤掉:那是被拒的探测,不是用量。
>
> 可读的 alias 名是刻意不 join 的。LiteLLM 把 `key_alias` 放在另一张表,只读账号要再补
> 一条授权才能读,而且那个 join 依然叫不出 master key 的名字 —— 它是配置里的字面量,
> 那张表里根本没有它的行,偏偏在所有人共用一把口令的网关上,它就是几乎扛下全部流量的
> 那一行。先发出几把真的 key,alias 的授权那时候才值得补。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
No database change — this release adds and revokes nothing.

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> 数据库无需改动 —— 本次不新增也不撤销任何授权。

---

## v2.6 — 2026-09-04

**Token usage can now be split per project.** The token card answers "which model";
this one answers "whose traffic". A new `Per-Project Tokens` card lists one row per
client — cumulative chat tokens, request count, and the last 7 days — read from
LiteLLM's daily end-user aggregate. Two things make it honest. It groups by
**end user** (the OpenAI `user` field the client sends), not by key owner: LiteLLM
keeps those in two different tables, and a caller passing `user: "billing"` shows up
in the end-user one and nowhere else, so a project opts into its own row without
anyone minting it a key. And it **excludes embedding and rerank models**, which on a
gateway doing RAG are >99% of requests and <0.1% of tokens — leaving them in makes
the request column measure indexing runs instead of conversations.

Expect a short card at first. Rows exist only for clients that actually send `user`;
the receiving end is simply in place ahead of the callers.

Underneath it is a general mechanism, not a one-off: a `shape: table` sql source hands
its rows to the frontend untouched, and a `type: table` card names and formats the
columns from `layout.yaml`. Another table card is another `.sql` file plus a layout
block — no code.

> **Token 用量现在能按项目拆开了。** Token 卡回答"哪个模型",这张卡回答"谁在用"。
> 新的 `Per-Project Tokens` 卡每个客户端一行 —— chat token 累计、请求数、近 7 天 ——
> 数据来自 LiteLLM 的每日 end-user 聚合表。两点让它说的是实话。它按 **end user**
> (客户端传的 OpenAI `user` 字段)分组,而不是按 key 的所有者:LiteLLM 把这两者
> 记在不同的表里,一个传了 `user: "billing"` 的调用只会出现在 end-user 那张表,
> 所以项目不需要谁给它发 key 就能自己长出一行。它还**排除 embedding 与 rerank 模型**
> —— 在跑 RAG 的网关上这类流量占请求数 >99%、占 token <0.1%,不排的话请求数那一列
> 量的就是索引任务而不是对话。
>
> 一开始卡上行数会很少。只有真的传了 `user` 的客户端才有行;这只是接收端先就位、
> 等客户端来打 id。
>
> 底下是一套通用机制而不是一次性代码:`shape: table` 的 sql 源把查询结果原样交给前端,
> `type: table` 卡在 `layout.yaml` 里决定列名与数字格式。再加一张表格卡 = 一个 `.sql`
> 文件加一段 layout,不用改代码。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
**The read-only DB role needs one new grant**, or the card reports the error instead of
rows — a grant on `LiteLLM_DailyUserSpend` does not cover the end-user table:

```sql
GRANT SELECT ON TABLE "LiteLLM_DailyEndUserSpend" TO <your_readonly_role>;
```

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> **只读数据库账号需要补一条授权**,否则卡上显示的是报错而不是数据 —— 对
> `LiteLLM_DailyUserSpend` 的授权并不覆盖 end-user 那张表(上面那条 SQL,
> 要在 psql 里跑,不是 bash 命令)。

---

## v2.5 — 2026-09-03

**The admin password can now be changed from the panel, and it no longer lives in an
env var.** v2.4 compared the submitted password against `ADMIN_PASSWORD` directly, which
meant the only way to rotate it was to edit `.env` and redeploy — and that the plaintext
sat in the container's environment for the life of the process. It now lives hashed in
`data/homenet.db`, and `ADMIN_PASSWORD` is demoted to a one-time bootstrap.

> **管理密码现在能在面板里改了,而且不再住在环境变量里。** v2.4 是拿提交上来的密码直接
> 和 `ADMIN_PASSWORD` 比,所以想轮换密码只能改 `.env` 再重新部署;而且明文在整个进程
> 生命周期里都留在容器环境中。现在它以哈希形式存在 `data/homenet.db` 里,
> `ADMIN_PASSWORD` 降级为一次性引导。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
**Everyone gets logged out once.** The session signing key moved from
`scrypt(ADMIN_PASSWORD, …)` to a random secret in the database, so every cookie issued
by v2.4 fails verification after the upgrade. That is a one-time event at this upgrade
only — from here on a restart or a rebuild does not log anyone out, and only a password
change does. **Keep `ADMIN_PASSWORD` in `.env`**: the first boot after the upgrade uses
it to create the `admin_auth` row, and it stays the recovery path for a forgotten
password.

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> **所有人会被登出一次。** 会话签名密钥从 `scrypt(ADMIN_PASSWORD, …)` 换成了数据库里的
> 随机 secret,所以 v2.4 签发的每一枚 cookie 在升级后都验不过。这只发生在这一次升级 ——
> 此后重启与重建镜像都不会踢人,只有改密才会。**`.env` 里的 `ADMIN_PASSWORD` 请保留**:
> 升级后第一次启动要靠它创建 `admin_auth` 行,而且它此后是忘记密码时的恢复路径。

### Admin password change (管理员改密)

| Commit | Change | Rebuild |
|---|---|---|
| — | `admin_auth`, a one-row table beside the credentials and timeseries: **scrypt** hash + per-install random salt + a random 32-byte session signing secret. No plaintext column, and no route that reads any of the three back. Its own better-sqlite3 handle, mirroring `UserStore`/`CredStore` | **yes** (server) |
| — | password priority: the `admin_auth` row is authoritative once it exists; `ADMIN_PASSWORD` only **bootstraps** it on an install that has none, and is inert afterwards; neither → the same fail-closed 401 as before. An env password that fails the length rules does **not** bootstrap — a too-short value leaves the install locked rather than installing a password nobody can then change to | **yes** (server) |
| — | escape hatch: `DELETE FROM admin_auth;` + restart re-bootstraps from `ADMIN_PASSWORD`. That is the documented forgotten-password recovery, and the reason the env var is still read after the first boot | **yes** (server) |
| — | `POST /api/admin/password` — admin session **+** same-origin **+** the current password **+** the same 8-256 length rule. On success it re-hashes under a fresh salt, rotates the signing secret in the same write (which is what invalidates every other session — no revocation list could cover a cookie this process never saw), and hands the caller a freshly signed cookie so the person changing the password is not logged out by their own action | **yes** (server) |
| — | the change endpoint shares the **login** rate limiter: the current-password field is a second place to guess at the same secret, and separate budgets would hand an attacker twice the attempts by alternating endpoints. A too-short *new* password does not count against it — a typo about your own account must not lock you out | **yes** (server) |
| — | one password change in flight at a time (409 otherwise). There is an `await` between "is the current password right" and "write the new one", so two concurrent calls could both pass the check and both write — leaving the first caller a `200` and a cookie signed with a secret that no longer existed | **yes** (server) |
| — | frontend: a **改密** button in the admin header opening a three-field panel (current / new / confirm). All three are cleared on **every** path out of a submit — success, rejection, mismatch, network failure — because a password left sitting in the DOM is one "inspect element" away from being displayed | **yes** (web) |

### Security notes

- **Why the signing secret is not derived from the password hash.** The hash is
  *verification* material — a value untrusted input is compared against. The secret is
  *forgery* material — anything holding it can mint a session. Deriving one from the
  other collapses the two roles, so any future accident that exposes the hash (a debug
  route, an error path, a log line) would hand out session forgery on top of an offline
  cracking target. It also decouples session lifetime from the hash's *encoding*:
  re-tuning the scrypt cost later would otherwise log every admin out as a side effect.
- **Why scrypt rather than the sha256 comparison v2.4 used.** The digest is now at rest
  in a database file that travels in backups. A bare sha256 of a password is trivially
  attacked offline; scrypt with a per-install random salt prices that attack.
- **Verification moved off the event loop.** scrypt costs ~50-100ms, and doing that
  synchronously once per login attempt is a denial-of-service lever the rate limiter
  alone should not have to carry. `node:crypto`'s async `scrypt` runs it on the
  threadpool; measured, a `/api/snapshot` issued while a password change is deriving
  still answers in ~3ms.
- **A password length cap (256) is new.** Verification is now a real key derivation
  rather than a hash, so an unbounded password would let one request buy an arbitrary
  amount of work. Applied identically on login, on bootstrap and on change, so a
  password that can be set is always a password that can be used.
- Neither password appears in a response, a log line, an error or the database. The
  `[auth:DENY]` line for a failed change carries the client IP and nothing else.

### Config surface added this release

- no new env. `ADMIN_PASSWORD` keeps its name and its shape; only its **meaning**
  narrows, from "the password" to "the password this install is created with".
- one new table, `admin_auth`, created on first boot like the other four.

---

## v2.4 — 2026-09-03

**The management side of the panel now has a lock on it.** Discovery, adding and
deleting runtime targets, and the whole credentials API sat behind nothing: anyone who
could reach the port could write to them. They now require an admin session, and the
default with no password configured is **401 on every one of them** — an unset env is a
locked install, never an open one.

> **管理面终于上锁了。** 发现主机、增删运行时目标、整个凭据 API,在此之前谁能连上端口
> 谁就能调。现在它们要求管理员会话,而且没配密码时的默认行为是**全部 401** ——
> env 忘了填意味着锁死,绝不意味着敞开。

**Deploying this release:** `server/`+`web/`, so `docker compose up -d --build`.
**Set `ADMIN_PASSWORD` when you deploy this** (`openssl rand -base64 24`, ≥8 chars) —
without it the panel still shows every card exactly as before, but "＋ 添加目标" and
"凭据" disappear and their endpoints answer 401. Viewing is unchanged and stays public
unless you also set the optional `REQUIRE_LOGIN_TO_VIEW=1`.

> **本次部署方式:** `server/`+`web/`,需要 `docker compose up -d --build`。
> **部署时请一并设置 `ADMIN_PASSWORD`**(`openssl rand -base64 24`,≥8 字符)——
> 不设的话看板照常显示所有卡片,但"＋ 添加目标"与"凭据"会消失,对应端点一律 401。
> 只读浏览不受影响、默认仍然公开,除非额外打开可选的 `REQUIRE_LOGIN_TO_VIEW=1`。

### Admin auth (管理鉴权)

| Commit | Change | Rebuild |
|---|---|---|
| `86cf554` | password gate + signed session cookie. `POST /api/login` compares the password in constant time and drops it — the value, its length and any hash reach neither the response, the log line nor an error. The session is a signed cookie, not a server-side table: the HMAC key is `scrypt(ADMIN_PASSWORD, fixed salt)`, so **changing the password invalidates every outstanding session** with no revocation list, and a restart does not log everyone out (a per-boot random key would, on every rebuild). Logout still revokes server-side — deleting only the browser's copy would leave a cookie captured beforehand good for the rest of its 12 h. Cookie is HttpOnly + SameSite=Strict, and `Secure` follows the **request's** protocol so a direct LAN `http://` hit gets a cookie the browser will actually send back | **yes** (server+web) |
| `86cf554` | login rate limit in two tiers — per client IP (`X-Forwarded-For` under `trustProxy`) and per socket peer. The second tier is what bounds an attacker rotating the header we chose to believe. Exponential backoff from the 6th failure, capped at 15 min; the gate is checked **before** the password, so a correct password during a lockout is still 429 | **yes** (server) |
| `86cf554` | every management route gated: `GET /api/discover`, `POST/DELETE /api/user_targets`, and `POST/GET/DELETE /api/credentials`. Writes additionally check `Origin` (a missing `Origin` is allowed on purpose: no browser omits it on a cross-site request that could carry a cookie, so its absence means a non-browser caller with no ambient cookie to abuse). Optional `REQUIRE_LOGIN_TO_VIEW` extends the same gate to `/api/config`, `/api/snapshot`, `/api/history` and `/api/token_detail` | **yes** (server) |
| `86cf554` | frontend session state — admin controls start hidden and are revealed by `/api/session`, so the header never flashes buttons the server would refuse; a 401 from a data poll flips the connection badge to "Login required" and brings the login entry back instead of leaving the page on "Disconnected". The password field is cleared on every outcome, including failure. Hiding is cosmetic and says so in the file: the server refuses either way | **yes** (web) |

### Config surface added this release

- two new **optional** envs: `ADMIN_PASSWORD` (≥8 chars; unset → every management
  endpoint answers 401) and `REQUIRE_LOGIN_TO_VIEW` (default off → the board stays
  public). No new required field in `config/`.
- one new `layout.yaml` text key: `conn_locked` (falls back to `Login required`).

### Notes

- Nothing is stored for this: no user table, no session table on disk. The only
  server-side state is an in-memory revocation map for logged-out sessions, pruned by
  expiry, plus the rate limiter's bounded map. A restart forgets both — the same
  exposure a restart already had, since the signing key comes from the password rather
  than from boot.
- `/healthz` reports `admin: { configured, require_login_to_view }` — booleans only,
  nothing derived from the password.
- Sessions last 12 h. Changing `ADMIN_PASSWORD` ends all of them immediately.

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
