# Changelog

All notable changes since the initial release (`bf92853`).

Deploy on the host with:

```bash
cd <repo> && git pull

# server/ or web/ changed  →  rebuild the image
docker compose up -d --build

# only config/ changed (a bare version bump counts)  →  no rebuild.
# The YAML hot-reloads on its own; this is only to move the footer version.
docker compose restart homenet-hub
```

**Which one:** `--build` is required whenever `server/` or `web/` changed — the frontend
is baked into the image. Commits that only touch `agents/` or `docs/` need `git pull`
alone. Each entry below is tagged accordingly.

**Why `restart` and not `up -d` for a config release.** Since v2.13.1 the version string
is read from a bind-mounted `package.json` rather than the copy baked into the image, so
a no-rebuild release *can* move the footer — but only if the process restarts, and only
if the container re-reads the file. Both of those need `restart`:

- `VERSION` is read **once at import**, so a running process keeps reporting the old
  number no matter what the file says.
- `docker compose up -d` recreates the container **only when the compose file, image or
  env changed**. After a config-only release it prints `Container homenet-hub Running`
  and does nothing.
- A single-file bind mount binds an **inode**. An in-place rewrite is seen immediately;
  `git pull` writes a new file and renames over the old one, so the container keeps
  serving the *previous* contents until it is restarted. (Measured, not assumed — in a
  throwaway container: in-place edit → visible at once; rename-replace → still the old
  bytes; `docker restart` → the new ones.)

So: `--build` after a code release, `restart` after a config release, and `git pull`
alone only when nothing needs to reach the running container.

**Releasing:** bump `version` in `package.json` and add the matching section heading
here, in the same commit. The panel reads that field at startup and shows it in the
page footer, so `package.json` is the authority — if the two ever disagree, the version
on screen is the one from `package.json`, and this file is what needs fixing.

> **发布约定:** 改 `package.json` 的 `version` 与新增本文件的章节标题,放在同一个提交里。
> 面板启动时读的是那个字段并显示在页脚,所以 `package.json` 是准的 —— 两者不一致时,
> 屏幕上显示的是 `package.json` 里的版本,该改的是本文件。

---

## v2.23.0 — 2026-10-21

**卡片之间零空洞(可拉宽卡片补满整行)、格子内部对齐与留白、m26 的请求数与 embedding 用量有了服务端计数。**

*Rebuild required — `server/` + `web/` changed. 新增 `agents/llama-log-exporter.py`;config.example 同步 `stretch`
与 `embed_requests` / `embed_tokens`。*

- **排版:显式排位,任何栏数都没有空洞**:layout 新增 `stretch: true`(可拉宽)。前端先按 span 逐行排卡;某行有剩余
  栏位时,把这一行里可拉宽的卡按 span 比例加宽补满;这一行没有可拉宽的卡,就把后面放得下的卡搬上来;都不行才
  加宽行尾那张卡。从不插入空白卡。推理节点卡仍独占一行。位置写成显式 `grid-row` / `grid-column`(CSS 的
  `grid-auto-flow: dense` 去掉,span 类只作无 JS 时的后备)。私有 layout 顺序回到「六台机器在前、Token / Per-Project
  在后」,Token Usage、Per-Project、网关卡设为可拉宽。
- **被拉宽的卡内部跟着展开**:Token Usage 宽时四个框排成 2×2 放左边、柱状图在右边填满(柱高改为按比例,
  卡片被行高拉高时柱子跟着变高,不再留一条空白);Per-Project 宽时把弹窗才有的列(7d / 30d / 首次 / 最近)也显示
  出来,各列按内容分配宽度;机器卡宽时环在左、格子在右。
- **格子统一**:全站格子同一套字号与内边距(标签 10.5px / 数值 15.5px / 9px 11px / 行高 20px)。机器卡格子改为
  「标签左、数值右」一行,放不下时数值换到下一行右对齐;By Model 等表格型数值独占一行。同一行的机器卡,第 n 排
  格子等高、标签基线对齐(按格子实际落位计算,不同列数的卡也对得上)。6 个格子的机器卡在卡宽 ≥520px 时排 3×2;
  手机宽度下 By Model 占整排、排到最后,剩余格子为奇数时最后一个也占整排,格子网格不留半空的行。
- **推理节点卡**:每栏六格按栏宽排 —— 三格一行(两行,按列分组:状态/延迟、Prefill/Decode、今日请求/tokens,
  状态那列最窄),栏宽 ≥ ~700px 时六格一行。原来栏底下的灰字收进格子第二行:Prefill / Decode 格写「测量于 HH:MM」
  或「最后 HH:MM · 上次读数」,今日请求 / tokens 格写「经 LiteLLM X · 嵌入 Y」。整张卡用 subgrid:三栏同一排格子
  顶边、底边对齐,没有第二行字的格子也同高。
- **表格对齐**:数字列右对齐(表头同)、文字列左对齐、全站 `tabular-nums`(表单控件也加上)。Token 明细弹窗的
  数字列补上右对齐;Per-Project 卡与弹窗按列的 `format` 判断(`text` 的日期列左对齐);客户端面板的列表改成带表头
  的表格(客户端 / Tokens / 净增 / 请求 / 今日)。
- **其它卡型同一套格子规则**:info / service / stack 子卡的格子数按 `data-n` 选列数(3、5 个时先单列,
  4 个在卡宽 ≥520px 时一行四格),stack 子卡自身就是尺寸容器;service 卡 model/role 的 12px 特例去掉(全站同一字号,
  长模型名在格子里折行);格子数值允许在格子内折行,长文本不再撑出卡片。config.example(演示)把 About 设为可拉宽并
  排到 Token 之前,4 栏屏上不再出现一张 2400px 宽、只有四行字的 About。
