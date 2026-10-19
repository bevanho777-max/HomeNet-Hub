#!/usr/bin/env bash
# HomeNet Hub push agent (Linux) — 协议 v1,契约见 docs/AGENT_PROTOCOL.md
# 零依赖:bash + coreutils + /proc + /sys;AMD GPU 走 amdgpu sysfs(多卡按 PCI 排序),NVIDIA 走 nvidia-smi
# 常驻循环进程,由 systemd service 拉起;采集失败只降级(省略字段),循环永不退出

set -u

# 试跑模式:`homenet-agent.sh --once` 采集一个周期、把 payload 打到 stdout 后退出,
# 不推送,也不要求 HUB_URL / PUSH_TOKEN —— 部署前核对输出用。
ONCE=0
case "${1:-}" in --once) ONCE=1 ;; esac

# ---------- 配置(环境变量注入,见 /etc/homenet-agent.env) ----------
if [ "$ONCE" = "1" ]; then
  HUB_URL="${HUB_URL:-http://127.0.0.1:3100}"
  AGENT_ID="${AGENT_ID:-$(hostname)}"
  PUSH_TOKEN="${PUSH_TOKEN:-}"
else
  HUB_URL="${HUB_URL:?need HUB_URL, e.g. http://192.168.1.24:3100}"
  AGENT_ID="${AGENT_ID:?need AGENT_ID, e.g. m26}"
  PUSH_TOKEN="${PUSH_TOKEN:?need PUSH_TOKEN}"
fi
INTERVAL="${INTERVAL:-2}"          # 推送间隔秒
NET_IFACE="${NET_IFACE:-}"         # 主网卡,缺省取默认路由网卡
GPU_NAMES="${GPU_NAMES:-}"         # 可选:逗号分隔卡名,按 idx 对应(AMD sysfs 拿不到型号名)

# litellm 采集(仅网关机启用):不设 LITELLM_PG_DSN 就整段跳过,其余机器行为完全不变。
# DSN 走 homenet_ro 只读账号;psql 在 litellm-db 容器内执行,故主机名用 localhost。
LITELLM_PG_DSN="${LITELLM_PG_DSN:-}"
# 入站请求量按容器读访问日志,而两个 litellm 实例各收各的(4000 挂 27b,4001 挂 35b),
# 只读一个容器就只统计一半流量。这里收一份空格分隔的容器名列表并全部累加。旧的单容器
# LITELLM_CONTAINER 仍然生效,作为未设新变量时的默认值,老机器的 env 不用改。
LITELLM_CONTAINERS="${LITELLM_CONTAINERS:-${LITELLM_CONTAINER:-litellm}}"
LITELLM_DB_CONTAINER="${LITELLM_DB_CONTAINER:-litellm-db}"
LITELLM_TTL="${LITELLM_TTL:-45}"        # 真正采集的间隔秒(远大于 INTERVAL,不拖慢推送)
LITELLM_STALE="${LITELLM_STALE:-180}"   # 缓存超过此秒数即丢弃,字段整体省略

URL="${HUB_URL%/}/api/push/${AGENT_ID}"

# 自报版本(v2.18):脚本自身的 sha256,随 extra.agent 上报,hub 拿去和仓库 HEAD 的
# agents/homenet-agent.sh 比对。启动时算一次 —— 换脚本必然要重启 unit,不会算旧。
AGENT_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "$0")"
AGENT_SHA="$(sha256sum "$AGENT_SELF" 2>/dev/null | cut -d' ' -f1)"

# ---------- 网卡探测(启动 + 运行期自愈) ----------
# 用户显式给了 NET_IFACE 就固定用它,运行期不再改写;否则每次探测都重新取默认路由
# 网卡 —— 覆盖"agent 早于网络就绪启动"导致 net 字段永久缺失的情况。
NET_PINNED=0
[ -n "$NET_IFACE" ] && NET_PINNED=1

net_detect_iface() {  # 打印默认路由网卡名,取不到则为空
  ip route show default 2>/dev/null \
    | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}'
}

