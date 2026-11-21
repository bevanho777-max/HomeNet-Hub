# homenet-agent.ps1 - HomeNet Hub push agent (Windows) - protocol v1, see docs/AGENT_PROTOCOL.md
# Target: Windows 11 / Server 2022 (zh-CN) / PowerShell 5.1. Save as UTF-8 with BOM (file is ASCII-only on purpose).
# Resident loop: host+GPU every ~2s; Claude window refreshed every ~30s (ccusage is slow), cached into extra.
# Deploy: Task Scheduler at startup, restart on failure.
# Trial mode: `homenet-agent.ps1 -Once` collects one interval, prints the payload and exits without
# pushing -- for checking the output before (re)starting the task; safe to run next to the live agent.
param([switch]$Once)

# ---------------- config ----------------
# Defaults only. Per-machine values go in agent.env.ps1 next to this script (dot-sourced, plain
# assignments such as $PushToken = "..."), so the deployed script stays byte-identical to the repo
# and extra.agent.sha256 matches HEAD. That file holds the token: keep its ACL to admins + SYSTEM.
$HubUrl    = "http://192.168.1.24:3100"
$AgentId   = "m110"
$PushToken = "REPLACE_WITH_PUSH_TOKEN"
$Interval  = 2
$StateFile = "C:\Users\mingc\claude-window.json"
$ClaudeRefreshLoops = 15
$NetIface  = ""         # pin the NIC by adapter name; empty = auto-detect default route
$NetRetryLoops = 15     # while no NIC is available, re-probe every N loops (~30s at 2s)
$ComfyEveryLoops = 5    # v2.41: re-read ComfyUI's processes / listening ports every N loops (~10s at 2s)
$LlmEveryLoops = 5      # v2.50: re-read the LLM servers' processes / listening ports every N loops (~10s at 2s)
$LlmProbeTtl = 60       # v2.50: re-confirm each LLM port's engine and model (local HTTP probes) at most this often (s)
$ComfyStopMarker = ""      # v2.43: ComfyUI's "stopped by hand" marker file; set on m136 only (empty = not reported)
$ComfyWatchdogStatus = ""  # v2.43: status file of the m136 ComfyUI watchdog (comfy-watchdog.ps1); m136 only
$DumpPayload = $false   # set $true to write each payload to last-payload.json for debugging

$EnvFile = Join-Path $PSScriptRoot "agent.env.ps1"
if (Test-Path -LiteralPath $EnvFile) { . $EnvFile }

# Self-reported version: sha256 of this file, sent as extra.agent so the hub can compare it with
# agents/homenet-agent.ps1 at HEAD (machine modal: "agent matches HEAD"). Computed once at start --
# replacing the script means restarting the task anyway.
$AgentSha = ""
if ($PSCommandPath) { $AgentSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash.ToLowerInvariant() }
$agentFrag = ""
if ($AgentSha) { $agentFrag = '"agent":{"file":"homenet-agent.ps1","sha256":"' + $AgentSha + '"}' }

# Host fingerprint (v2.31): sha256 of MachineGuid + the computer name, sent as extra.host. The hub
# binds the target to the first host it hears from and refuses pushes from any other; a reinstall
# makes a new MachineGuid, so the binding is then reset on the hub (REBUILD 8.5). Only the hash leaves.
$hostFrag = ""
$mguid = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid
if ($mguid) {
  $mid = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($mguid.Trim()))).Replace('-', '').ToLowerInvariant()
  $hn = $env:COMPUTERNAME -replace '[^A-Za-z0-9._-]', ''
  if ($hn.Length -gt 63) { $hn = $hn.Substring(0, 63) }
  $hostFrag = '"host":{"machine_id":"' + $mid + '","hostname":"' + $hn + '"}'
}

$ErrorActionPreference = "SilentlyContinue"
$Url = "$($HubUrl.TrimEnd('/'))/api/push/$AgentId"
$ci  = [System.Globalization.CultureInfo]::InvariantCulture

# LAN direct: disable system proxy (Clash etc.) for this session, same as curl --noproxy
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

function N1([double]$v) { $v.ToString("0.0", $ci) }
function N0([double]$v) { [math]::Round($v).ToString($ci) }