- **手机宽度的弹窗与页头**:弹窗表格单元格不再折行;≤560px 时次要列让位(Token 明细的 Share、客户端的净增 / 今日),
  客户端名过长省略(悬停看全名);仍放不下的 8 列 Per-Project 明细在自己的框里横向滑动、首列固定,不再撑出弹窗。
  页头按钮与语言开关不再被挤成一字一行 / 被裁成「中 E」,窄屏时整行换行。
- **m26 请求数(BACKLOG 18)**:新增 `agents/llama-log-exporter.py`,在 m26 上以只读方式数 llama-server 每个任务结束
  时写进 journal 的 `slot release … n_tokens = K` 行,出 `homenet_llama_requests_total{unit}` 与 embedding 的
  `homenet_llama_tokens_total`(不碰推理服务)。`inference_nodes` 的 `counters` 新增 `embed_requests` /
  `embed_tokens`;每条序列的午夜基线:午夜前 1 小时内有样本 → 用它;过去 7 天出现过但午夜前后不在
  (机器夜里关着,如 m110)→ 从 0 算;7 天内从没出现过的新序列(新加的 exporter)→ 取当天第一个样本。节点历史弹窗多一条「Embedding(服务端计数)」。
  核对:exporter 与日志手数全量一致(27b 83/83,embedding 110/110 请求、1132/1132 tokens);窗口
  00:28:57–01:00:42 日志 = Prometheus 增量 = 卡上数字(27b 10;embedding 5 请求 / 70 tokens)。
- **自动检查**:390 / 1280 / 1440 / 1920 / 2560 × 中英文,用真实 payload 跑溢出、越界、卡片与卡内元素重叠、页面横滚、
  网格空洞、对齐(同行卡片底边、推理节点三栏格子顶/底边、所有表格数字列右边缘)、留白(格子最宽一行文字 < 25%),
  页头与三个弹窗(Token 明细、Per-Project 明细、客户端)也在检查范围内,全部为 0 才部署。

## v2.22.0 — 2026-10-20

**推理节点的用量改从推理服务自己的计数器统计(直连的请求也算);宽屏版面重做:按屏宽分 1–4 栏、
卡片可占栏、卡片内部按自身宽度调整。**

*Rebuild required — `server/` + `web/` changed. `config/queries/node_usage.sql` 改写(config.example 同步)。*

- **推理节点卡的今日用量 = 机器的真实总量**:`inference_nodes` 新增 `counters`(Prometheus 计数器选择器)与
  source 的 `prometheus`。按北京时间自然日逐样本累加原始样本(不是 `increase()` 的外推):计数器回落 =
  服务重启、新值从 0 计起,所以重启既不漏算也不变负;零点前一小时内的最后一个样本作基准,零点后才出现的
  序列从 0 计。tokens = 实际计算的 prompt + 命中缓存的 prompt + 生成,与 LiteLLM 的 prompt+completion
  同口径。没有请求计数器的服务(llama.cpp)不显示 0,而是写明「服务端没有请求计数器」。
- **「其中经 litellm」灰色小字**:改从 `LiteLLM_SpendLogs` 按北京日、按 `api_base` 的 host:port 精确归属节点
  (`endpoints` / 新的 `embed_endpoints`),不再用模型名正则;chat 与 embedding 分开。
- **节点历史**:总量与经 litellm 的量都进时序库,节点弹窗的请求 / tokens 面板画「总计 vs 经 LiteLLM」两条线。
- **实例标注**:栏标题写「litellm 4001」;实例新增 `serves`(目标架构),不在其中的实时路由灰色删除线并标
  「待移除 / to be removed」,目标里有但还没接上的标「未接入」。`public` 改为域名简称,显示「对外 lm2 /
  Public · lm2」。
- **宽屏版面**:
  - 网格按屏宽固定 1 / 2 / 3 / 4 栏(<700 / 700–1200 / 1200–1800 / ≥1800px),整页居中、最宽 2400px;
    `grid-auto-flow: dense`,同一行等高。原来 `auto-fit` 在 2000px 屏上排出 6 栏、每卡约 310px。
  - layout 新配置项 `span: 1 | 2 | full`(默认 1,与原行为一致);`span: 2` 在只有一栏时占满整行。
  - 卡片 `container-type: inline-size`,内部按卡片自身宽度调整:Token Usage 的框用 `--tk-n` 列、窄卡
    两列换行(原来 4 个框挤在 3 列里,Total 溢出卡片);Per-Project 表改为自动布局 —— 数字列永不截断,
    只有项目名过长时省略并带 title;推理节点卡按卡宽(≤900px)上下排列。
  - metrics 新选项 `parts_layout: table`:网关卡 By Model 的五项排成两栏小表(标签左、数字右对齐),
    窄卡时这一格占满整行。
  - 圆环流光不再用 `transform: rotate` 转整个伪元素(旋转方块的外接框会超出圆环,形成真实的横向溢出),
    改用 `@property --comet` 转渐变起始角,画面不变。
- 验证:无头浏览器在 390 / 1280 / 1440 / 1920 / 2560 宽 × 中英文下自动检查「scrollWidth > clientWidth、
  元素超出卡片、卡片互相重叠、整页横向滚动、同行不等高」,生产面板(用真实 agent 数据)与 config.example
  演示面板全部为 0。
- 运维(不在仓库里,部署前 `.backup` 为 `data/homenet.db.pre-v2.22.0`):删除 `nodes` 目标在 v2.22 之前写入的
  1,212 个样本(22:08–23:48)。`<node>_reqs / _tokens` 的含义变了(原为经 litellm、UTC 日,现为服务端总量、
  北京日),而且 23:13 改写查询文件后旧代码热读新查询、写进了一段假的 0 —— 留着会让节点弹窗的「总计」线前后
  口径不一。其他目标的样本未动(同时段 69,607 个,删除前后一致)。
- 实配(私有):Token Usage 卡改名「Token Usage · 经 LiteLLM / via LiteLLM」并在说明里写明;推理节点卡
  m110 接上(Strata 8082、Speed·110);token / Per-Project `span: 2`,推理节点 `span: full`;By Model
  `parts_layout: table`。