# (重新)建立计数器基线:成功置 NET_OK=1 并重置 prev_rx/prev_tx,失败置 0。
# 状态或网卡名变化时记一行日志(启动横幅之后才开),不再静默失败。
net_probe() {
  local cand old_ok="$NET_OK" old_iface="$NET_IFACE"
  if [ "$NET_PINNED" = "1" ]; then cand="$NET_IFACE"; else cand="$(net_detect_iface)"; fi
  if [ -n "$cand" ] && [ -r "/sys/class/net/$cand/statistics/rx_bytes" ]; then
    NET_IFACE="$cand"
    prev_rx=$(cat "/sys/class/net/$cand/statistics/rx_bytes" 2>/dev/null || echo 0)
    prev_tx=$(cat "/sys/class/net/$cand/statistics/tx_bytes" 2>/dev/null || echo 0)
    NET_OK=1
  else
    [ "$NET_PINNED" = "1" ] || NET_IFACE="$cand"
    NET_OK=0
  fi
  if [ "$NET_LOG" = "1" ] && { [ "$NET_OK" != "$old_ok" ] || [ "$NET_IFACE" != "$old_iface" ]; }; then
    echo "[homenet-agent] net: ${old_iface:-none} -> ${NET_IFACE:-none} (ok=$NET_OK)" >&2
  fi
}

# ---------- GPU 探测(启动一次) ----------
# AMD 多卡(v2.18):只认 vendor=0x1002 的 /sys/class/drm/cardN,张数不写死。按 PCI 地址
# 排序编号 —— cardN 的 N 由驱动加载顺序决定,重启后可能互换;PCI 地址是插槽,不会变,
# 所以 idx 0/1 永远对应同一块物理卡(m25:03:00.0=GPU0、03:02.0=GPU1)。虚拟机里的
# VMware SVGA(0x15ad)之类自然被排除。
GPU_MODE="none"
AMD_CARDS=()      # device 目录(readlink -f 后的真实路径),已按 PCI 排序
AMD_PCI=()        # PCI 地址,如 0000:03:00.0
AMD_NAME=()       # 型号名;读不到则空
AMD_HW=()         # hwmon 目录;没有则空
AMD_T_EDGE=(); AMD_T_JUNC=(); AMD_T_MEM=(); AMD_PWR=()   # 各传感器文件路径;没有则空

gpu_name_by_idx() {  # $1=idx → GPU_NAMES 里对应的名字或空(手动覆盖,优先于自动识别)
  [ -z "$GPU_NAMES" ] && return 0
  echo "$GPU_NAMES" | awk -F',' -v i="$(($1+1))" '{gsub(/^ +| +$/,"",$i); print $i}'
}

amd_model() {  # $1=device 目录 → 型号名。sysfs 只给 PCI device id,这里认识家里在用的几种
  local d="$1" id pn=""
  { read -r pn < "$d/product_name"; } 2>/dev/null
  [ -n "$pn" ] && { echo "$pn"; return; }
  { read -r id < "$d/device"; } 2>/dev/null
  case "$id" in
    0x744c) echo "RX 7900 XTX" ;;
    0x73bf|0x73af) echo "RX 6900 XT" ;;
    0x73a5) echo "RX 6950 XT" ;;
    0x73df) echo "RX 6700 XT" ;;
    "") ;;
    *) echo "AMD $id" ;;
  esac
}