# ---------------- NIC discovery (startup + runtime self-heal) ----------------
# $NetIface pins the adapter and is never rewritten at runtime; empty means every probe
# re-reads the default route, so an agent started before the network is up recovers by
# itself instead of omitting net.* for the whole process lifetime.
$netPinned = -not [string]::IsNullOrWhiteSpace($NetIface)
$netName = $null
$prevRx = 0; $prevTx = 0
$netLog = $false        # stay quiet until the startup banner is printed

function Get-DefaultNetName {
  if ($script:netPinned) { return $NetIface }
  $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1
  if (-not $route) { return $null }
  $ad = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex
  if ($ad) { return $ad.Name }
  return $null
}

# (Re)establish the counter baseline. Sets $netName/$prevRx/$prevTx; logs one line
# whenever the adapter changes or drops out, so a runtime flip is never silent.
function Update-NetProbe {
  $old = $script:netName
  $cand = Get-DefaultNetName
  $script:netName = $null
  if ($cand) {
    $st = Get-NetAdapterStatistics -Name $cand
    if ($st) {
      $script:netName = $cand
      $script:prevRx = [int64]$st.ReceivedBytes
      $script:prevTx = [int64]$st.SentBytes
    }
  }
  if ($script:netLog -and $script:netName -ne $old) {
    $from = if ($old) { $old } else { "none" }
    $to   = if ($script:netName) { $script:netName } else { "none" }
    Write-Host "[homenet-agent] net: $from -> $to"
  }
}

Update-NetProbe
$netRetry = 0
$prevTs = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$hasNvidia  = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$hasCcusage = [bool](Get-Command ccusage -ErrorAction SilentlyContinue)

$banner = "[homenet-agent] id=$AgentId hub=$Url iface=$netName nvidia=$hasNvidia ccusage=$hasCcusage sha=$($AgentSha.Substring(0, [math]::Min(12, $AgentSha.Length)))"
if ($Once) { $banner += " once" }
Write-Host $banner
$netLog = $true         # from here on, log every NIC state change

# ---------------- collectors (return empty string on failure) ----------------
function Get-CpuJson {
  $c = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
  if ($null -eq $c) { return "" }
  if ($c -lt 0) { $c = 0 }; if ($c -gt 100) { $c = 100 }
  return ('"cpu":{{"pct":{0}}},' -f (N1 $c))
}

function Get-MemJson {
  $os = Get-CimInstance Win32_OperatingSystem
  if (-not $os) { return "" }
  $totalGb = $os.TotalVisibleMemorySize / 1MB
  $usedGb  = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB
  return ('"mem":{{"used_gb":{0},"total_gb":{1}}},' -f (N1 $usedGb), (N1 $totalGb))
}

function Get-DiskJson {
  $d = Get-PSDrive C
  if (-not $d -or ($d.Used + $d.Free) -le 0) { return "" }
  return ('"disk":{{"used_gb":{0},"total_gb":{1}}},' -f (N0 ($d.Used/1GB)), (N0 (($d.Used+$d.Free)/1GB)))
}

function Get-UptimeJson {
  $os = Get-CimInstance Win32_OperatingSystem
  if (-not $os) { return "" }
  $s = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
  return ('"uptime_s":{0},' -f $s)
}

# A nvidia-smi reading as a number; $null for "[N/A]", "[Unknown Error]", "" and the like.
function Get-Num([string]$s) {
  $n = 0.0
  if ($s -and [double]::TryParse($s.Trim(), [System.Globalization.NumberStyles]::Float, $ci, [ref]$n)) { return $n }
  return $null
}