---

## v2.21.0 — 2026-10-20

**多卡卡面只显示合计;网关卡按模型拆成五槽、三个 litellm 实例的请求量都算进来。**

*Rebuild required — `web/` changed;`agents/homenet-agent.sh` 需在各 Linux 机器重新部署
(行为变化只在网关机 m24;m24 的 `/etc/homenet-agent.env` 要加新容器名,见下)。*

- **卡面去掉每卡小字**:多卡机器的 GPU / 显存环下方(「0:80% 1:82%」)与显存 / 温度 / 功耗格里的
  每卡明细行都不再显示,卡面只留合计值。告警不变:hub 给合计值的 level 仍取各卡最差的一张
  (显存 / 温度 / 功耗),环和格子按它着色 —— 任一张卡超阈值就变红。每卡曲线仍在机器弹窗里。
- **agent:`reqs_by_model` 五槽** `27b` / `flashnext` / `m110` / `emb` / `other`(原四槽)。m110 槽的
  SQL LIKE 模式与上标来自环境变量 `LITELLM_M110_LIKE` / `LITELLM_M110_LABEL`(只接受
  `[A-Za-z0-9._%-]`,模式为空时该槽恒为 0),m110 换模型只改 env。卡片的 format 要同步改成
  `{m1} {m2} {m3} {m4} {m5}`,target map 加 `m5` / `m5_label`。
- **`reqs_5m` 三容器累加**:一机一个 litellm 实例后,m24 的 `LITELLM_CONTAINERS` 改为
  `"litellm litellm-agent litellm-m26"`(加了引号,bash 直接 source 也不报错)。
- `docs/AGENT_PROTOCOL.md`:五槽与 m110 env、三容器。
- 实配(私有):m24 卡 `reqs_by_model` 加 m5;推理节点卡的 `instances` 加 4002(litellm-m26)。

---

## v2.20.0 — 2026-10-20

**推理节点卡:每台推理机器一栏,状态 / 速度 / 今日用量 / 实际路由的 litellm 实例合在一张全宽卡上。**

*Rebuild required — `server/` + `web/` changed. 新增 `config/queries/node_usage.sql`(config.example 同步)。*

- **新卡片 `type: nodes`(全宽,按实例端口顺序分栏,窄屏改为上下排列)**。每栏:机器名 · 实例端口
  (公开入口带「对外 / Public」标记)、节点端点实时读到的模型 ID、状态 / 延迟、Prefill / Decode、
  今日请求 / 今日 tokens(embedding 另以小字显示)。点一栏打开该节点的历史弹窗(沿用速度弹窗与
  `drawMulti`):速度两栏 + 今日请求 / tokens 的当日累计,chat 与 embedding 分线。
- **状态统一为三种**:在线(绿)/ 无服务(灰)/ 故障(红),不再出现 ok / online 混用。新的 target
  选项 `always_on`:`false` 的机器连不上时整栏变灰、写「未开机 / 无服务」,模型名以灰色显示最后一次
  看到的名称(存在 tsdb 的 meta 表,hub 重启后仍在);其余机器连不上即为故障。栏位固定,不因离线跳动。
- **新采集类型 `inference_nodes`**:
  - 今日用量:与 Token Usage 卡的 Today 完全同一口径(`LiteLLM_DailyUserSpend` 最新一天、所有 key、
    prompt + completion),按各节点的模型正则(`chat` / `embed`)认领,剩下的记 `unassigned`,
    因此「各栏 + unassigned = Token Usage 今日总量」。写入时序,供节点弹窗画图。
  - 实例路由:每分钟向各 litellm 实例 `GET /model/info`(master key),按部署的 api_base host:port
    对上节点。卡上的端口是查到的实际路由,不是配置里写的 —— 模型搬家后不用改卡片配置。
- 速度过期时保留最后一次的数值作为 `last`(value 仍为 null:不当现值显示、不写历史),卡上以灰色小字
  显示「最后 HH:MM · prefill / decode」。
- 中英文:新卡所有文字都有 EN 版本;配置里的标题 / 说明支持 `_en`。
- 实配(私有,不在本仓库):用推理节点卡取代原 `Inference · 25/26`、`Speed · 25/26` 两张 stack 卡;
  m25 / m26 设 `always_on: true`(移除 inference25 旧的 `when_down`),新增 m110 探测目标
  (`always_on: false`;它的推理端口目前从 hub 连不上,卡上显示「未开机 / 无服务」与「未接入 litellm」)。

---

## v2.19.1 — 2026-10-20

**35b 下线后的面板收尾:网关卡按真实模型拆请求量;速度历史只画真实测量段。**

*Rebuild required — `web/` changed;`agents/homenet-agent.sh` 需在各 Linux 机器重新部署
(只有网关机 m24 的行为有变,其余机器部署是为了 sha 与 HEAD 一致)。*

- **agent**:网关卡 `reqs_by_model` 第二槽从 `35b` 改为 `flashnext`(`%flashnext%`,标签同名)。
  35b 已于 2026-10-20 下线,litellm 里不再有这个模型名;今天早些时候打到旧 35b 部署的请求
  现在归入 `other`。注释里「4000 挂 27b、4001 挂 35b」等过时描述一并更正。
- **图表(`drawMulti`)**:新选项 `maxGapSec`,给可桥接的空档设上限。原来按点间距 p90 × 4 判断
  断档,前提是序列平时连续;推理速度只在有请求时才有,m25 的速度 141 小时里只有 38 小时有测量,
  p90 本身就落在空闲长空档上,于是相隔几天的测量点被连成一条看似持续的平线。速度弹窗现在按
  读取桶宽取上限(3 个桶或 15 分钟取大:1d ≈ 17 分钟、7d ≈ 2 小时),前后都断开的孤立测量点
  画成小圆点。机器卡弹窗与 Dual Compare 不传这个选项,行为不变。