amd_probe() {
  local c d v pci hw f lbl i=0
  while read -r pci d; do
    [ -n "$d" ] || continue
    AMD_CARDS+=("$d"); AMD_PCI+=("$pci")
    v="$(gpu_name_by_idx "$i")"; [ -n "$v" ] || v="$(amd_model "$d")"
    AMD_NAME+=("$v")
    hw=$(ls -d "$d"/hwmon/hwmon* 2>/dev/null | head -1)
    AMD_HW+=("$hw")
    local te="" tj="" tm=""
    if [ -n "$hw" ]; then
      # 温度按 tempN_label 认 edge/junction/mem;老内核没有 label 时 temp1 就是 edge
      for f in "$hw"/temp*_label; do
        [ -f "$f" ] || continue
        lbl=""; { read -r lbl < "$f"; } 2>/dev/null
        case "$lbl" in
          edge) te="${f%_label}_input" ;;
          junction) tj="${f%_label}_input" ;;
          mem) tm="${f%_label}_input" ;;
        esac
      done
      [ -z "$te" ] && [ -f "$hw/temp1_input" ] && te="$hw/temp1_input"
      # power1_average(RDNA2 及以前)与 power1_input(RDNA3 起部分内核)二选一
      if [ -f "$hw/power1_average" ]; then AMD_PWR+=("$hw/power1_average")
      elif [ -f "$hw/power1_input" ]; then AMD_PWR+=("$hw/power1_input")
      else AMD_PWR+=(""); fi
    else
      AMD_PWR+=("")
    fi
    AMD_T_EDGE+=("$te"); AMD_T_JUNC+=("$tj"); AMD_T_MEM+=("$tm")
    i=$((i+1))
  done < <(
    for c in /sys/class/drm/card*; do
      case "${c##*/}" in card[0-9]|card[0-9][0-9]) ;; *) continue ;; esac   # 跳过 card0-DP-1 这类接口
      d="$(readlink -f "$c/device" 2>/dev/null)" || continue
      v=""; { read -r v < "$d/vendor"; } 2>/dev/null
      [ "$v" = "0x1002" ] || continue
      printf '%s %s\n' "${d##*/}" "$d"
    done | sort -u
  )
}

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_MODE="nvidia"
else
  amd_probe
  [ "${#AMD_CARDS[@]}" -gt 0 ] && GPU_MODE="amd"
fi

# 使用率采样(仅 AMD):gpu_busy_percent 是瞬时值,推理负载下一秒内能在 0 与 100 之间跳。
# 每个上报周期内分 GPU_SAMPLES 次读取取平均,而不是只取推送那一刻的一个点。
GPU_SAMPLES="${GPU_SAMPLES:-4}"
case "$GPU_SAMPLES" in ''|*[!0-9]*|0) GPU_SAMPLES=4 ;; esac
BUSY_SUM=(); BUSY_N=()
busy_reset() { local i; for i in "${!AMD_CARDS[@]}"; do BUSY_SUM[$i]=0; BUSY_N[$i]=0; done; }
busy_sample() {
  local i v
  for i in "${!AMD_CARDS[@]}"; do
    v=""; { read -r v < "${AMD_CARDS[$i]}/gpu_busy_percent"; } 2>/dev/null
    case "$v" in ''|*[!0-9]*) continue ;; esac
    BUSY_SUM[$i]=$(( BUSY_SUM[$i] + v )); BUSY_N[$i]=$(( BUSY_N[$i] + 1 ))
  done
}
# 代替主循环里的 sleep:总时长仍是 INTERVAL,其间均匀取 GPU_SAMPLES 个样
interval_sleep() {
  if [ "$GPU_MODE" != "amd" ] || [ "$GPU_SAMPLES" -le 1 ]; then
    sleep "$INTERVAL"; [ "$GPU_MODE" = "amd" ] && busy_sample
    return
  fi
  local k slice
  slice=$(awk -v t="$INTERVAL" -v n="$GPU_SAMPLES" 'BEGIN{printf "%.3f", t/n}')
  for ((k = 0; k < GPU_SAMPLES; k++)); do sleep "$slice"; busy_sample; done
}

# ---------- 采集函数(失败输出空串) ----------
read_cpu_snap() {  # 输出: idle total
  awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++)t+=$i; print idle, t}' /proc/stat 2>/dev/null
}

mem_json() {
  awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}
       END{if(t>0) printf "\"mem\":{\"used_gb\":%.1f,\"total_gb\":%.1f},", (t-a)/1048576, t/1048576}' \
       /proc/meminfo 2>/dev/null
}

disk_json() {
  df -B1 / 2>/dev/null | awk 'NR==2 && $2>0 {
    printf "\"disk\":{\"used_gb\":%.0f,\"total_gb\":%.0f},", $3/1073741824, $2/1073741824}'
}

load_json() {
  awk '{printf "\"load\":[%s,%s,%s]", $1, $2, $3}' /proc/loadavg 2>/dev/null
}

