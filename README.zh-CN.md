# HomeNet Hub

[English](README.md) · **简体中文**

一个**配置驱动、可自托管的局域网监控面板**。用几行 YAML 就能把你的机器和服务接进来——
不改代码、不用重新构建。clone 下来即可启动进入带**合成数据的实时 demo**,先看到整套效果
再接真实后端。

![HomeNet Hub 面板](docs/screenshot.png)

> 所有展示文案(标题、标签、分类、主题)都来自配置,可用**任意语言**书写。仓库自带示例是
> 英文;你的 `config/` 归你自己。

---

## 核心特性

- **配置驱动** — 加一台机器/服务只需改 YAML,保存即出卡;没有任何写死。
- **热重载** — 在宿主机改 YAML,面板约 3 秒内重塑。坏配置会被拒绝并保留上一份好配置
  (面板绝不黑屏)。
- **推送 agent,零入站端口** — 被监控机主动 POST 到 hub,自身**不开任何监听端口**。
  提供 **Linux**(bash + `/proc` + amdgpu sysfs / `nvidia-smi`)与 **Windows**
  (PowerShell 5.1 + `nvidia-smi`)双平台零依赖 agent。
- **身份色自动判定** — `color: auto` 按实时硬件判定卡片色:有 GPU→橙、纯主机→蓝、
  service→紫,随插拔卡实时切换。角色色可在 `theme.yaml` 覆盖。
- **组合布局** — `stack` 卡把多个 service 后端合进一个外框(row/column 自适应);
  历史图 N 屏对比(`panes: [...]`)。
- **采集器** — `http`(拉取)、`http_push`(机器主动推)、`sql`(只读 Postgres)、
  `exec`(白名单本地命令)、`demo`(合成)。
- **时序与 token 记账** — 内置 **SQLite** 历史与对比图;**Postgres** token 记账,给出
  全量累计总量 + 实时 tokens/秒。
- **可换肤 & 韧性** — 字体/配色走 `theme.yaml`;可见性感知轮询 + 断连角标,应对弱网移动端。
- **单容器** — `docker compose up` 即可。

---

## 架构

```text
被监控机
  ├─ Linux / Windows 推送 agent ──POST /api/push/:id(X-Push-Token)──┐  (机器侧不开入站端口)
  └─ http / sql / exec 数据源 ────按间隔拉取──────────────────────────┤
                                                                      ▼
  collectors ─► normalize(JSONPath 映射 + 指标模板 ─► value / level / display)
                                                                      │
                       ┌──────────────────────────────┬──────────────┴───────────────┐
                       ▼                               ▼                              ▼
              snapshot(内存最新)               tsdb(SQLite)              Postgres(token 记账)
                /api/snapshot                    /api/history                /api/token_detail

  config/*.yaml ──(chokidar 监听 + ajv 校验)──► /api/config(ETag)
                                                                      ▼
                              web/(原生 JS)从 /api/config + /api/snapshot 渲染
```

---

## 快速开始

```bash
git clone https://github.com/bevanho777-max/HomeNet-Hub.git
cd HomeNet-Hub
docker compose up -d --build
# 打开 http://192.168.x.x:3100
```

三步 → 带动画合成数据的 **demo 面板**。demo 不需要 `.env`、不需要 `config/`;应用会自动
回落到 `config.example/`。

不用 Docker:`npm install && npm start`(→ `http://127.0.0.1:3100`,改 `PORT` 换端口)。

---

## 接入真实机器(四步)

1. **把示例复制进你的私有配置**(`config/`、`.env` 已 git-ignore):

   ```bash
   cp -r config.example/* config/
   cp .env.example .env
   ```

2. **声明目标**(`config/targets.yaml`)——选一个 `source`,把它的 JSON 用 JSONPath
   映射到指标键;每个后端只改 `map`,其余保持通用:

   ```yaml
   - id: machine-1
     name: "Machine 1"
     color: auto                 # 或写 hex;auto = 按角色(GPU/主机/service)自动判定
     source: { type: http_push, token_env: PUSH_TOKEN_MACHINE1, stale_after_s: 10 }
     map:
       gpu:        "$.gpus[0].util_pct"
       vram_bytes: { v: "$.gpus[0].vram_used_gb", max: "$.gpus[0].vram_total_gb" }
       uptime:     { s: "$.uptime_s" }
   ```

3. **在 `.env` 里设密钥**(变量名与 `token_env` 一致):

   ```bash
   PUSH_TOKEN_MACHINE1=<your-token>       # 生成:openssl rand -hex 24
   ```

4. **在机器上跑 agent**(脚本顶部填 hub 地址 / id / token),常驻循环每约 2 秒推送一次:
   - Linux:`agents/homenet-agent.sh` —— systemd service
   - Windows:`agents/homenet-agent.ps1` —— 开机时由 Task Scheduler 拉起

在 `config/layout.yaml` 里给它加一张卡,保存,约 3 秒内出现。

---

## 契约与协议

- **推送协议** —— 机器→hub 的 JSON 契约、agent 要求与安装形态见
  [`docs/AGENT_PROTOCOL.md`](docs/AGENT_PROTOCOL.md)。
- **服务 `/stats`** —— service 卡换真值的可选集成(`{ procs, sessions, skills }`),
  见 [`config.example/targets.yaml`](config.example/targets.yaml) 里禁用的
  `*_real_example` 段。

---

## 安全

- **exec** 只跑内置白名单命令 + 校验过的参数(`ping_host` 要求私有 RFC1918 地址);
  绝不接受任意命令字符串。
- **sql** 只读;SQL 仅来自 `queries/*.sql`;唯一绑定参数是白名单整数。绝不执行来自
  config 或客户端的 SQL。
- **http_push** 校验 `X-Push-Token`;未知/错误 token 一律拒绝。
- 密钥(`PG_DSN`、push token)放 `.env`;`config/`、`data/`、`.env` 均 git-ignore,
  `config.example/` 可安全发布。**无内置鉴权** —— 若要暴露到可信局域网之外,请置于带
  鉴权的反向代理之后。

---

## 许可

[MIT](LICENSE)。