- `docs/AGENT_PROTOCOL.md`:`reqs_by_model` 的槽位与匹配规则。
- 实配(私有,不在本仓库;热重载生效):m27 没有独显,卡片由「GPU · 机器 27 / GPU Node」改为
  「主机 · 机器 27 / Hermes」,环与格子换成 CPU / 内存 / 磁盘 / 负载(原来 GPU 相关读数恒为 "—");
  状态栏 Telegram 灯原是 `type: demo` 的合成数据,改读 OpenClaw dashboard 接口里对
  api.telegram.org 的真实探测。
- 运维(不在仓库里,删除前 `.backup` 为 `data/homenet.db.pre-speedclean`):按 Prometheus 的
  推理活动记录删除 speed25 / speed26 历史里旧查询「保留 24 小时」写入的旧值 —— 原始层 23,222 个
  样本、5 分钟层 8,088 个桶;其余 31 个序列在核对窗口内的行数不变。剩下的样本逐个核对过,
  全部落在有真实推理活动的分钟里。

---

## v2.19.0 — 2026-10-20

**硬件/模型调整后面板跟上:旧速度不再冒充现值,预期内的无服务显示为中性,功耗毛刺挡在入库前,
图表右端标签不再叠字。**

*Rebuild required — `server/` + `web/` changed;`agents/homenet-agent.sh` 需在各 Linux 机器重新部署。*

- **测量时效(hub + 前端)**
  - 新的 target 选项 `freshness: { max_age, lookback, at: { <metric>: <JSONPath> } }`:查询同时
    返回每个值的测量时间,hub 据此判定 —— 2 分钟内 = 正在测量(写历史);`max_age` 内 = 刚测过
    (照常显示,不重复写历史);超过 `max_age` 或没有测量时间 = 卡面显示 "—"、不写历史。
  - 卡片在数值下方标「测量于 14:24」/「最后测量 10-19 20:26」/「近 7 天无测量」。
  - 起因:Speed 卡原来用 `last_over_time(...[24h])` 把最后一次非空闲速度保留 24 小时。m25 的
    35b(旧硬件,`192.168.1.25:12346`)在 10-19 20:26 之后就没有推理了,卡面却一直显示
    209.8 / 26.2,并且每 30 秒当新样本写进历史(speed25 有 1434 个 209.8)。
- **预期内的无服务(hub + 前端)**:target 选项 `when_down: { note, note_en }`。目标连不上时显示灰色
  中性文字(不挂 Offline、不挂徽章),而不是故障样式。用于只在测试时开的推理服务。
- **功耗合理性(hub)**:单卡 `power_w` 超过自身 `power_cap_w` 的 1.5 倍即丢弃该卡这一样本的功耗,
  不写库(日志里每卡 10 分钟记一次)。没有上报 `power_cap_w` 的卡(nvidia-smi)不检查。
- **多卡合计不再漏算(hub)**:检测到的卡里只要有一张缺某一项,`gpu` / `vram_bytes` / `gpu_temp` /
  `gpu_power` 的合计就是 null(不写库),而不是拿剩下几张去平均/相加 —— 那等于把缺的卡当 0。
- **agent(`agents/homenet-agent.sh`)**
  - AMD 功耗改为一个推送周期内多次读取 `power1_average` 取平均(与使用率同一个采样循环),不再
    只取推送那一刻的单次读数。
  - NVIDIA 分支:nvidia-smi 读不到时给 `[N/A]`,原来 awk 的 `%d` 会把它写成 0;现在读不到的字段
    直接省略。(目前没有 Linux 机器走这个分支,属预防。)
- **图表标签避让(`drawMulti`,Dual Compare 与机器弹窗共用)**:标签间距原为固定 13px,对 11px 粗体
  正好贴边,CJK 回退字体(Windows 雅黑行高约 14.5px)下直接重叠 —— m26 空闲时 Temp / Power / GPU
  三条线都贴着底部,三个标签叠成一团。现在按实际字体的行高 + 3px 计算;标签多到绘图区放不下
  (多卡温度面板 6 条)时先用满整个画布高度,再按比例压缩。
- `docs/AGENT_PROTOCOL.md`:`power_w` 的周期平均语义、hub 的 1.5 倍检查、多卡合计的缺值规则。
- 实配(私有,不在本仓库):
  - `Inference · 25`:去掉过期的角色徽章「Overflow」,加 `when_down`(「目前无对外推理服务」);
    `Inference · 26` 的角色徽章一并去掉(角色随模型调整,写死就会过期)。
  - `Speed · 25` / `Speed · 26`:查询改为返回 7 天内最后一次非空闲值 + 测量时间,`max_age: 10m`。
- 运维(不在仓库里,删除前 `.backup` 为 `data/homenet.db.pre-v2.19.0`,镜像回退点
  `homenet-hub-homenet-hub:pre-v2.19.0`):
  - 删除 m25 单卡功耗超过 1.5 倍上限的 5 个样本(444–501W;上限 291 / 303W)及同一时刻的 5 个
    合计值(548–846W)。m26 在 10-17 至 10-19 有 1186 个超过现上限 1.5 倍的样本,全部来自换卡前的
    旧显卡,保留。
  - 核查:m25 / m110 13:40 之后显存在 0/12% 与 95% 之间来回跳是**真实数据** —— 测试中反复重启
    推理服务(m25 `strata-flashnext.service` 14:03:04 重启 ↔ 库里 14:03:07 归零,随后约 1 分钟
    逐步爬升到 94%);每个时间点各项指标齐全,没有缺值补 0。

---

## v2.18.2 — 2026-10-20

**NAS agent:自报版本、`--once` 试跑,只报真正挂载的卷。**

*No rebuild — only `agents/` changed (plus the version string: `docker compose restart homenet-hub`).*