uptime_json() {
  awk '{printf "\"uptime_s\":%d,", $1}' /proc/uptime 2>/dev/null
}

# ---------- litellm 采集(仅网关机;整段受 LITELLM_PG_DSN 开关保护) ----------
# 读 LiteLLM_DailyUserSpend 预聚合表(SpendLogs 明细未启用)。
#
# 取桶方式:按 **北京当前日期** 去匹配 date 列,而不是容器的 UTC 日期。
# date 列是 litellm 硬编码 UTC 写的、且只有天粒度,这一点改不了;能选的只是读哪个桶。
# 取北京日期的效果:归零落在北京 00:00(而非 08:00),且北京 08:00-24:00 整个白天
# 显示值与取 UTC 桶完全一致 —— 差异只发生在北京 00:00-08:00。
#
# 无法解决的局限:北京 00:00-08:00 的请求写在 UTC 前一天的桶里,永远不会出现在
# "今天"的数里。该时段目标桶尚未创建,SUM 返回 NULL —— 这里刻意不 COALESCE 成 0,
# 让字段整体省略、卡片显示 "—"(无数据),而不是谎报成 0 个请求。
#
# 保留原有两个过滤:排除 litellm 自身的后端探活(api_key=litellm-internal-health-check),
# 只算解析出模型的行(model<>''),滤掉鉴权失败噪声。
# 成功率分母用 api_requests:该表满足 api_requests = successful + failed(全表 465 行
# 无一例外),分母本就含失败数,不需要额外修正。
# 请求量按 model(实际部署名)拆,不按 model_group:27b 与 35b 溢出节点共用同一个 group。
#
# ── CHAT-ONLY 口径(v2.11)──────────────────────────────────────────────
# cache_hit / success / reqs_today 只统计 **非 embedding** 行。理由是实测出来的:
# 这台网关全库 16,711,548 次请求里 16,692,468 次(99.886%)是 mxbai-embed,而且
# 它几乎全失败(成功 5,146 / 失败 16,686,876)—— RAG 侧的重试风暴。三个指标混算的
# 后果:
#   • success  全库 0.14%,chat 真实 92.01%。2026-08-20 卡上会显 0.4%,chat 实为
#              95.1%;反过来 08-24/25 卡显 75%、chat 实为 66% —— 两个方向都失真,
#              因为混合权重由 RAG 的重试次数决定,跟对话服务的健康度无关。
#   • reqs_today 08-20 显 321,276,chat 实为 588(虚高 546 倍);平日也虚高 ~12%。
#   • cache_hit 几乎不受影响(embedding 只占全库 prompt_tokens 的 0.066%,且
#              cache_read 恒为 0,全库 79.95% vs 80.01%)—— 这里一并过滤是为了
#              让三个数出自同一个子集,而不是因为它算错了。
# embedding 没有被藏起来:reqs_by_model 的 emb 槽仍然按原样发,风暴期它就是"数字
# 不对是因为 RAG"的那条线索。因此四个槽之和 ≠ reqs_today,这是刻意的。
# 排除模式与 queries/project_tokens.sql 的 excluded_models 保持同一份。
#
# 桶存在性与"今天没有对话"是两回事,所以多带一个 reqs_any(全模型请求数)出去:
# 北京 00:00-08:00 目标桶尚未创建 -> reqs_any 为空 -> reqs_today/by_model 整体省略、
# 卡片显 "—";桶存在但当天只有 embedding 流量 -> reqs_any 有值而 chat 侧 SUM 为
# NULL -> 解析层把 reqs_today 记 0(今天确实零次对话),by_model 照常发出 emb 槽。
llm_sql() {
  cat <<'SQL'
WITH t AS (
  SELECT * FROM "LiteLLM_DailyUserSpend"
  WHERE date = to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
    AND api_key <> 'litellm-internal-health-check'
), llm AS (
  SELECT *,
         (lower(model) LIKE '%embed%'    -- text-embedding-*, mxbai-embed-*, nomic-embed-*
          OR lower(model) LIKE '%bge%'   -- BAAI/bge-*(名字里不带 embed)
          OR lower(model) LIKE '%gte-%'  -- 阿里 GTE;连字符避免误伤聊天模型名
          OR lower(model) LIKE '%rerank%') AS is_emb
  FROM t WHERE COALESCE(model,'') <> ''
), chat AS (
  SELECT * FROM llm WHERE NOT is_emb
)
SELECT 'S|'||COALESCE(ROUND(100.0*SUM(cache_read_input_tokens)/NULLIF(SUM(prompt_tokens),0),1)::text,'')
        ||'|'||COALESCE(ROUND(100.0*SUM(successful_requests)/NULLIF(SUM(api_requests),0),1)::text,'')
        ||'|'||COALESCE(SUM(api_requests)::text,'')
        ||'|'||COALESCE((SELECT SUM(api_requests) FROM llm)::text,'')
FROM chat
UNION ALL
-- 四槽固定顺序 27b/35b/emb/other。is_emb 先判,免得将来出现名字里同时含 "bge" 和
-- "27b" 的向量模型被归进 chat 槽;other 槽补发,之前算了却不发 —— 全库请求数第一的
-- chat 模型 qwen3.6-27b-main-128k(11,548 次)就整个落在里面、卡上完全看不到。
-- 27b/35b 的模式从写死的 %qwen3.8-27b% / %qwen3.6-35b% 放宽到 %27b% / %35b%,换
-- 一个小版本号的部署名不会再静默掉进 other。
SELECT 'M|'||tag||'|'||reqs::text FROM (
  SELECT CASE WHEN is_emb              THEN 'emb'
              WHEN model LIKE '%27b%'  THEN '27b'
              WHEN model LIKE '%35b%'  THEN '35b'
              ELSE 'other' END AS tag,
         SUM(api_requests) AS reqs
  FROM llm GROUP BY 1
) x;
SQL
}