# v2.36: a reading that is not a plausible value is left out (the card shows "-"), never sent raw.
# m133's RTX 4070 Laptop (driver 617.14, power.max_limit 105 W) answered power.draw = 588 / 590 W in
# 2990 of its idle samples 10-29 .. 11-02, a single sample at a time, and temperature.gpu = 0 while
# the dGPU was going to sleep (11-02 04:09). power.max_limit is sent as power_cap_w, so the hub's own
# check (power_w > 1.5x power_cap_w -> sample dropped, docs/AGENT_PROTOCOL.md) applies here too; the
# agent asks once more before giving up on a reading above it.
function Get-GpusJson {
  if (-not $script:hasNvidia) { return '"gpus":[]' }
  $rows = nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.max_limit --format=csv,noheader,nounits 2>$null
  if (-not $rows) { return '"gpus":[]' }
  $frags = @()
  foreach ($r in @($rows)) {
    $f = $r -split ',\s*'
    if ($f.Count -lt 8) { continue }
    $idx = Get-Num $f[0]
    if ($null -eq $idx) { continue }     # an error line, not a GPU row
    $g = ('{{"idx":{0},"name":"{1}"' -f (N0 $idx), ($f[1].Trim() -replace '["\\]', ''))
    $used = Get-Num $f[3]; $total = Get-Num $f[4]
    if ($null -ne $used -and $total -gt 0 -and $used -ge 0 -and $used -le $total) {
      $g += (',"vram_used_gb":{0},"vram_total_gb":{1}' -f (N1 ($used / 1024)), (N1 ($total / 1024)))
    }
    $util = Get-Num $f[2]
    if ($null -ne $util -and $util -ge 0 -and $util -le 100) { $g += (',"util_pct":{0}' -f (N0 $util)) }
    # Drivers 6xx report temperature.gpu with decimals (37.97); the protocol's temp_c is an integer.
    $temp = Get-Num $f[5]
    if ($temp -gt 0 -and $temp -lt 130) { $g += (',"temp_c":{0}' -f (N0 $temp)) }
    $cap = Get-Num $f[7]
    $pw = Get-Num $f[6]
    if ($cap -gt 0 -and $pw -gt 1.5 * $cap) {
      $pw = Get-Num (nvidia-smi -i (N0 $idx) --query-gpu=power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
      if ($pw -gt 1.5 * $cap) { $pw = $null }
    }
    if ($null -ne $pw -and $pw -ge 0) { $g += (',"power_w":{0}' -f (N0 $pw)) }
    if ($cap -gt 0) { $g += (',"power_cap_w":{0}' -f (N0 $cap)) }
    $frags += ($g + '}')
  }
  return ('"gpus":[{0}]' -f ($frags -join ','))
}

# v2.41 ComfyUI on this machine, as the "comfyui":{...} member of extra -- always sent (procs 0 when none),
# so the hub can tell "the agent looked and ComfyUI is not running" (grey since v2.43) from an older agent that does
# not look at all. A ComfyUI server = a python process running ComfyUI's main.py (portable, a venv, or
# the desktop app's bundled copy: ...\ComfyUI\main.py). listen = the TCP ports those processes actually
# listen on (Get-NetTCPConnection), so the hub probes the port in use -- 8188 portable, 8000 desktop,
# whatever --port says -- and says Unreachable (yellow) while a ComfyUI process runs but does
# not answer: m136 11-03 17:02, asyncio's accept loop died on WinError 64 and closed the 8188 listener
# while the process kept running. cmd_port = --port from the command line; pid / since = the oldest one.
# v2.43 (m136, files named in agent.env.ps1): manual_stop = the "stopped by hand" marker exists (the desktop stop
# writes it, the desktop start removes it) -> the hub shows grey "stopped by hand"; watchdog = the status the ComfyUI
# watchdog writes every minute (state ok / no-process / manual-stop / stuck / restarted / gave-up, restarts in the last
# hour, age_s since it wrote it) -> red "auto-repair failed" while it has given up. Returns ',"manual_stop":..' or ''.
function Get-ComfyWatch {
  $parts = @()
  if ($ComfyStopMarker) { $parts += ('"manual_stop":' + $(if (Test-Path -LiteralPath $ComfyStopMarker) { 'true' } else { 'false' })) }
  if ($ComfyWatchdogStatus -and (Test-Path -LiteralPath $ComfyWatchdogStatus)) {
    try {
      $w = Get-Content -LiteralPath $ComfyWatchdogStatus -Raw | ConvertFrom-Json
      $age = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$w.updated)
      $wd = '"state":"{0}","age_s":{1},"restarts_1h":{2}' -f (([string]$w.state) -replace '[^a-z-]', ''), $age, [int]$w.restarts_1h
      if ($w.last_restart) { $wd += ',"last_restart":' + [int64]$w.last_restart }
      if ($w.gave_up_at) { $wd += ',"gave_up_at":' + [int64]$w.gave_up_at }
      $reason = ([string]$w.reason) -replace '[^a-z-]', ''
      if ($reason) { $wd += ',"reason":"' + $reason + '"' }
      $parts += ('"watchdog":{' + $wd + '}')
    } catch { }
  }
  if ($parts.Count) { return (',' + ($parts -join ',')) }
  return ''
}