- `agents/nas75-agent.sh`:
  - `extra.agent = { file, sha256 }`,机器弹窗可显示与 HEAD 是否一致(与 Linux agent 同一套)。
  - `--once`:采集一次、打印 payload、不推送、不碰 pidfile,可与在跑的 agent 并存。
  - 只统计**已挂载**的 `/volume*`。卷丢失时目录还在,`df` 会退到 8G 系统分区,卡上显示成
    健康的「Vol 1 2/8G」(2026-10-20 volume1 的 M.2 NVMe 断电后消失时就是这样)。
  - 头部部署说明改成现行方式:`/usr/local/homenet/` + DSM 任务计划(开机任务 + 每分钟保活)
    + `flock -n` 防重复。
- 实配(私有):`vol1_bytes` / `vol2_bytes` 改为按卷名取值,卷丢失时显示 "—" 而不是下标前移。

---

## v2.18.1 — 2026-10-20

**时钟往回跳之后,时序数据不再静默断档。**

*Rebuild required — `server/` changed.*

- `Tsdb.record()` 的 5 秒降采样用「本次时间 − 上次写入时间」判断。系统时钟往回拨
  (2026-10-20:24 开机时被 VMware Tools 按 ESXi 主机时间拨快约 8 小时,NTP 再拨回)后
  这个差是负数,于是每条序列都被丢弃,直到真实时间追上那个错误的「上次写入」——
  一次跳变就是一个 8 小时的空洞。上次写入时间在未来视为时钟故障,不再压制写入。
- 运维(不在仓库里):已删除跳变期间写入、时间戳在未来的 800 个原始样本
  (10-20 06:59:43 – 08:27:10,删除前 `.backup` 为 `data/homenet.db.pre-clockfix`);
  聚合层没有未来的桶,无需重建。

---

## v2.18.0 — 2026-10-20

**多 GPU:双卡机器的每张卡都上卡面、进历史;agent 自报版本,弹窗直接显示是否与 HEAD 一致。**

*Rebuild required — `server/` + `web/` changed;`docker-compose.yml` 新增 `./agents` 只读挂载;
agent 需在各机重新部署。*

- **agent(`agents/homenet-agent.sh`)**
  - AMD 多卡:只认 `vendor=0x1002` 的卡,张数不写死,按 PCI 地址排序编号(重启后
    `cardN` 换序,`idx` 不变)。每卡新增 `pci`、`temp_junction_c`、`temp_mem_c`、
    `power_cap_w`;`temp_c` 仍是 edge;`power1_average` / `power1_input` 二选一;读不到的省略。
  - 使用率改为一个推送周期内多次读取 `gpu_busy_percent` 取平均(`GPU_SAMPLES`,默认 4)。
  - `extra.agent = { file, sha256 }`:脚本自身的 sha256。
  - `--once`:采集一次、打印 payload、不推送,部署前核对输出用。
  - 单卡 / 无卡机器的 payload 与原来相容(只多了上述可选字段)。
- **hub**
  - payload 里 ≥2 张卡或 target 声明 `gpu_count ≥ 2` 时:`gpu` = 平均使用率、`vram_bytes`
    = 已用合计/总量合计、`gpu_temp` = 最高 edge 温度、`gpu_power` = 相加(上限 = 各卡
    `power_cap_w` 相加);另出 `gpuN`、`gpuN_vram_bytes`、`gpuN_temp`、`gpuN_temp_junction`、
    `gpuN_temp_mem`、`gpuN_power`。颜色**按单卡判**(取各卡最差),阈值不变 —— 合计比例永远
    不高于最满的那张卡,按合计判断等于放宽。
  - `gpu_cards`:检测到的卡数;少于 `gpu_count` 时卡面显示「只检测到 N/2 张卡」。
  - `GET /api/agent_heads`:仓库里各 agent 脚本的 sha256(`./agents` 只读挂载进容器,改脚本
    不用重建)。
- **前端**
  - 多卡时环下、格子下逐卡小字(每张卡按自己的状态着色),单卡机器显示完全不变。
  - 机器明细弹窗:多卡机器分四张图(使用率 / 显存 / 温度 edge·junction·mem / 功耗),每卡一
    条线,仍用同一个 `drawMulti`,Dual Compare 不受影响。弹窗顶部显示 agent 与 HEAD 是否一致。

实配:m25 标签「2× RX 7900 XTX」并加 `gpu_count: 2`;m26 标签「RX 6900 XT」。

---

## v2.17.0 — 2026-09-25

**Stack 卡可以点进子卡看历史;弹窗时段可按卡配置;速度卡拆成两张图。**

*Rebuild required — `server/` + `web/` changed.*

- `stack` 卡支持 `clickable: detail`:点哪个子卡就打开哪个 target 的历史弹窗(复用机器卡的
  弹窗与 `/api/history`)。点在子卡之间的分隔线上不响应。
- 卡片可选 `detail_ranges`(取值为 `RANGE_SEC` 的键),替换弹窗默认的 24h / 7d / 30d。
  `RANGE_SEC` 新增 `1d`、`3d`。
- 新角色 `speed`(target 有 `prefill_speed` / `decode_speed`):两条线各画一张图、各自自动
  缩放 —— prefill 约是 decode 的 10 倍,放在同一根轴上 decode 会被压成一条贴底的直线。
  其他卡的弹窗不变。
- 图表左侧 0..100 刻度只在确实有序列画在左轴时才显示(与右轴已有的规则对称)。

实配:速度 stack 加 `clickable: detail` 与 `detail_ranges: [1d, 3d, 7d]`。

---

## v2.16.2 — 2026-09-25

**Token 卡的累计值(All / 请求数 / Net)不再落后于「今日」。**

*Rebuild required — `server/` changed.（同时要改实配的 `config/`,见下。）*

累计值来自 `total_query_file`,为避开全表扫描缓存 10 分钟;今日值来自每 5 分钟一次的窗口查询。
两者不同步,同一张卡上 All 最多落后 Today 约 15 分钟 —— 实测对账时 All 比数据库少 7 个请求、
36 万 token,而 Today 分毫不差。