llm_isnum() { case "$1" in ''|*[!0-9.]*) return 1;; *) return 0;; esac; }

# 输出 extra.litellm 的 JSON 片段(不含外层花括号),失败输出空串 → 字段整体省略。
llm_collect() {
  local raw stats logs ch sp rt ra r5 r5e n ne c m1 m2 m3 m4 out=""
  [ -n "$LITELLM_PG_DSN" ] || return 0      # 未启用则整段跳过(主循环也有守卫,这里保证函数自洽)
  raw=$(llm_sql | timeout 6 docker exec -i "$LITELLM_DB_CONTAINER" \
          psql "$LITELLM_PG_DSN" -tAq 2>/dev/null) || raw=""
  stats=$(printf '%s\n' "$raw" | grep '^S|' | head -1)
  if [ -n "$stats" ]; then
    ch=$(printf '%s' "$stats" | cut -d'|' -f2)   # chat-only cache_hit
    sp=$(printf '%s' "$stats" | cut -d'|' -f3)   # chat-only success
    rt=$(printf '%s' "$stats" | cut -d'|' -f4)   # chat-only reqs_today
    ra=$(printf '%s' "$stats" | cut -d'|' -f5)   # 全模型请求数,只用来判断今天的桶存不存在
    llm_isnum "$ch" && out="$out\"cache_hit_pct\":$ch,"
    llm_isnum "$sp" && out="$out\"success_pct\":$sp,"
    # 桶存在(ra 有值)就一定发 reqs_today:当天只有 embedding 流量时 chat 侧 SUM 为
    # NULL,那是"零次对话"而不是"没数据",记 0。桶整个不存在(北京 00:00-08:00)才
    # 连同 by_model 一起省略,卡片显 "—"。
    if llm_isnum "$ra"; then
      llm_isnum "$rt" || rt=0
      out="$out\"reqs_today\":$rt,"
      # 四个槽位固定顺序 27b/35b/emb/other。桶内没有该类的请求记 0(而非缺失),避免小格错位。
      m1=$(printf '%s\n' "$raw" | awk -F'|' '$1=="M" && $2=="27b"{print $3; exit}')
      m2=$(printf '%s\n' "$raw" | awk -F'|' '$1=="M" && $2=="35b"{print $3; exit}')
      m3=$(printf '%s\n' "$raw" | awk -F'|' '$1=="M" && $2=="emb"{print $3; exit}')
      m4=$(printf '%s\n' "$raw" | awk -F'|' '$1=="M" && $2=="other"{print $3; exit}')
      llm_isnum "$m1" || m1=0; llm_isnum "$m2" || m2=0
      llm_isnum "$m3" || m3=0; llm_isnum "$m4" || m4=0
      out="$out\"by_model\":{\"m1\":$m1,\"m1_label\":\"27b\",\"m2\":$m2,\"m2_label\":\"35b\",\"m3\":$m3,\"m3_label\":\"emb\",\"m4\":$m4,\"m4_label\":\"other\"},"
    fi
  fi
  # 近 5 分钟入站 LLM 请求:走访问日志,天然不含 litellm→后端的健康探测(那些不是入站 HTTP)。
  # 日志为空是常态(流量稀疏),要与"取不到日志"区分:前者记 0,后者省略字段。
  # 多实例逐个累加(LITELLM_CONTAINERS 故意不加引号,靠分词取列表)。任何一个容器的日志取
  # 不到(没跑/改名/docker 报错)就整个字段省略,而不是报一个只含另一半流量的数 —— 少一个
  # 数看得出来是"—",少一半流量看起来像个正常的小数字,不会有人发现。
  #
  # v2.11:与 SQL 侧同样改成 chat-only —— reqs_5m 只数对话端点,/v1/embeddings 单独
  # 数进 reqs_5m_embed。当前实测 24h 内 242 次 /v1/responses、2 次 chat/completions、
  # 1 次 embeddings,污染 <0.5%;但 2026-07-13 那种重试风暴是 1,760,051 次/天
  # (≈6,100 次/5 分钟),那时 reqs_5m 会整个变成 RAG 计数器。两个数一起采、一起省略,
  # 保持"要么都有要么都是 —"的既有约定。
  r5=0; r5e=0
  for c in $LITELLM_CONTAINERS; do
    if logs=$(timeout 5 docker logs --since 5m "$c" 2>/dev/null); then
      n=$(printf '%s\n' "$logs" \
        | grep -cE '"POST /v1/(chat/completions|responses|completions)[^"]*" [0-9]{3}' || true)
      ne=$(printf '%s\n' "$logs" \
        | grep -cE '"POST /v1/embeddings[^"]*" [0-9]{3}' || true)
      if llm_isnum "$n" && llm_isnum "$ne"; then r5=$((r5 + n)); r5e=$((r5e + ne));
      else r5=""; break; fi
    else
      r5=""; break
    fi
  done
  [ -n "$r5" ] && out="$out\"reqs_5m\":$r5,\"reqs_5m_embed\":$r5e,"
  [ -n "$out" ] && printf '"litellm":{%s}' "${out%,}"
}