function Get-ComfyExtra {
  $watch = Get-ComfyWatch
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -match '(?i)[\\/]ComfyUI[\\/]main\.py' } | Sort-Object CreationDate)
  if (-not $procs.Count) { return ('"comfyui":{"procs":0,"listen":[]' + $watch + '}') }
  $seen = @{}; $list = @(); $cmdPort = 0
  foreach ($p in $procs) {
    if (-not $cmdPort -and $p.CommandLine -match '--port[= ]+"?(\d{2,5})') { $cmdPort = [int]$matches[1] }
    foreach ($l in @(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue)) {
      $addr = ([string]$l.LocalAddress) -replace '[^0-9A-Fa-f:.]', ''
      $key = "$addr|$($l.LocalPort)"
      if ($seen[$key] -or $list.Count -ge 6) { continue }
      $seen[$key] = $true
      $list += ('{{"port":{0},"addr":"{1}"}}' -f [int]$l.LocalPort, $addr)
    }
  }
  $first = $procs[0]
  $since = [DateTimeOffset]::new($first.CreationDate.ToUniversalTime()).ToUnixTimeSeconds()
  $tail = ''
  if ($cmdPort) { $tail = ',"cmd_port":' + $cmdPort }
  return ('"comfyui":{{"procs":{0},"listen":[{1}],"pid":{2},"since":{3}{4}{5}}}' -f $procs.Count, ($list -join ','), [int]$first.ProcessId, $since, $tail, $watch)
}

# ---------------- v2.50 LLM servers on this machine ----------------
# m110 / m136 take turns running ComfyUI or an LLM (one at a time); the hub tells which from what runs. This reports
# the LLM side as the "llm":{...} member of extra, always (procs 0 when none), like comfyui. DETECTION ONLY: nothing
# here starts, stops or changes any server (m110 starts nothing by itself).
# A server = a process of a known engine: llama.cpp (llama-server*.exe), LM Studio (LM Studio.exe / lms.exe /
# llmster.exe), Ollama (ollama.exe; its model runners are not counted), Strata (python -m serve.server). Each TCP
# port such a process listens on is confirmed by asking it over loopback (or the one address it binds):
#   /v1/status (Strata), /props + /slots + /metrics (llama.cpp), /api/version + /api/ps (Ollama),
#   /api/v0/models (LM Studio), /health, /v1/models (any OpenAI-compatible server: the model ID).
# A port's answer is kept $LlmProbeTtl seconds; only the busy count of the server reported is read every time.
# Fields: procs, engine (llamacpp|strata|ollama|lmstudio|openai), name (process), pid, since (process start, unix s;
# Ollama: its newest model runner), listen [{port, addr}] (the server process' ports), api_port (the one that
# answered as the API), confirmed (an endpoint said which engine it is, not only the process name), via (which),
# auth (it wants a key), model, slots, metrics (llama.cpp /metrics on: Prometheus has counters), busy (requests in
# flight, -1 = not known), others (more servers than the one reported).
$script:llmCache = @{}

function Get-Http([string]$url, [int]$timeoutMs = 700, [int]$maxChars = 65536) {
  $resp = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs
    $req.Proxy = $null; $req.AllowAutoRedirect = $false
    $req.Accept = 'application/json, text/plain, */*'
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ code = 0; body = '' } }
  } catch { return @{ code = 0; body = '' } }
  try {
    $code = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $buf = New-Object char[] $maxChars
    $n = $sr.ReadBlock($buf, 0, $maxChars)
    return @{ code = $code; body = [string]::new($buf, 0, $n) }
  } catch { return @{ code = [int]$resp.StatusCode; body = '' } } finally { $resp.Close() }
}