新增可选 `total_excludes_window: true`:累计查询带 `$1`(= 窗口天数),**只统计窗口开始之前**
的日子,窗口部分每轮用刚取到的数据补上。窗口之前的日子不会再变,缓存也就不会过期;UTC 日期
翻页(LiteLLM 按 UTC 分日)时缓存重新取,因为那一刻正好有一天滑出窗口。不开这个选项时行为不变,
`config.example` 里按 SpendLogs 写的示例查询也不受影响。

**顺带修复:只改 `queries/*.sql` 不生效。** SQL 文件不参与 etag,单独改一个查询文件时热加载判定
为「未变化」直接返回,旧 SQL 一直留在缓存里(实测:`token_speed.sql` 改完后面板仍在跑旧的
`SELECT NULL`)。现在任何配置文件变化都会先清掉 SQL 缓存。

实配需同时:`targets.yaml` 的 token 源加 `total_excludes_window: true`,`queries/token_total.sql`
加 `WHERE date::date < (CURRENT_DATE - ($1::int - 1))`。

---

## v2.16.1 — 2026-09-25

**`REQUIRE_LOGIN_TO_VIEW=lan`:局域网直连端口免登录,经反向代理(域名)访问必须登录。**

*Rebuild required — `server/` changed.*

之前只有两档:全公开(默认),或者连局域网也要登录。经反向代理暴露到公网的面板,两档都不
合适 —— 前者让任何人不登录就能读 `/api/config`、`/api/snapshot`(拓扑、服务名、token 用量),
后者把家里常亮的看板也锁住。新增第三档 `lan`:socket 对端是私网、且**不带任何转发头**
(`X-Forwarded-For` / `X-Forwarded-Host` / `X-Real-IP` / `Forwarded`)的请求放行,其余要会话。

**为什么不按地址判断**(没用首次设置那个 `clientIsPrivate()`):实测 Lucky 把
`X-Forwarded-For` 改写成它自己的内网地址,每个经代理的请求到这里都是
`192.168.1.5, 192.168.1.5` —— 按地址看,公网访客和局域网访客一模一样。代理改不了的是
**它一定会加上这些头**,所以"有转发头 = 走了代理",公网请求没有不带头进来的路。代价:在家
用域名访问也要登录;免登录请用 `http://192.168.1.24:3100` 直连。

`/healthz` 的 `require_login_to_view` 在 `lan` 下报 `true`:经域名访问确实要登录。
`1`/`true`/`on` 与未设置时的行为不变。

---

## v2.16 — 2026-09-10

**中 / EN 语言切换:界面全套双语,配置标签按需加 `_en`。**

*Rebuild required — `web/` + `server/config/` changed.（同时改了 `config/`,但那一半是热加载的。）*

header 里多了一个两段小开关。它是**浏览器本地偏好**:存 `localStorage`,不发给服务端、不进
config etag、不影响别的访客看到的界面 —— 所以两台机器上的选择互不干扰,也不需要登录。点一下
立刻重渲染,刷新后还在。

**硬指标是 zh 不动。** 页面里内联的中文就是 zh 基线,i18n 的 zh 那一遍写回去的是同样的字,
只有 EN 那一遍才真正改 DOM。验证方式是渲染文本对比,不是眼看:同一份 `/api/config` +
`/api/snapshot`(取自线上)喂给改前/改后两棵树,headless 里把所有面板与弹窗打开,取
`document.body.innerText` 逐行 diff —— **唯一的差别是新增的那两个「中 / EN」段**。另外三条
也跑了:点开关切到 EN,结果与直接以 EN 启动**逐字一致**;zh → EN → zh 转一圈回到 zh,
与直接以 zh 启动**逐字一致**;EN 模式下整页只剩一个汉字,就是开关上的「中」。

**前端所有硬编码中文串收进一个字典**(`web/i18n.js`,`{zh, en}` 两套)。之前它们散在
八个 renderer 的模板串里 —— 登录/改密/凭据/客户端/添加目标/演示条的每一句提示、每一个
confirm、每一条错误。字典是 **zh 优先**写的:翻译方向决定了哪一边允许漂,而那一边不是中文。
EN 缺项回落到 zh 而不是回落到 key,半套翻译显示的是原句,不是 `cli_revoke_failed`。

index.html 里的静态文案不动,只挂 `data-i18n` 属性,由字典在首屏前写回 —— zh 下这一遍是
空操作,EN 读者也不会先闪一下中文。

**配置标签支持 `_en` 变体。** schema 显式声明(不是靠 `additionalProperties` 放行),所以
`title_en: 42` 会被和其它畸形值同一道门挡下:

| 位置 | 字段 |
|---|---|
| layout | `title_en` `hint_en` `detail_title_en` `empty_note_en` `more_label_en` `text_en` `labels_en` `columns_en` `detail_columns_en`,以及 `columns` 对象形式里的 `label_en` |
| targets | `name_en` `badge_en` |
| metrics | `label_en` |
| theme | `subtitle_en` |
| info 卡 | 每行的 `label_en` / `value_en` |

**只有散文有变体。** 指标 key、target id、颜色、单位、format 都是**引用**,不给变体 ——
一个引用有两种拼法,配置就会悄悄对不上自己。没写 `_en` 的字段两种语言都渲染原值,所以翻一半
的配置退化成中英混排,而不是空白。

`publicConfig` 是白名单不是黑名单,`name_en` / `badge_en` / `text_en` 因此要逐个放行(实测:
不放行就是英文模式下静默回落)。演示板被清空时 `text_en` 跟着 `text` 一起留下 —— 它是页面
chrome,不是演示内容。

**顺手修掉一个既有 bug。** `mountCards` 是 shell-persist 的,卡片的 `<h2>` 标题只在首次挂载
时写一次 —— 在 YAML 里改 target 的 `name`,卡上的名字要硬刷新才更新(和当初 `.ring-label`
那个问题同源)。语言开关把它照出来了:切到 EN 后满屏都跟着变,只有卡片标题还是中文。现在
标题和 tag 一样每次渲染同步。

