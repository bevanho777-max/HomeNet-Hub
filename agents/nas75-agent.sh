#!/usr/bin/env bash
# HomeNet Hub push agent for Synology NAS (id: nas75) -- protocol v1, see docs/AGENT_PROTOCOL.md
# Zero-dependency: bash + coreutils/busybox + /proc + /sys. No GPU, no root required
# (smartctl / disk temperature are intentionally skipped). ASCII-only comments on
# purpose (agents/ convention: survive cross-system copy without newline damage).
#
# Collected: cpu.pct (/proc/stat delta), cpu.load (/proc/loadavg), mem (/proc/meminfo),
#   uptime_s (/proc/uptime), net rx/tx bps (default-route iface, /sys/class/net delta),
#   extra.volumes[] (every /volume*, df -kP), extra.raid (from /proc/mdstat).
#
# ----------------------------------------------------------------------------------
# DEPLOYMENT (Synology DSM has no systemd -- self-daemon + cron keep-alive):
#   1) Put this script at e.g. /volume1/scripts/nas75-agent.sh ; chmod +x it.
#   2) Provide config via env. Easiest: a wrapper the cron line sources, or inline env.
#   3) DSM > Control Panel > Task Scheduler:
#        - Boot-up triggered task (root or admin) running:
#             HUB_URL=http://<hub>:3100 PUSH_TOKEN=<token> /volume1/scripts/nas75-agent.sh
#        - A "Scheduled Task" repeating every 1 minute running the SAME line.
#      The pidfile check below makes the minute-task a no-op while the loop is alive,
#      and a relaunch if it ever died. (Equivalently, a crontab line:
#        * * * * * HUB_URL=http://<hub>:3100 PUSH_TOKEN=<token> /volume1/scripts/nas75-agent.sh )
# ----------------------------------------------------------------------------------

set -u

# ---------- config (env-injected) ----------
HUB_URL="${HUB_URL:?need HUB_URL, e.g. http://192.168.x.x:3100}"
PUSH_TOKEN="${PUSH_TOKEN:?need PUSH_TOKEN}"
AGENT_ID="${AGENT_ID:-nas75}"
INTERVAL="${INTERVAL:-2}"                 # push interval seconds (same as other agents)
NET_IFACE="${NET_IFACE:-}"                # main NIC; default = default-route interface
PIDFILE="${PIDFILE:-/tmp/nas75-agent.pid}"

URL="${HUB_URL%/}/api/push/${AGENT_ID}"

# ---------- self-daemon: exit if an instance is already running (cron keep-alive) ----------
if [ -f "$PIDFILE" ]; then
  oldpid=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    exit 0                                 # already running -> this launch is a no-op
  fi
fi
echo "$$" > "$PIDFILE" 2>/dev/null || true
trap 'rm -f "$PIDFILE" 2>/dev/null' EXIT INT TERM

# ---------- NIC discovery ----------
if [ -z "$NET_IFACE" ]; then
  NET_IFACE=$(ip route show default 2>/dev/null \
    | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
fi

# ---------- collectors (empty string on failure -> field omitted) ----------
read_cpu_snap() {  # prints: idle total
  awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++)t+=$i; print idle, t}' /proc/stat 2>/dev/null
}

load_json() {
  awk '{printf "\"load\":[%s,%s,%s]", $1, $2, $3}' /proc/loadavg 2>/dev/null
}

uptime_json() {
  awk '{printf "\"uptime_s\":%d,", $1}' /proc/uptime 2>/dev/null
}

mem_json() {
  awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}
       END{if(t>0) printf "\"mem\":{\"used_gb\":%.1f,\"total_gb\":%.1f},", (t-a)/1048576, t/1048576}' \
       /proc/meminfo 2>/dev/null
}

