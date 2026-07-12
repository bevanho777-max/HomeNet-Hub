# homenet-agent.ps1 - HomeNet Hub push agent (Windows) - protocol v1, see docs/AGENT_PROTOCOL.md
# Target: Windows Server 2022 (zh-CN) / PowerShell 5.1. Save as UTF-8 with BOM (file is ASCII-only on purpose).
# Resident loop: host+GPU every ~2s; Claude window refreshed every ~30s (ccusage is slow), cached into extra.
# Deploy: Task Scheduler at startup, restart on failure.

# ---------------- config ----------------
$HubUrl    = "http://192.168.1.24:3100"
$AgentId   = "m110"
$PushToken = "REPLACE_WITH_PUSH_TOKEN"
$Interval  = 2
$StateFile = "C:\Users\mingc\claude-window.json"
$ClaudeRefreshLoops = 15
$DumpPayload = $false   # set $true to write each payload to last-payload.json for debugging

$ErrorActionPreference = "SilentlyContinue"
$Url = "$($HubUrl.TrimEnd('/'))/api/push/$AgentId"
$ci  = [System.Globalization.CultureInfo]::InvariantCulture

# LAN direct: disable system proxy (Clash etc.) for this session, same as curl --noproxy
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

function N1([double]$v) { $v.ToString("0.0", $ci) }
function N0([double]$v) { [math]::Round($v).ToString($ci) }

# ---------------- startup probes ----------------
$netName = $null
$route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1
if ($route) {
  $ad = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex
  if ($ad) { $netName = $ad.Name }
}
$prevRx = 0; $prevTx = 0
if ($netName) {
  $st = Get-NetAdapterStatistics -Name $netName
  if ($st) { $prevRx = [int64]$st.ReceivedBytes; $prevTx = [int64]$st.SentBytes }
}
$prevTs = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$hasNvidia  = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$hasCcusage = [bool](Get-Command ccusage -ErrorAction SilentlyContinue)

Write-Host "[homenet-agent] id=$AgentId hub=$Url iface=$netName nvidia=$hasNvidia ccusage=$hasCcusage"

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

function Get-GpusJson {
  if (-not $script:hasNvidia) { return '"gpus":[]' }
  $rows = nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
  if (-not $rows) { return '"gpus":[]' }
  $frags = @()
  foreach ($r in @($rows)) {
    $f = $r -split ',\s*'
    if ($f.Count -lt 7) { continue }
    $g = ('{{"idx":{0},"name":"{1}","util_pct":{2},"vram_used_gb":{3},"vram_total_gb":{4},"temp_c":{5}' -f `
      $f[0].Trim(), $f[1].Trim(), $f[2].Trim(), (N1 ([double]$f[3]/1024)), (N1 ([double]$f[4]/1024)), $f[5].Trim())
    $pw = 0.0
    if ([double]::TryParse($f[6].Trim(), [System.Globalization.NumberStyles]::Float, $ci, [ref]$pw)) {
      $g += (',"power_w":{0}' -f (N0 $pw))
    }
    $frags += ($g + '}')
  }
  return ('"gpus":[{0}]' -f ($frags -join ','))
}

# Claude Max window: same self-recorded start algorithm as claude-report.ps1
# (blockId change -> record now as new start, +5h = reset). Shares the same state file.
function Get-ClaudeExtra {
  if (-not $script:hasCcusage) { return "{}" }
  $json = ccusage blocks --active --json 2>$null | ConvertFrom-Json
  $b = $json.blocks | Where-Object { $_.isActive } | Select-Object -First 1
  if (-not $b) { return '{"claude":{"active":false}}' }
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
  return ('{{"claude":{{"active":true,"remaining_min":{0},"block_id":"{1}","total_tokens":{2},"cost_usd":{3}}}}}' -f `
    $remaining, $blockId, [int64]$b.totalTokens, ([math]::Round([double]$b.costUSD,2).ToString($ci)))
}

# ---------------- main loop ----------------
if (-not $ClaudeRefreshLoops -or $ClaudeRefreshLoops -lt 1) { $ClaudeRefreshLoops = 15 }
$extraJson = "{}"
$loop = 0
while ($true) {
  Start-Sleep -Seconds $Interval
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $elapsed = $now - $prevTs; if ($elapsed -lt 1) { $elapsed = 1 }

  $netJson = ""
  if ($netName) {
    $st = Get-NetAdapterStatistics -Name $netName
    if ($st) {
      $rx = [int64]$st.ReceivedBytes; $tx = [int64]$st.SentBytes
      $rbps = [int64](($rx - $prevRx) / $elapsed); if ($rbps -lt 0) { $rbps = 0 }
      $tbps = [int64](($tx - $prevTx) / $elapsed); if ($tbps -lt 0) { $tbps = 0 }
      $netJson = ('"net":{{"rx_bps":{0},"tx_bps":{1}}},' -f $rbps, $tbps)
      $prevRx = $rx; $prevTx = $tx
    }
  }
  $prevTs = $now

  if ($loop % $ClaudeRefreshLoops -eq 0) { $extraJson = Get-ClaudeExtra }
  $loop++

  $payload = ('{{"v":1,"id":"{0}","ts":{1},"os":"windows",{2}{3}{4}{5}{6}{7},"extra":{8}}}' -f `
    $AgentId, $now, (Get-UptimeJson), (Get-CpuJson), (Get-MemJson), (Get-DiskJson), $netJson, (Get-GpusJson), $extraJson)

  if ($DumpPayload) { Set-Content -Path "C:\homenet-agent\last-payload.json" -Value $payload -Encoding UTF8 }

  try {
    Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 1 `
      -Headers @{ "X-Push-Token" = $PushToken } `
      -ContentType "application/json; charset=utf-8" -Body $payload | Out-Null
  } catch { }
}