**切换不重置正在看的东西。** 语言变化走的是各模块的 `relocalize*`,不是重跑 `initHistory` ——
后者会把历史区间和三个 pane 的选择打回配置默认值,等于切个语言就把你正在看的窗口扔了。
同理,面板上那句**结果**(「密码错误。」)不会被改写成另一种语言:它是当时报出来的事实。

**实配翻译**(同步到私有仓 `homenet-config`):六台机器的 `name_en`(`GPU · 机器 26` →
`GPU · Machine 26` 等)、token 卡与 Per-Project 卡的「净增 / 实际新增 / 首次 / 最近」,以及
Per-Project 那句中英混排的 `hint`。`config.example` 本来就是全英文,所以那边加的 `_en` 是
**示范用的镜像值** + 一段约定说明,让示例文件本身就是这个特性的参考。

## v2.15 — 2026-09-05

**table 卡:放不下的行不再消失,点开看全部。**

*Rebuild required — `web/` + `server/config/schema.js` changed.*

`type: table` 的卡此前把查询返回的每一行都画出来,行数一多就把自己撑得比邻居高;而卡宽只
放得下四列,`7d`/`30d`/首末日期这些查询本来就返回的列根本没地方显示。

- **卡面只留前 N 行**(`front_max`,默认 6 —— 默认卡高放得下的行数)。超过 N 时卡片变成
  可点,底部出一行 `查看全部（共 N）`。**没超过就不可点、不出提示**,和其它没有细节可看
  的卡一致。
- **点开弹窗给全部行 + 全部列**,复用 token / 机器卡那个 `.modal` 壳(它本来就是
  `max-height:90vh; overflow:auto`,滚动是白拿的)。新增 `detail_columns` 配置声明弹窗的
  列;Per-Project 卡由此补齐了 `7d` / `30d` / `首次` / `最近`。
- **纯 view,不需要登录、不发请求。** 弹窗用的就是卡片渲染时那份快照的行,挂在卡对象上
  传过去 —— 所以它和卡面永远不会不一致,也不可能显示公开面板没有的东西。

**列的两级信任。** `columns` / `detail_columns` 里声明的列是有人在 layout.yaml 里做的决定,
原样渲染。没声明 `detail_columns` 时弹窗会从行里**推导**列 —— 那是没人做过的决定,所以推
导出来的列要再过两关:按**列名**(`key`/`api_key`/`token`/`password_hash` 等整词结尾)和按
**值的形状**(`sk-` 前缀、32 位以上连续十六进制)。值检查只作用于推导列,不动声明列 ——
把操作者亲手选的列悄悄抹掉,等于和他正看着的卡片唱反调。

开发中这条规则的第一版把 `token` 当子串匹配,会连 `tokens_total`、`tokens_7d` 一起藏掉 ——
正好是这张卡最重要的列。改成整词结尾后测过:`tokens_total` / `net_total` 放行,
`raw_key` / `api_key` / `key_digest` 拦截。

---

## v2.14 — 2026-09-05

**客户端管理:每个客户端一把 key,卡上按名字看用量。**

*Rebuild required — `server/` + `web/` changed. 另需在 `.env` 里加 `LITELLM_MASTER_KEY`。*

Per-Project Tokens 卡此前只能显 `key:57f0a7fc` 这种短哈希,因为 LiteLLM 的记账表
`LiteLLM_DailyUserSpend.api_key` 存的就是 key 的 sha256 摘要 —— 名字在另一张只读角色看
不到的表里,而 master key 干脆没有行。这一版从 proxy 自己的管理 API 取名字,于是有了一
整套客户端管理。

**新增「客户端」管理页**(登录后可见,与凭据面板同一套壳):

- **新建** —— 输名字 → 调 `/key/generate`。LiteLLM 支持自定义 key 值,所以生成的是
  `sk-homenet-<名字>-<随机后缀>` 这种一眼能认出归属的串,而不是随机 16 位。
  **明文只在创建时返回一次**,之后 litellm 只留摘要,谁都拿不回来 —— 面板用一个红框说
  明这件事,并且不写日志、不进任何存储。
- **列表** —— 名字 + 总量/净增/请求数/今日请求 + 删除。master key 标成「网关自己的 key」
  且不可删(它是 litellm 的配置字面量,不是这里铸的);已删除但仍有历史用量的 key 标
  「已撤销」,用量继续显示 —— 撤销不该让账消失。
- **撤销** —— 调 `/key/delete`。

**Per-Project Tokens 卡改成按名字显示。** 新增 target 配置 `resolve_names: litellm_keys`:
查询多返回一列 `raw_key`(摘要),采集器查 `/key/list` 换成别名写回 `project` 列,
**然后把摘要删掉再交给前端**。查不到名字的行保留短哈希标签。

**一个安全边界值得单独说。** `api_key` 那一列在对外网关上是个垃圾场:每个被拒的请求都按
调用方送来的字符串记账。这台机器上它已经存着扫描器噪声、别人粘错的 shell 片段,以及
**其他服务的真实凭据**(实测有一个 Telegram bot token 和一个 Tavily key)。所以
`/api/clients` 的行集来自 LiteLLM key 接口返回的摘要 + master key 的哨兵值,**任何认不出
的 api_key 值一律不回显**,只折成一个匿名计数(当前 53 个、1834 次请求)。

**环境变量 `LITELLM_MASTER_KEY`**(compose 已透传)。没配也能跑:管理页显示「未配置」、
卡回落成短哈希、其它一切不变 —— 与金库锁定时的行为一致。`LITELLM_BASE_URL` 默认
`http://litellm:4000`,即 compose 上那个外部网络的服务名;**不是 127.0.0.1** —— hub 在自己
的容器里,localhost 是它自己(实测过)。