# (`return ,$v`: PowerShell would unroll a one-element array -- /slots of a one-slot llama.cpp -- into its element)
function ConvertFrom-JsonOrNull([string]$s) {
  if (-not $s) { return $null }
  try { $v = $s | ConvertFrom-Json; return ,$v } catch { return $null }
}

# a model ID as plain ASCII: a path's leaf, no quotes or backslashes, at most 96 characters
function Get-ModelText($m) {
  $s = [string]$m
  if ($s -match '[\\/]') { $s = ($s -split '[\\/]')[-1] }
  $s = $s -replace '[^A-Za-z0-9._:@+\-]', ''
  if ($s.Length -gt 96) { $s = $s.Substring(0, 96) }
  return $s
}

# What answers on one port of a process of engine kind $hint: @{ engine; via; auth; model; slots; metrics; busy }
function Test-LlmPort([string]$addr, [int]$port, [string]$hint) {
  $b = "http://${addr}:$port"
  $r = @{ engine = ''; via = ''; auth = $false; model = ''; slots = 0; metrics = $false; busy = -1; answered = $false }
  $mark = { param($h) if ($h.code -gt 0) { $r.answered = $true }; if ($h.code -eq 401 -or $h.code -eq 403) { $r.auth = $true } }
  if ($hint -eq 'strata' -or $hint -eq '') {
    $h = Get-Http "$b/v1/status"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    if ($h.code -eq 200 -and $j -and ($j.concurrency -or $j.activity)) {
      $r.engine = 'strata'; $r.via = '/v1/status'
      if ($null -ne $j.activity.in_flight) { $r.busy = [int]$j.activity.in_flight }
      if ($j.concurrency.serving) { $r.slots = [int]$j.concurrency.serving }
    }
    if ($hint -eq 'strata' -and -not $r.model) {
      $h = Get-Http "$b/health"; & $mark $h
      $j = ConvertFrom-JsonOrNull $h.body
      if ($j -and $j.model) { $r.model = Get-ModelText $j.model; if (-not $r.engine) { $r.engine = 'strata'; $r.via = '/health' } }
    }
  }
  if (-not $r.engine -and ($hint -eq 'llamacpp' -or $hint -eq '')) {
    $h = Get-Http "$b/props"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    if ($h.code -eq 200 -and $j -and ($null -ne $j.total_slots -or $j.default_generation_settings)) {
      $r.engine = 'llamacpp'; $r.via = '/props'
      if ($j.total_slots) { $r.slots = [int]$j.total_slots }
      if ($j.model_alias) { $r.model = Get-ModelText $j.model_alias } elseif ($j.model_path) { $r.model = Get-ModelText $j.model_path }
    }
    $h = Get-Http "$b/slots"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    if ($h.code -eq 200 -and $h.body -match '^\s*\[') {
      if (-not $r.engine) { $r.engine = 'llamacpp'; $r.via = '/slots' }
      $r.slots = @($j | Where-Object { $_ }).Count
      $r.busy = @($j | Where-Object { $_.is_processing }).Count
    }
    if ($r.engine -eq 'llamacpp' -or $hint -eq 'llamacpp') {
      $h = Get-Http "$b/metrics" 700 4096; & $mark $h
      if ($h.code -eq 200 -and $h.body -match 'llamacpp:') { $r.metrics = $true; if (-not $r.engine) { $r.engine = 'llamacpp'; $r.via = '/metrics' } }
    }
  }
  if (-not $r.engine -and ($hint -eq 'ollama' -or $hint -eq '')) {
    $h = Get-Http "$b/api/version"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    if ($h.code -eq 200 -and $j -and $j.version) {
      $r.engine = 'ollama'; $r.via = '/api/version'
      $ps = ConvertFrom-JsonOrNull (Get-Http "$b/api/ps").body
      $m = @($ps.models)
      if ($m.Count -and $m[0].name) { $r.model = Get-ModelText $m[0].name }
    }
  }
  if (-not $r.engine -and ($hint -eq 'lmstudio' -or $hint -eq '')) {
    $h = Get-Http "$b/api/v0/models"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    if ($h.code -eq 200 -and $j -and $null -ne $j.data) {
      $r.engine = 'lmstudio'; $r.via = '/api/v0/models'
      $ld = @($j.data | Where-Object { $_.state -eq 'loaded' -and $_.type -ne 'embeddings' })
      if ($ld.Count) { $r.model = Get-ModelText $ld[0].id }
    }
  }
  if (-not $r.model -and ($r.engine -or $hint -or $r.answered)) {
    $h = Get-Http "$b/v1/models"; & $mark $h
    $j = ConvertFrom-JsonOrNull $h.body
    $d = @($j.data)
    if ($h.code -eq 200 -and $d.Count -and $d[0].id) {
      $r.model = Get-ModelText $d[0].id
      if (-not $r.engine) { $r.engine = 'openai'; $r.via = '/v1/models' }
    }
  }
  if (-not $r.engine -and $hint -eq 'llamacpp') {
    $h = Get-Http "$b/health"; & $mark $h
    if ($h.code -eq 200 -or $h.code -eq 503) { $r.engine = 'llamacpp'; $r.via = '/health' }
  }
  return $r
}