sysfs_int() {  # $1=文件 → 整数内容;读不到/非整数输出空串
  local v=""
  [ -n "$1" ] || return 0
  { read -r v < "$1"; } 2>/dev/null
  case "$v" in ''|*[!0-9]*) ;; *) printf '%s' "$v" ;; esac
}

gpus_json() {  # 输出完整 "gpus":[...] 片段(必填,无卡为 [])
  local out="" i d util vu vt t pw cap frag
  case "$GPU_MODE" in
    nvidia)
      out=$(nvidia-smi \
        --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw \
        --format=csv,noheader,nounits 2>/dev/null \
        | awk -F', *' 'NF>=7 {
            printf "%s{\"idx\":%d,\"name\":\"%s\",\"util_pct\":%d,\"vram_used_gb\":%.1f,\"vram_total_gb\":%.1f,\"temp_c\":%d,\"power_w\":%.0f}", \
              (n++?",":""), $1, $2, $3, $4/1024, $5/1024, $6, $7 }')
      ;;
    amd)
      # 每卡一项,idx 即 PCI 排序后的序号。读不到的项省略(不报 0)。
      #   util_pct      本周期内多次采样的平均(见 interval_sleep)
      #   temp_c        edge —— 与其他机器、旧版 agent 同一个传感器,卡面温度沿用它
      #   temp_junction_c / temp_mem_c  热点与显存温度,只进明细
      #   power_w / power_cap_w         微瓦 → 瓦,四舍五入
      for i in "${!AMD_CARDS[@]}"; do
        d="${AMD_CARDS[$i]}"
        frag="{\"idx\":$i,\"pci\":\"${AMD_PCI[$i]}\""
        [ -n "${AMD_NAME[$i]}" ] && frag="$frag,\"name\":\"${AMD_NAME[$i]}\""
        if [ "${BUSY_N[$i]:-0}" -gt 0 ]; then
          util=$(( (BUSY_SUM[$i] + BUSY_N[$i] / 2) / BUSY_N[$i] ))
        else
          util=$(sysfs_int "$d/gpu_busy_percent")
        fi
        [ -n "$util" ] && frag="$frag,\"util_pct\":$util"
        vu=$(sysfs_int "$d/mem_info_vram_used")
        vt=$(sysfs_int "$d/mem_info_vram_total")
        if [ -n "$vu" ] && [ -n "$vt" ]; then
          frag="$frag,$(awk -v u="$vu" -v t="$vt" 'BEGIN{printf "\"vram_used_gb\":%.1f,\"vram_total_gb\":%.1f", u/1073741824, t/1073741824}')"
        fi
        t=$(sysfs_int "${AMD_T_EDGE[$i]}"); [ -n "$t" ] && frag="$frag,\"temp_c\":$((t/1000))"
        t=$(sysfs_int "${AMD_T_JUNC[$i]}"); [ -n "$t" ] && frag="$frag,\"temp_junction_c\":$((t/1000))"
        t=$(sysfs_int "${AMD_T_MEM[$i]}");  [ -n "$t" ] && frag="$frag,\"temp_mem_c\":$((t/1000))"
        pw=$(sysfs_int "${AMD_PWR[$i]}");   [ -n "$pw" ] && frag="$frag,\"power_w\":$(( (pw + 500000) / 1000000 ))"
        if [ -n "${AMD_HW[$i]}" ]; then
          cap=$(sysfs_int "${AMD_HW[$i]}/power1_cap")
          [ -n "$cap" ] && [ "$cap" -gt 0 ] && frag="$frag,\"power_cap_w\":$(( (cap + 500000) / 1000000 ))"
        fi
        out="$out${out:+,}$frag}"
      done
      ;;
  esac
  printf '"gpus":[%s]' "$out"
}

