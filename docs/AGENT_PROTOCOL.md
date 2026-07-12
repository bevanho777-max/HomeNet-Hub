# HomeNet Hub Agent 推送协议 v1(AGENT_PROTOCOL.md)

> 本文档是 agent 与服务端之间的**唯一契约**。agent 脚本、服务端 `http_push` collector、`targets.yaml` 配置三方都必须与本文一致;发现现有实现与本文有出入时,以本文为准修改实现(一次一改)。

---

## 1. 设计原则

- **推送模式(push)**:agent 主动 POST 到 Hub,被监控机**不开任何入站端口**。
- **零依赖**:Linux 端纯 bash + coreutils + `/proc`;Windows 端纯 PowerShell 5.1 内置命令。不装 Python、不装 node、不装任何包。GPU 数据依赖机器上本就存在的 `rocm-smi` / `nvidia-smi`,没有则不报 GPU。
- **常驻循环进程**:agent 是一个内部 `sleep 2` 循环的长驻脚本。systemd(Linux)/ Task Scheduler(Windows)只负责开机拉起与崩溃重启,**不是**每 2 秒触发一次(Task Scheduler 最小重复间隔 1 分钟,systemd timer 每 2 秒 fork 全套采集进程开销过大)。
- **采集失败不致命**:某项采不到就省略该字段,agent 循环永不因单项失败退出;HTTP 推送失败静默丢弃,等下一个周期。

## 2. 传输层

| 项 | 约定 |
|---|---|
| 端点 | `POST http://<HUB_HOST>:3100/api/push/:id` |
| `:id` | 机器标识,`m` + IP 末段,如 `m110` / `m26` / `m25`(实现中路由参数名为 `:targetId`,路径等价) |
| Content-Type | `application/json; charset=utf-8` |
| 鉴权 | 请求头 `X-Push-Token: <token>`;token 变量名由 `targets.yaml` 对应目标的 `source.token_env` 声明,值放在 Hub 侧 `.env`(如 `token_env: PUSH_TOKEN_GPU1`) |
| 超时 | agent 侧连接+响应总超时 **1 秒**;超时即放弃本次,不重试 |
| 载荷上限 | 8 KB;超限服务端返回 400 |

### 服务端响应

| 状态码 | 含义 | agent 行为 |
|---|---|---|
| 200 | 接收成功,`{ "ok": true, "target": "<id>", "ts": <ms> }` | 忽略响应体 |
| 400 | JSON 非法 / 超限 / 缺必填字段 | 静默,下周期重试(JSON 解析失败时响应体为 Fastify 默认错误形状,仅状态码保证为 400) |
| 401 | token 错误 | 静默,下周期重试 |
| 404 | `:id` 未在 `targets.yaml` 注册 | 静默,下周期重试 |

agent 对任何响应都不做分支处理,唯一职责是"采集→推送→睡 2 秒"。

## 3. 推送频率与失效判定

- **推送间隔:2 秒**(循环体内 `sleep 2`,即实际周期 ≈ 2s + 采集耗时)。
- **失效判定(服务端)**:某 id 超过 **10 秒**(约 5 个周期)无有效推送 → 该机器标记 offline,前端对应字段显示 `—`。
- 服务端以**收到请求的本地时间**做失效判定;载荷里的 `ts` 仅作参考,不参与判定(避免机器间时钟偏差引发误判)。

## 4. JSON 载荷 v1

### 4.1 顶层结构

```json
{
  "v": 1,
  "id": "m26",
  "ts": 1783862300,
  "os": "linux",
  "uptime_s": 1291800,
  "cpu":  { "pct": 6.2, "load": [3.61, 3.29, 3.07] },
  "mem":  { "used_gb": 12.8, "total_gb": 47.0 },
  "disk": { "used_gb": 166, "total_gb": 244 },
  "net":  { "rx_bps": 2048, "tx_bps": 10240 },
  "gpus": [
    {
      "idx": 0,
      "name": "RX 7900XTX",
      "util_pct": 0,
      "vram_used_gb": 21.6,
      "vram_total_gb": 24.0,
      "temp_c": 31,
      "power_w": 8
    }
  ],
  "extra": {}
}
```