function Get-LlmExtra {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $procs = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'llama-server%' OR Name='LM Studio.exe' OR Name='lms.exe' OR Name='llmster.exe' OR Name='ollama.exe' OR Name='python.exe' OR Name='pythonw.exe'")
  $cands = @(); $runners = @()
  foreach ($p in $procs) {
    $n = [string]$p.Name; $cl = [string]$p.CommandLine; $kind = ''
    if ($n -like 'llama-server*') { $kind = 'llamacpp' }
    elseif ($n -eq 'ollama.exe') { if ($cl -match '(?i)\srunner(\s|$)') { $runners += $p } else { $kind = 'ollama' } }
    elseif ($n -eq 'LM Studio.exe' -or $n -eq 'lms.exe' -or $n -eq 'llmster.exe') { $kind = 'lmstudio' }
    elseif ($cl -match '(?i)(-m\s+serve\.server|serve[\\/]server\.py)') { $kind = 'strata' }
    if ($kind) { $cands += [pscustomobject]@{ p = $p; kind = $kind } }
  }
  if (-not $cands.Count) { $script:llmCache = @{}; return '"llm":{"procs":0,"listen":[]}' }
  $byPid = @{}
  foreach ($l in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $k = [string]$l.OwningProcess
    if (-not $byPid[$k]) { $byPid[$k] = @() }
    $byPid[$k] += $l
  }
  $servers = @(); $keep = @{}
  foreach ($c in $cands) {
    $ls = @($byPid[[string]$c.p.ProcessId]); $seen = @{}; $list = @()
    foreach ($l in $ls) {
      if (-not $l) { continue }
      $a = ([string]$l.LocalAddress) -replace '[^0-9A-Fa-f:.]', ''
      $key = "$a|$($l.LocalPort)"
      if ($seen[$key] -or $list.Count -ge 6) { continue }
      $seen[$key] = $true
      $list += [pscustomobject]@{ port = [int]$l.LocalPort; addr = $a }
    }
    # LM Studio's helper processes (renderer, GPU ...) listen nowhere: not servers
    if ($c.kind -eq 'lmstudio' -and -not $list.Count) { continue }
    $best = $null; $tried = 0; $done = @{}
    foreach ($e in ($list | Sort-Object port)) {
      if ($tried -ge 4) { break }
      if ($done[[string]$e.port]) { continue }
      $done[[string]$e.port] = $true
      # wildcard binds are asked on loopback; a single-address bind on that address
      $addr = ''
      if ($e.addr -eq '0.0.0.0' -or $e.addr -eq '::' -or $e.addr -eq '') { $addr = '127.0.0.1' }
      elseif ($e.addr -match '^[0-9.]+$') { $addr = $e.addr }
      elseif ($e.addr -eq '::1') { $addr = '[::1]' }
      if (-not $addr) { continue }
      $ck = "$($c.p.ProcessId)|$($e.port)"
      $hit = $script:llmCache[$ck]
      if ($hit -and ($now - $hit.at) -lt $LlmProbeTtl) { $res = $hit.res } else { $res = Test-LlmPort $addr $e.port $c.kind; $tried++ }
      $keep[$ck] = @{ at = $(if ($hit -and ($now - $hit.at) -lt $LlmProbeTtl) { $hit.at } else { $now }); res = $res; addr = $addr }
      if ($res.engine -and -not $best) { $best = @{ port = $e.port; res = $res; addr = $addr } }
    }
    if ($c.kind -eq 'lmstudio' -and -not $best) { continue }
    $since = [DateTimeOffset]::new($c.p.CreationDate.ToUniversalTime()).ToUnixTimeSeconds()
    if ($c.kind -eq 'ollama' -and $runners.Count) {
      $nr = ($runners | Sort-Object CreationDate | Select-Object -Last 1)
      $since = [DateTimeOffset]::new($nr.CreationDate.ToUniversalTime()).ToUnixTimeSeconds()
    }
    $servers += [pscustomobject]@{ c = $c; list = $list; best = $best; since = $since }
  }
  $script:llmCache = $keep
  if (-not $servers.Count) { return '"llm":{"procs":0,"listen":[]}' }
  # the one reported: a confirmed one before an unconfirmed, busy before idle, a model loaded, then the newest
  $rank = { param($s) $v = 0; if ($s.best) { $v += 8; if ($s.best.res.busy -gt 0) { $v += 4 }; if ($s.best.res.model) { $v += 2 } }; $v }
  $pick = $servers | Sort-Object @{ Expression = { & $rank $_ }; Descending = $true }, @{ Expression = { $_.since }; Descending = $true } | Select-Object -First 1
  $engine = $pick.c.kind; $res = $null; $apiPort = 0
  if ($pick.best) {
    $res = $pick.best.res; $apiPort = $pick.best.port; $engine = $res.engine
    # the busy count is read every time (the rest of the port's answer is kept $LlmProbeTtl s)
    $bb = "http://$($pick.best.addr):$apiPort"
    if ($engine -eq 'llamacpp') {
      $h = Get-Http "$bb/slots"
      $j = ConvertFrom-JsonOrNull $h.body
      if ($h.code -eq 200 -and $h.body -match '^\s*\[') { $res.busy = @($j | Where-Object { $_.is_processing }).Count }
    } elseif ($engine -eq 'strata') {
      $j = ConvertFrom-JsonOrNull (Get-Http "$bb/v1/status").body
      if ($j -and $null -ne $j.activity.in_flight) { $res.busy = [int]$j.activity.in_flight }
    }
  }
  $lj = ($pick.list | ForEach-Object { '{{"port":{0},"addr":"{1}"}}' -f $_.port, $_.addr }) -join ','
  $nm = ([string]$pick.c.p.Name) -replace '[^A-Za-z0-9 ._-]', ''
  $out = '"llm":{{"procs":{0},"engine":"{1}","name":"{2}","pid":{3},"since":{4},"listen":[{5}]' -f $servers.Count, $engine, $nm, [int]$pick.c.p.ProcessId, $pick.since, $lj
  if ($res) {
    $out += ',"api_port":{0},"confirmed":true,"via":"{1}","auth":{2},"slots":{3},"metrics":{4},"busy":{5}' -f $apiPort, $res.via, $(if ($res.auth) { 'true' } else { 'false' }), [int]$res.slots, $(if ($res.metrics) { 'true' } else { 'false' }), [int]$res.busy
    if ($res.model) { $out += ',"model":"' + $res.model + '"' }
  } else { $out += ',"confirmed":false,"busy":-1' }
  if ($servers.Count -gt 1) { $out += ',"others":' + ($servers.Count - 1) }
  return ($out + '}')
}