# ---------- 差值状态初始化 ----------
prev_cpu="$(read_cpu_snap)"
prev_rx=0; prev_tx=0
NET_OK=0
NET_LOG=0                                  # 启动横幅之前不打网卡状态日志
net_probe
NET_RETRY_TICKS="${NET_RETRY_TICKS:-15}"   # NET_OK=0 时每 N 拍重探(默认 2s/拍 -> 约 30s)
net_retry=0
prev_ts=$(date +%s)

# litellm 采集的 last-known-good 缓存:真正采集每 LITELLM_TTL 秒一次,其余拍复用上次结果。
# 推送用 curl -m 1,采集绝不能跟在它的预算里,所以这里跟 nas75 agent 的 DISKS_INTERVAL 同构。
llm_cache=""; llm_cache_ts=0

busy_reset

echo "[homenet-agent] id=$AGENT_ID hub=$URL iface=${NET_IFACE:-none} gpu=$GPU_MODE cards=${#AMD_CARDS[@]}${AMD_PCI[*]:+ (${AMD_PCI[*]})} litellm=$([ -n "$LITELLM_PG_DSN" ] && echo on || echo off) sha=${AGENT_SHA:0:12}$([ "$ONCE" = 1 ] && echo ' once')" >&2
NET_LOG=1                                  # 之后网卡状态每次变化都记一行

