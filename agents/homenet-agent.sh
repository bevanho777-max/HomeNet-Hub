#!/usr/bin/env bash
# HomeNet Hub push agent (Linux) — 协议 v1,契约见 docs/AGENT_PROTOCOL.md
# 零依赖:bash + coreutils + /proc + /sys;AMD GPU 走 amdgpu sysfs,NVIDIA 走 nvidia-smi
# 常驻循环进程,由 systemd service 拉起;采集失败只降级(省略字段),循环永不退出

set -u

# ---------- 配置(环境变量注入,见 /etc/homenet-agent.env) ----------
HUB_URL="${HUB_URL:?need HUB_URL, e.g. http://192.168.1.24:3100}"
AGENT_ID="${AGENT_ID:?need AGENT_ID, e.g. m26}"
PUSH_TOKEN="${PUSH_TOKEN:?need PUSH_TOKEN}"
INTERVAL="${INTERVAL:-2}"          # 推送间隔秒
NET_IFACE="${NET_IFACE:-}"         # 主网卡,缺省取默认路由网卡
GPU_NAMES="${GPU_NAMES:-}"         # 可选:逗号分隔卡名,按 idx 对应(AMD sysfs 拿不到型号名)

URL="${HUB_URL%/}/api/push/${AGENT_ID}"

# ---------- 网卡探测 ----------
if [ -z "$NET_IFACE" ]; then
  NET_IFACE=$(ip route show default 2>/dev/null \
    | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
fi

# ---------- GPU 探测(启动一次) ----------
GPU_MODE="none"
AMD_CARDS=()
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_MODE="nvidia"
else
  for d in /sys/class/drm/card*/device; do
    [ -f "$d/gpu_busy_percent" ] && AMD_CARDS+=("$d")
  done
  [ "${#AMD_CARDS[@]}" -gt 0 ] && GPU_MODE="amd"
fi

gpu_name_by_idx() {  # $1=idx → 名称或空
  [ -z "$GPU_NAMES" ] && return 0
  echo "$GPU_NAMES" | awk -F',' -v i="$(($1+1))" '{gsub(/^ +| +$/,"",$i); print $i}'
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

gpus_json() {  # 输出完整 "gpus":[...] 片段(必填,无卡为 [])
  local out="" i=0 d util vu vt hw tmp pw name frag
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
      for d in "${AMD_CARDS[@]}"; do
        frag="{\"idx\":$i"
        name=$(gpu_name_by_idx "$i");            [ -n "$name" ] && frag="$frag,\"name\":\"$name\""
        util=$(cat "$d/gpu_busy_percent" 2>/dev/null); [ -n "$util" ] && frag="$frag,\"util_pct\":$util"
        vu=$(cat "$d/mem_info_vram_used"  2>/dev/null)
        vt=$(cat "$d/mem_info_vram_total" 2>/dev/null)
        if [ -n "$vu" ] && [ -n "$vt" ]; then
          frag="$frag,$(awk -v u="$vu" -v t="$vt" 'BEGIN{printf "\"vram_used_gb\":%.1f,\"vram_total_gb\":%.1f", u/1073741824, t/1073741824}')"
        fi
        hw=$(ls -d "$d"/hwmon/hwmon* 2>/dev/null | head -1)
        if [ -n "$hw" ]; then
          tmp=$(cat "$hw/temp1_input" 2>/dev/null)
          [ -n "$tmp" ] && frag="$frag,\"temp_c\":$((tmp/1000))"
          pw=$(cat "$hw/power1_average" 2>/dev/null || cat "$hw/power1_input" 2>/dev/null)
          [ -n "$pw" ] && frag="$frag,\"power_w\":$((pw/1000000))"
        fi
        frag="$frag}"
        out="$out${out:+,}$frag"
        i=$((i+1))
      done
      ;;
  esac
  printf '"gpus":[%s]' "$out"
}

# ---------- 差值状态初始化 ----------
prev_cpu="$(read_cpu_snap)"
prev_rx=0; prev_tx=0
NET_OK=0
if [ -n "$NET_IFACE" ] && [ -r "/sys/class/net/$NET_IFACE/statistics/rx_bytes" ]; then
  NET_OK=1
  prev_rx=$(cat "/sys/class/net/$NET_IFACE/statistics/rx_bytes")
  prev_tx=$(cat "/sys/class/net/$NET_IFACE/statistics/tx_bytes")
fi
prev_ts=$(date +%s)

echo "[homenet-agent] id=$AGENT_ID hub=$URL iface=${NET_IFACE:-none} gpu=$GPU_MODE cards=${#AMD_CARDS[@]}" >&2

# ---------- 主循环 ----------
while :; do
  sleep "$INTERVAL"
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

  # net:计数器差 / 周期
  net_json=""
  if [ "$NET_OK" = "1" ]; then
    rx=$(cat "/sys/class/net/$NET_IFACE/statistics/rx_bytes" 2>/dev/null || echo "")
    tx=$(cat "/sys/class/net/$NET_IFACE/statistics/tx_bytes" 2>/dev/null || echo "")
    if [ -n "$rx" ] && [ -n "$tx" ]; then
      rbps=$(( (rx - prev_rx) / elapsed )); [ "$rbps" -lt 0 ] && rbps=0
      tbps=$(( (tx - prev_tx) / elapsed )); [ "$tbps" -lt 0 ] && tbps=0
      net_json="\"net\":{\"rx_bps\":$rbps,\"tx_bps\":$tbps},"
      prev_rx=$rx; prev_tx=$tx
    fi
  fi
  prev_ts=$now

  payload=$(printf '{"v":1,"id":"%s","ts":%d,"os":"linux",%s%s%s%s%s%s,"extra":{}}' \
    "$AGENT_ID" "$now" \
    "$(uptime_json)" "$cpu_json" "$(mem_json)" "$(disk_json)" "$net_json" "$(gpus_json)")

  curl -sf -m 1 --noproxy '*' \
    -H "X-Push-Token: $PUSH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" "$URL" -o /dev/null 2>/dev/null || true
done