# Claude Max window: same self-recorded start algorithm as claude-report.ps1
# (blockId change -> record now as new start, +5h = reset). Shares the same state file.
# Returns the "claude":{...} member of extra, or "" when ccusage is not installed.
function Get-ClaudeExtra {
  if (-not $script:hasCcusage) { return "" }
  $json = ccusage blocks --active --json 2>$null | ConvertFrom-Json
  $b = $json.blocks | Where-Object { $_.isActive } | Select-Object -First 1
  if (-not $b) { return '"claude":{"active":false}' }
  $blockId = $b.id
  $nowUtc = (Get-Date).ToUniversalTime()
  $state = $null
  if (Test-Path $StateFile) { $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
  if ($null -eq $state -or $state.blockId -ne $blockId) {
    $startReal = $nowUtc
    @{ blockId = $blockId; startUtc = $startReal.ToString("o") } |
      ConvertTo-Json -Compress | Set-Content $StateFile -Encoding UTF8
  } else {
    $startReal = [datetime]::Parse($state.startUtc).ToUniversalTime()
  }
  $remaining = [int][math]::Round(($startReal.AddHours(5) - $nowUtc).TotalMinutes)
  if ($remaining -lt 0) { $remaining = 0 }
  return ('"claude":{{"active":true,"remaining_min":{0},"block_id":"{1}","total_tokens":{2},"cost_usd":{3}}}' -f `
    $remaining, $blockId, [int64]$b.totalTokens, ([math]::Round([double]$b.costUSD,2).ToString($ci)))
}

# ---------------- main loop ----------------
if (-not $ClaudeRefreshLoops -or $ClaudeRefreshLoops -lt 1) { $ClaudeRefreshLoops = 15 }
if (-not $ComfyEveryLoops -or $ComfyEveryLoops -lt 1) { $ComfyEveryLoops = 5 }
if (-not $LlmEveryLoops -or $LlmEveryLoops -lt 1) { $LlmEveryLoops = 5 }
if (-not $LlmProbeTtl -or $LlmProbeTtl -lt 10) { $LlmProbeTtl = 60 }
# (the LLM read two loops after the ComfyUI one, so the two slower reads never share a loop; -Once: both at once)
$llmPhase = if ($Once) { 0 } else { 2 % $LlmEveryLoops }
$claudeFrag = ""
$comfyFrag = ""
$llmFrag = ""
$loop = 0
while ($true) {
  Start-Sleep -Seconds $Interval
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $elapsed = $now - $prevTs; if ($elapsed -lt 1) { $elapsed = 1 }

  # Re-probe in place when the counters vanish; retry on a slow tick while no NIC is up.
  $netJson = ""
  if ($netName) {
    $st = Get-NetAdapterStatistics -Name $netName
    if ($st) {
      $rx = [int64]$st.ReceivedBytes; $tx = [int64]$st.SentBytes
      $rbps = [int64](($rx - $prevRx) / $elapsed); if ($rbps -lt 0) { $rbps = 0 }
      $tbps = [int64](($tx - $prevTx) / $elapsed); if ($tbps -lt 0) { $tbps = 0 }
      $netJson = ('"net":{{"rx_bps":{0},"tx_bps":{1}}},' -f $rbps, $tbps)
      $prevRx = $rx; $prevTx = $tx
    } else {
      Update-NetProbe        # adapter gone / unreadable -> re-probe now
    }
  } else {
    $netRetry++
    if ($netRetry -ge $NetRetryLoops) {
      $netRetry = 0
      Update-NetProbe        # this loop only rebuilds the baseline
    }
  }
  $prevTs = $now

  if ($loop % $ClaudeRefreshLoops -eq 0) { $claudeFrag = Get-ClaudeExtra }
  if ($loop % $ComfyEveryLoops -eq 0) { $comfyFrag = Get-ComfyExtra }
  if ($loop % $LlmEveryLoops -eq $llmPhase) { $llmFrag = Get-LlmExtra }
  $loop++
  $extraJson = '{' + ((@($claudeFrag, $agentFrag, $hostFrag, $comfyFrag, $llmFrag) | Where-Object { $_ }) -join ',') + '}'

  $payload = ('{{"v":1,"id":"{0}","ts":{1},"os":"windows",{2}{3}{4}{5}{6}{7},"extra":{8}}}' -f `
    $AgentId, $now, (Get-UptimeJson), (Get-CpuJson), (Get-MemJson), (Get-DiskJson), $netJson, (Get-GpusJson), $extraJson)

  if ($Once) { Write-Output $payload; exit 0 }
  if ($DumpPayload) { Set-Content -Path "C:\homenet-agent\last-payload.json" -Value $payload -Encoding UTF8 }

  try {
    Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 1 `
      -Headers @{ "X-Push-Token" = $PushToken } `
      -ContentType "application/json; charset=utf-8" -Body $payload | Out-Null
  } catch { }
}