### 4.2 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | int | ✅ | 协议版本,固定 `1` |
| `id` | string | ✅ | 与 URL `:id` 一致;不一致服务端返回 400 |
| `ts` | int | ✅ | agent 本机 Unix 秒 |
| `os` | string | ✅ | `"linux"` 或 `"windows"` |
| `uptime_s` | int | — | 开机秒数 |
| `cpu.pct` | number | — | 总 CPU 使用率 0–100,1 位小数 |
| `cpu.load` | number[3] | — | 1/5/15 分钟负载,**仅 Linux**;Windows 省略整个 `load` |
| `mem.used_gb` / `mem.total_gb` | number | — | 内存,GB,1 位小数 |
| `disk.used_gb` / `disk.total_gb` | number | — | 主数据盘(Linux `/`,Windows `C:`),GB,整数即可 |
| `net.rx_bps` / `net.tx_bps` | int | — | 主网卡收/发速率,**字节/秒**(由两个周期间计数器差值算得;单位统一 B/s,前端负责格式化为 K/M) |
| `gpus` | array | ✅ | **固定为数组**,0 / 1 / N 块卡;无 GPU 机器报 `[]` |
| `gpus[].idx` | int | ✅ | 卡序号,从 0 起 |
| `gpus[].name` | string | — | 卡名,如 `"RX 7900XTX"` |
| `gpus[].util_pct` | number | — | GPU 利用率 0–100 |
| `gpus[].vram_used_gb` / `vram_total_gb` | number | — | 显存,GB,1 位小数 |
| `gpus[].temp_c` | int | — | 温度 ℃ |
| `gpus[].power_w` | int | — | 实时功耗 W |
| `extra` | object | ✅ | 自由扩展区,允许空对象;机器特有数据放这里(见 4.4) |

### 4.3 缺失与空值规则

- **采不到 = 不写该字段**(省略,而不是写 `null` 或 `0`)。前端对缺失字段显示 `—`。
- 数值一律为 JSON number,**不带单位、不带字符串包装**(❌ `"31°C"` ✅ `31`)。
- 服务端遇到**未知字段一律忽略**,不报错——这是向后兼容的基础。

### 4.4 `extra` 约定(现役)

| key | 机器 | 说明 |
|---|---|---|
| `extra.claude.remaining_min` | m110 | Claude Max 窗口剩余分钟,沿用 `claude-window.json` 自记录算法 |
| `extra.claude.block_id` | m110 | 当前计费窗口 id |

新增机器特有数据只允许加进 `extra.<命名空间>.*`,不得污染顶层。顶层字段的增删必须升 `v` 并更新本文档。

## 5. 采集实现要求

### 5.1 Linux(`agents/homenet-agent.sh`)

| 数据 | 来源 |
|---|---|
| cpu.pct | 两个周期间 `/proc/stat` 首行差值(循环内保存上次快照,**不额外 sleep**) |
| cpu.load | `/proc/loadavg` 前三列 |
| mem | `/proc/meminfo`(MemTotal − MemAvailable) |
| disk | `df -B1 /` |
| net | 两个周期间 `/proc/net/dev` 主网卡计数器差值 ÷ 周期秒数 |
| uptime | `/proc/uptime` |
| GPU(AMD) | `rocm-smi --showuse --showmemuse --showtemp --showpower --json`(启动时探测一次可用性) |
| GPU(NVIDIA) | `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` |
| 推送 | `curl -sf -m 1 -H "X-Push-Token: $TOKEN" -H "Content-Type: application/json" -d "$payload" "$URL"` |

配置经环境变量注入:`HUB_URL`、`AGENT_ID`、`PUSH_TOKEN`、`NET_IFACE`(可选,默认取默认路由网卡)。**脚本内不出现任何 HTTPS_PROXY/HTTP_PROXY 设置**;curl 加 `--noproxy '*'`,确保局域网推送不被宿主机代理环境劫持。

### 5.2 Windows(`agents/homenet-agent.ps1`)