全部接口 behind `ADMIN`(会话)/ `ADMIN_WRITE`(会话 + 同源):未登录 401,跨源写 403。

---

## v2.13.1 — 2026-09-05

**页脚版本号不再落后:`package.json` 改成从宿主挂载读,配置类发布不用为了一个字符串 rebuild。**

*No rebuild — `docker compose up -d` 重建容器即可(挂上新 volume,几秒)。*

`server/version.js` 在启动时读 `/app/package.json` 的 `version`,而 Dockerfile 是
`COPY package.json ./` —— 版本号被烤进镜像。于是任何**不需要 rebuild** 的发布(只改
`config/` 或 `agents/`)都会留下页脚显示旧版本:v2.11 和 v2.13 各发生过一次,tag 是新的、
屏幕是旧的,而本文件开头就写着「`package.json` 是权威,屏幕上显示的是它」。

修法是一行 compose 挂载:

```yaml
- ./package.json:/app/package.json:ro
```

**不影响任何依赖。** 依赖是构建时 `npm install` 解析并烤进镜像 `node_modules` 的,运行时
不会再读 `dependencies`;`version.js` 也只取 `.version` 一个字段,其余一概不碰。

**两件仍由这个文件在运行时决定的事**,改它的时候要留意:`"type": "module"`(Node 靠最近的
package.json 判断模块类型)和 `imports`/`exports`。宿主上的 package.json 若丢了
`"type": "module"`,容器会起不来 —— 这是新引入的耦合,烤在镜像里的那份没法从外面弄坏。
`version.js` 本身已经是防御性的:文件读不到、或 version 不是普通 semver 字符串,就不报版本
而不是崩掉。

**注意生效时机。** 单文件 bind mount 绑的是 inode:就地改写(编辑器、版本号 bump)容器立刻
看得到;replace-and-rename(`git checkout`)要等容器重建。而 `VERSION` 是 import 时读一次,
所以页脚只在**进程重启后**才动 —— 以后只改 `config/` 的发布,配置本身照旧热重载,想让页脚
一起追上就再跑一次 `docker compose restart homenet-hub`。

---

## v2.13 — 2026-09-05

**Per-Project Tokens 卡也加上"净增":每个 key 的账面量里有多少是真算过的。**

*No rebuild — `config/` + `queries/` only. 热重载即可。*

延续 v2.12 的口径,这次落到按 key 的表上。`queries/project_tokens.sql` 每行多算一个
`net_total = GREATEST(SUM(prompt_tokens) − SUM(cache_read_input_tokens), 0)
+ SUM(completion_tokens)`,仍是 chat 口径(embed/bge/gte-/rerank 照旧排除)。
`GREATEST` 作用在**项目的合计**上而不是逐行,以匹配定义 —— 所以 CTE 里把三个原始列
透传下去,而不是提前合并。

线上实测:

| Project | Tokens | 净增 | 占比 |
|---|---:|---:|---:|
| (master key) | 618.27M | **127.72M** | 20.7% |
| key:f8c96d72 | 231.1K | 33.1K | 14.3% |
| key:57f0a7fc | 21.4K | 21.4K | 99.8% |
| litellm-internal | 620 | 294 | 47.4% |

master key 单日口径更极端:2026-09-04 是 24.11M → 803.9K(**3.33%**),因为那天几乎全是
一条长会话在重放同一段 5 万 token 的上下文。

**`7d` 列让位给了 `净增`。** 这张卡放不下五列 —— 实测 `table-layout:fixed` 把首列固定的
36% 之外均分给四个数字格(每格约 16%),`618.27M` 会被截成 `618…`,连表头 `TOKENS` 都
变成 `TOK…`。同理也没把净增塞进 Tokens 格写成 `618.27M (21%)`:那比两个独立数字更宽,
截得更早。`tokens_7d` / `tokens_30d` 仍由查询返回,想换回来改一行 layout 即可。

`server/` 与 `web/` 零改动 —— table 渲染器本来就是全配置驱动的,加一列不需要碰代码。

---

## v2.12 — 2026-09-05

**Token 卡加"实际新增":总量里有多少是真算过的,多少只是被重放的缓存上下文。**

*Rebuild required — `server/` + `web/` changed.*

起因是查 09-04 那波涨:`qwen3.8-27b` 一天 1880 万 token,但每个请求真正新增的输入只有
110 个 —— 99.8% 的 prompt 是 KV 缓存命中的重放前缀。litellm 按完整重放的上下文记账,
所以一条长会话每轮把 5 万 token 的历史重发一次,账面就是几千万 token,后端其实只算了
那几百个新 token。卡上原来只有总量,看不出这件事。

新增口径 **实际新增 = (prompt − cache_read) + completion**,在两处露出:

- **卡面**每列在 `Today` 下面多一行 `净增 X`(今日值),紧贴总量好直接对比。
- **详情弹窗**表格多一列 `实际新增`,给累计值 + 它占本类总量的百分比。

2026-09-04 实测(桶未封口,数字还在涨):

| | 总量 | 实际新增 | 占比 |
|---|---:|---:|---:|
| qwen3.8-27b-main-128k | 18,808,662 | **466,687** | **2.48%** |
| qwen3.6-35b-a3b-mtp-64k | 2,660,427 | 249,837 | 9.39% |
| Chat / Large(卡面这一列) | 21,469,089 | **716,524** | **3.34%** |
| Embedding | 6,565 | 6,565 | 100%(不走缓存) |
| Chat / Large 累计 | 615.59M | 127.65M | 21% |

`net_tokens` 在 `queries/` 里是**可选列**。查询给了就渲染,没给(demo 板、旧的
queries/ 文件)`pivotTokens` 一路送 null,卡面那行和弹窗那列整个不出现 —— 没测量到
的东西不会被显示成 0。demo 板行为与改前逐字节一致。

标签全部配置驱动:`labels.net`(卡面)/ `columns.net`(弹窗)。

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