# extra.volumes[] : every /volume* mount, GB used/total via df -kP (POSIX, single line)
volumes_json() {
  local out="" v name line total used frag
  for v in /volume*; do
    [ -d "$v" ] || continue
    line=$(df -kP "$v" 2>/dev/null | awk 'NR==2 && $2>0 {print $3, $2}')  # used_k total_k
    [ -z "$line" ] && continue
    used=${line% *}; total=${line#* }
    name=$(basename "$v")
    frag=$(awk -v n="$name" -v u="$used" -v t="$total" 'BEGIN{
      printf "{\"name\":\"%s\",\"used_gb\":%.0f,\"total_gb\":%.0f}", n, u/1048576, t/1048576}')
    out="$out${out:+,}$frag"
  done
  [ -n "$out" ] || return 0            # every df failed this cycle -> signal miss (loop reuses cache)
  printf '"volumes":[%s]' "$out"
}

# Standard top-level disk{used_gb,total_gb} = aggregate of ALL /volume* (same shape
# as other agents' disk field), alongside the per-volume breakdown in extra.volumes.
disk_json() {
  local v line used total su=0 st=0
  for v in /volume*; do
    [ -d "$v" ] || continue
    line=$(df -kP "$v" 2>/dev/null | awk 'NR==2 && $2>0 {print $3, $2}')  # used_k total_k
    [ -z "$line" ] && continue
    used=${line% *}; total=${line#* }
    su=$((su + used)); st=$((st + total))
  done
  [ "$st" -gt 0 ] || return 0
  awk -v u="$su" -v t="$st" 'BEGIN{printf "\"disk\":{\"used_gb\":%.0f,\"total_gb\":%.0f},", u/1048576, t/1048576}'
}

# extra.raid : health summary from /proc/mdstat (clean / degraded / resync / none).
# Only DATA arrays (md2 and up) count toward "degraded": DSM's md0/md1 are the
# system + swap RAID1 that span ALL disk slots and legitimately show "_" in their
# [x/y] bitmap when the bays aren't fully populated -- that is NOT a fault.
# resync/recovery/reshape/check on any array is reported as "resync".
raid_json() {
  local content parsed status data_n detail
  [ -r /proc/mdstat ] || return 0                 # unreadable this cycle -> miss (loop reuses cache)
  content=$(cat /proc/mdstat 2>/dev/null)
  [ -n "$content" ] || return 0                   # empty read -> miss
  parsed=$(printf '%s\n' "$content" | awk '
    /^md[0-9]+[ \t]*:/ { n=$1; sub(/^md/,"",n); num=n+0; name=$1 }
    match($0, /\[[U_]+\]/) {
      bm=substr($0,RSTART,RLENGTH)
      if (num>=2) { data++; det=det (det?" ":"") name":"bm; if (bm ~ /_/) deg=1 }
    }
    /recovery|resync|reshape|check/ { sync=1 }
    END {
      st = sync ? "resync" : (deg ? "degraded" : (data>0 ? "clean" : "none"))
      printf "%s|%d|%s", st, data+0, det
    }')
  status=${parsed%%|*}; parsed=${parsed#*|}
  data_n=${parsed%%|*}; detail=${parsed#*|}
  printf '"raid":{"status":"%s","detail":"%s data arrays %s"}' "$status" "$data_n" "$detail"
}

# ---------- last-known-good picker (df / mdstat can fail for a single cycle) ----------
# Prefer this cycle's value; else reuse the cached one while within CACHE_TTL; else
# empty (field omitted). The cache variables themselves are updated by the main loop.
cache_pick() {
  local fresh="$1" cache="$2" cts="$3" now="$4"
  if [ -n "$fresh" ]; then printf '%s' "$fresh"; return 0; fi
  if [ -n "$cache" ] && [ $((now - cts)) -le "$CACHE_TTL" ]; then printf '%s' "$cache"; fi
}

# ---------- delta state init ----------
prev_cpu="$(read_cpu_snap)"
prev_rx=0; prev_tx=0
NET_OK=0
if [ -n "$NET_IFACE" ] && [ -r "/sys/class/net/$NET_IFACE/statistics/rx_bytes" ]; then
  NET_OK=1
  prev_rx=$(cat "/sys/class/net/$NET_IFACE/statistics/rx_bytes")
  prev_tx=$(cat "/sys/class/net/$NET_IFACE/statistics/tx_bytes")
fi
prev_ts=$(date +%s)

# last-known-good cache for df/mdstat-based fields (disk, extra.volumes, extra.raid)
CACHE_TTL="${CACHE_TTL:-60}"          # max seconds to reuse a stale value before omitting
disk_cache=""; disk_cache_ts=0
vol_cache="";  vol_cache_ts=0
raid_cache=""; raid_cache_ts=0

echo "[nas75-agent] id=$AGENT_ID hub=$URL iface=${NET_IFACE:-none}" >&2

# ---------- main loop ----------
while :; do
  sleep "$INTERVAL"
  now=$(date +%s)
  elapsed=$((now - prev_ts)); [ "$elapsed" -lt 1 ] && elapsed=1

  # cpu: /proc/stat delta over one interval
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

  # net: counter delta / interval
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

  # disk / volumes / raid come from df + /proc/mdstat, which can fail for a single
  # cycle on a busy NAS and would otherwise drop the whole field. Take this cycle's
  # value if present, else reuse the last good one (up to CACHE_TTL). cpu/mem/net read
  # /proc directly and are collected fresh every cycle.
  disk_fresh=$(disk_json)
  disk_out=$(cache_pick "$disk_fresh" "$disk_cache" "$disk_cache_ts" "$now")
  [ -n "$disk_fresh" ] && { disk_cache=$disk_fresh; disk_cache_ts=$now; }

  vol_fresh=$(volumes_json)
  vol_out=$(cache_pick "$vol_fresh" "$vol_cache" "$vol_cache_ts" "$now")
  [ -n "$vol_fresh" ] && { vol_cache=$vol_fresh; vol_cache_ts=$now; }

  raid_fresh=$(raid_json)
  raid_out=$(cache_pick "$raid_fresh" "$raid_cache" "$raid_cache_ts" "$now")
  [ -n "$raid_fresh" ] && { raid_cache=$raid_fresh; raid_cache_ts=$now; }

  # extra (§4.4): join only the non-empty NAS-specific fragments
  extra=""
  [ -n "$vol_out" ] && extra="$vol_out"
  [ -n "$raid_out" ] && extra="$extra${extra:+,}$raid_out"

  # gpus is required by the protocol -> always [] on a NAS.
  payload=$(printf '{"v":1,"id":"%s","ts":%d,"os":"linux",%s%s%s%s%s"gpus":[],"extra":{%s}}' \
    "$AGENT_ID" "$now" \
    "$(uptime_json)" "$cpu_json" "$(mem_json)" "$disk_out" "$net_json" \
    "$extra")

  curl -sf -m 1 --noproxy '*' \
    -H "X-Push-Token: $PUSH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" "$URL" -o /dev/null 2>/dev/null || true
done