- 文件编码 **UTF-8 with BOM**,兼容 PowerShell 5.1 / 中文版 Server 2022(GBK)。
- CPU:`Get-Counter '\Processor(_Total)\% Processor Time'`(已验证的方法,不用 `Win32_Processor.LoadPercentage`)。
- 内存:`Get-CimInstance Win32_OperatingSystem`(TotalVisibleMemorySize / FreePhysicalMemory)。
- 磁盘:`Get-PSDrive C`。
- 网络:两个周期间 `Get-NetAdapterStatistics` 字节计数器差值。
- GPU:`nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`,逐行解析为 `gpus[]` 数组元素。
- Claude 倒计时:读取现有 `claude-window.json`,算出 `remaining_min` 填入 `extra.claude`(吸收现 `claude-report.ps1` 职责,后者最终可退役)。
- 推送:`Invoke-RestMethod -TimeoutSec 1 -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Push-Token' = $Token }`,失败 `try/catch` 静默。

## 6. 安装形态

### 6.1 Linux — systemd service(非 timer)

`/etc/systemd/system/homenet-agent.service`:

```ini
[Unit]
Description=HomeNet Hub push agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/homenet-agent.env
ExecStart=/opt/homenet-agent/homenet-agent.sh
Restart=always
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
```

`/etc/homenet-agent.env`(权限 600):

```
HUB_URL=http://192.168.1.24:3100
AGENT_ID=m26
PUSH_TOKEN=<长随机串>
```

> 若某机器只有普通用户权限(无 sudo),等价降级为 user service:`~/.config/systemd/user/` + `loginctl enable-linger <user>`(.25 待确认 linger 的事项与此同款)。

### 6.2 Windows — Task Scheduler 拉起常驻脚本

- 触发器:**系统启动时**(At startup),延迟 30 秒。
- 操作:`powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\homenet-agent\homenet-agent.ps1`。
- 设置:失败后每 1 分钟重启、不限重复次数;"不管用户是否登录都运行";不勾"如运行时间超过 X 则停止"。
- 配置(HubUrl / AgentId / Token)写在脚本顶部 param 块或同目录 `agent.env.ps1`,由安装脚本生成。

### 6.3 一键安装脚本(后续交付)

- `agents/install-linux.sh`:落盘脚本+env → `systemctl daemon-reload && enable --now` → `curl` Hub 端确认 id 上线。
- `agents/install-windows.ps1`:落盘脚本+配置 → `Register-ScheduledTask` → 立即启动并确认上线。

## 7. 服务端要求(http_push collector)

1. 路由 `POST /api/push/:id`,校验顺序:id 是否注册(404)→ token(401)→ 体积/JSON/必填字段(400)→ 存入内存快照 + SQLite 时序。
2. token 变量名由目标的 `source.token_env` 声明(不约定固定键名),其值从 `.env` 读取。校验时以该目标 `source.token_env` 指向的环境变量为准。
3. `targets.yaml` 中 push 型目标声明示例(真实 schema 形状:`type`/`token_env`/`stale_after_s` 均在 `source` 下):

```yaml
- id: m110
  source:
    type: http_push
    token_env: PUSH_TOKEN_M110
    stale_after_s: 10
```

> `stale_after_s` 缺省时回落全局 `PUSH_GRACE_MS`(默认 10s,可用环境变量覆盖);实际熄灭时刻 = 最后一次 push + stale 窗口 + sweep 周期误差(sweep 每 `PUSH_SWEEP_MS`=5s 扫一次,故误差 ≤5s)。

4. `gpus` 数组按 `idx` 映射到布局:`layout.yaml` 中卡片以 `metric: $.gpus[0].vram_used_gb` 这类 JSONPath 引用(需带 `$.` 前缀);单卡机器统一取 `$.gpus[0]`。
5. 未知顶层字段与未知 `extra` 命名空间:忽略并原样存入快照(前端可选用),不报错。

## 8. 验收清单(Step 8 集成测试)

- [ ] `curl` 手工 POST 合法载荷 → 200,面板 3 秒内出数
- [ ] 错 token → 401;未注册 id → 404;坏 JSON → 400
- [ ] 停掉 agent 10 秒 → 面板该机全字段转 `—` / offline
- [ ] 无 GPU 机器 `gpus: []` → GPU 区显示 `—`,不报错
- [ ] 双卡机器 `gpus` 两元素 → 布局按 idx 各取各的
- [ ] Linux agent 常驻 24h:RSS 无增长、无僵尸进程、断网恢复后自动续推
- [ ] Windows agent 重启机器后自动上线;中文系统下无乱码日志
- [ ] agent 机器上 `ss -ltn` / `netstat` 确认**未新增任何监听端口**
