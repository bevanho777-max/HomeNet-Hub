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
$claudeFrag = ""
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
  $loop++
  $extraJson = '{' + ((@($claudeFrag, $agentFrag, $hostFrag) | Where-Object { $_ }) -join ',') + '}'

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