# ---------- 主循环 ----------
while :; do
  interval_sleep                           # = sleep $INTERVAL,AMD 卡顺带多次采样使用率
  now=$(date +%s)
  elapsed=$((now - prev_ts)); [ "$elapsed" -lt 1 ] && elapsed=1

  # cpu:两周期 /proc/stat 差值
  cpu_json=""
  cur_cpu="$(read_cpu_snap)"
  if [ -n "$cur_cpu" ] && [ -n "$prev_cpu" ]; then
    cpu_json=$(awk -v p="$prev_cpu" -v c="$cur_cpu" 'BEGIN{
      split(p,a," "); split(c,b," ");
      dt=b[2]-a[2]; di=b[1]-a[1];
      if(dt>0){ pct=(dt-di)/dt*100; if(pct<0)pct=0; if(pct>100)pct=100;
        printf "\"cpu\":{\"pct\":%.1f,LOAD},", pct }
    }')
    ld=$(load_json)
    if [ -n "$ld" ]; then cpu_json="${cpu_json/LOAD/$ld}"; else cpu_json="${cpu_json/,LOAD/}"; fi
  fi
  prev_cpu="$cur_cpu"

  # net:计数器差 / 周期。读不到就地重探,未就绪则按 NET_RETRY_TICKS 定期重试
  net_json=""
  if [ "$NET_OK" = "1" ]; then
    rx=$(cat "/sys/class/net/$NET_IFACE/statistics/rx_bytes" 2>/dev/null || echo "")
    tx=$(cat "/sys/class/net/$NET_IFACE/statistics/tx_bytes" 2>/dev/null || echo "")
    if [ -n "$rx" ] && [ -n "$tx" ]; then
      rbps=$(( (rx - prev_rx) / elapsed )); [ "$rbps" -lt 0 ] && rbps=0
      tbps=$(( (tx - prev_tx) / elapsed )); [ "$tbps" -lt 0 ] && tbps=0
      net_json="\"net\":{\"rx_bps\":$rbps,\"tx_bps\":$tbps},"
      prev_rx=$rx; prev_tx=$tx
    else
      net_probe                            # 网卡消失/不可读 -> 立即重探
    fi
  else
    net_retry=$((net_retry + 1))
    if [ "$net_retry" -ge "$NET_RETRY_TICKS" ]; then
      net_retry=0
      net_probe                            # 本拍只建基线,下一拍起恢复出数
    fi
  fi
  prev_ts=$now

  # litellm:每 LITELLM_TTL 秒才真采一次(PG ~160ms + docker logs ~70ms),其余拍走缓存。
  # 缓存超过 LITELLM_STALE 未刷新就整体丢弃,宁可小格显示 "—" 也不展示陈旧数字。
  llm_extra=""
  if [ -n "$LITELLM_PG_DSN" ]; then
    if [ $((now - llm_cache_ts)) -ge "$LITELLM_TTL" ]; then
      llm_fresh=$(llm_collect)
      [ -n "$llm_fresh" ] && { llm_cache=$llm_fresh; llm_cache_ts=$now; }
    fi
    llm_extra="$llm_cache"
    [ -n "$llm_extra" ] && [ $((now - llm_cache_ts)) -gt "$LITELLM_STALE" ] && llm_extra=""
  fi

  extra_json=""
  [ -n "$AGENT_SHA" ] && extra_json="\"agent\":{\"file\":\"homenet-agent.sh\",\"sha256\":\"$AGENT_SHA\"}"
  [ -n "$llm_extra" ] && extra_json="$extra_json${extra_json:+,}$llm_extra"

  payload=$(printf '{"v":1,"id":"%s","ts":%d,"os":"linux",%s%s%s%s%s%s,"extra":{%s}}' \
    "$AGENT_ID" "$now" \
    "$(uptime_json)" "$cpu_json" "$(mem_json)" "$(disk_json)" "$net_json" "$(gpus_json)" \
    "$extra_json")
  busy_reset                               # gpus_json 跑在子 shell 里,清零只能在这里做

  if [ "$ONCE" = "1" ]; then
    printf '%s\n' "$payload"
    exit 0
  fi

  curl -sf -m 1 --noproxy '*' \
    -H "X-Push-Token: $PUSH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" "$URL" -o /dev/null 2>/dev/null || true
done
