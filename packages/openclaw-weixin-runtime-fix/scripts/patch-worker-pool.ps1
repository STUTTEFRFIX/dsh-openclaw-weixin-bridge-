# ============================================================================
#  openclaw-weixin-runtime-fix —— worker-task-pool 克隆失败修复（apply / revert）
# ============================================================================
#  症状
#    微信通道「消息收得到、回复发不出去」：宿主 dist/worker-task-pool-*.mjs 用
#    worker.postMessage(payload, transferList) 派发任务，载荷里 input.request.env 是
#    进程环境对象（Node 下不可克隆）→ 结构化克隆抛 DataCloneError →
#      - dispatchReplyFromConfig 失败，回复永远发不出去；
#      - getUpdates 长轮询被同一次失败打断。
#
#  本脚本做什么
#    apply ：备份原文件 → 用 lib/gen-patch.mjs 生成补丁候选（只认结构指纹，找不到就
#            拒绝生成）→ **语法门禁**（node --input-type=module --check）+ 结构门禁
#            全部通过后才覆盖目标文件 → 可选重启 Gateway。
#    revert：从 <目标>.orig-bak 还原（还原前同样过语法门禁）。
#    status：只读列出所有候选副本、是否已打补丁、备份是否存在。
#
#  安全设计
#    - 任何校验不通过都**不落盘**，目标文件保持字节不变；
#    - 备份文件被污染（含补丁标记）时拒绝继续；
#    - 默认**不重启** Gateway：加 -RestartGateway 才重启；
#    - -DryRun 只生成与校验，不覆盖目标文件。
#
#  用法
#    pwsh -File scripts/patch-worker-pool.ps1 -Action status
#    pwsh -File scripts/patch-worker-pool.ps1 -Action apply -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"
#    pwsh -File scripts/patch-worker-pool.ps1 -Action apply -DryRun
#    pwsh -File scripts/patch-worker-pool.ps1 -Action revert
#
#  代价与边界（务必知悉）
#    - 改的是全局 OpenClaw 发行包内文件，属**非受支持**改法；
#    - openclaw 每次升级都会覆盖该文件，升级后需要重新 apply；
#    - 修复后每次派发仍会先在日志留下一次 DataCloneError（补丁随即救援成功），属诊断噪声；
#    - 只有 Gateway 实际运行的那一份副本才需要修，多份副本并存时必须用 -DistPath 指定。
# ============================================================================

[CmdletBinding()]
param(
  [ValidateSet('status', 'apply', 'revert')]
  [string]$Action = 'status',
  [string]$DistPath = '',
  [switch]$DryRun,
  [switch]$RestartGateway
)

$ErrorActionPreference = 'Stop'

$PkgRoot = Split-Path $PSScriptRoot -Parent
$GenPatch = Join-Path $PkgRoot 'lib/gen-patch.mjs'
$TargetsScript = Join-Path $PkgRoot 'lib/targets.mjs'
$InjectionSentinel = '// [openclaw-weixin-runtime-fix] clone-retry injection point'
$PatchMarker = 'FIX-CLONE'

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Write-Info { param([string]$Message) Write-Host "  [INFO] $Message" }

function Resolve-Node {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh-win\node\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw '找不到 node 可执行文件；请把 node 加入 PATH 或设置 DSH_WIN_HOME。'
}

$Node = Resolve-Node

function Invoke-NodeJson {
  param([string]$Script, [string[]]$Arguments = @())
  $raw = & $Node $Script @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "node $Script 失败（退出码 $LASTEXITCODE）：`n$raw" }
  if ([string]::IsNullOrWhiteSpace($raw)) { return }
  $parsed = @($raw | ConvertFrom-Json)
  return @($parsed | Where-Object { $null -ne $_ })
}

function Get-TargetList {
  if ($DistPath -ne '') {
    if (-not (Test-Path $DistPath)) { throw "指定的 -DistPath 不存在：$DistPath" }
    $item = Get-Item $DistPath
    if ($item.PSIsContainer) {
      $files = @(Get-ChildItem -Path $item.FullName -Filter 'worker-task-pool-*.mjs' -File -ErrorAction SilentlyContinue)
      if ($files.Count -eq 0) { throw "目录里没有 worker-task-pool-*.mjs：$($item.FullName)" }
      return @($files | ForEach-Object { New-TargetRecord $_.FullName })
    }
    return @(New-TargetRecord $item.FullName)
  }
  return @(Invoke-NodeJson -Script $TargetsScript -Arguments @('--json'))
}

function New-TargetRecord {
  param([string]$Path)
  $full = (Resolve-Path -LiteralPath $Path).Path
  $content = Get-Content -LiteralPath $full -Raw
  $backup = "$full.orig-bak"
  return [pscustomobject]@{
    path          = $full
    distDir       = (Split-Path $full -Parent)
    bytes         = (Get-Item -LiteralPath $full).Length
    patched       = $content -match $PatchMarker
    backupPath    = $backup
    backupExists  = (Test-Path -LiteralPath $backup)
    openclawVersion = $null
  }
}

function Select-Target {
  param([object[]]$Targets, [switch]$PreferBackup)
  $Targets = @($Targets | Where-Object { $null -ne $_ })
  if ($Targets.Count -eq 0) {
    throw '未发现任何 worker-task-pool-*.mjs；请用 -DistPath 指定 Gateway 实际使用的那一份。'
  }
  if ($Targets.Count -eq 1) { return $Targets[0] }
  $filtered = @($Targets | Where-Object { if ($PreferBackup) { $_.backupExists } else { -not $_.patched } })
  if ($filtered.Count -eq 1) { return $filtered[0] }
  $lines = ($Targets | ForEach-Object { "    $($_.path)  patched=$($_.patched) backup=$($_.backupExists)" }) -join "`n"
  throw "发现多份候选副本，无法自动判定 Gateway 使用哪一份，请用 -DistPath 显式指定：`n$lines"
}

function Test-SyntaxGate {
  param([string]$FilePath)
  $raw = Get-Content -LiteralPath $FilePath -Raw
  $output = $raw | & $Node --input-type=module --check 2>&1 | Out-String
  $ok = ($LASTEXITCODE -eq 0)
  return [pscustomobject]@{ ok = $ok; output = $output }
}

function Assert-PristineBackup {
  param([string]$BackupPath)
  if (-not (Test-Path -LiteralPath $BackupPath)) { throw "找不到备份文件：$BackupPath" }
  if ((Get-Content -LiteralPath $BackupPath -Raw) -match $PatchMarker) {
    throw "备份文件已被污染（含补丁标记），拒绝继续：$BackupPath"
  }
}

function Restart-GatewayIfRequested {
  if (-not $RestartGateway) {
    Write-Info '未加 -RestartGateway，跳过 Gateway 重启（补丁需重启 Gateway 才真正生效）。'
    return
  }
  $openclaw = Get-Command openclaw -ErrorAction SilentlyContinue
  if (-not $openclaw) { Write-Warn2 'PATH 里找不到 openclaw，跳过重启。'; return }
  Write-Info '重启 Gateway ...'
  & $openclaw.Source gateway restart 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "openclaw gateway restart 返回 $LASTEXITCODE" } else { Write-Ok 'Gateway 已重启' }
}

# ── status ──────────────────────────────────────────────────────────────────
if ($Action -eq 'status') {
  Write-Step 'status（只读）'
  Write-Info "node        : $Node"
  Write-Info "包目录      : $PkgRoot"
  $targets = @(Get-TargetList)
  if ($targets.Count -eq 0) { Write-Warn2 '未发现 worker-task-pool-*.mjs'; exit 0 }
  foreach ($target in $targets) {
    Write-Host ''
    Write-Host "  文件   : $($target.path)"
    Write-Host "  状态   : $(if ($target.patched) { '已打补丁' } else { '未打补丁（原样）' })"
    Write-Host "  大小   : $($target.bytes) 字节"
    Write-Host "  备份   : $(if ($target.backupExists) { $target.backupPath } else { '(不存在)' })"
  }
  exit 0
}

# ── apply ───────────────────────────────────────────────────────────────────
if ($Action -eq 'apply') {
  Write-Step 'apply（生成 → 门禁 → 落盘）'
  if (-not (Test-Path -LiteralPath $GenPatch)) { throw "缺少生成器：$GenPatch" }

  $targets = @(Get-TargetList)
  $target = Select-Target -Targets $targets
  Write-Info "目标文件 : $($target.path)"
  if ($target.patched) { Write-Ok '目标已包含补丁标记，无需重复应用。'; exit 0 }

  $backup = $target.backupPath
  # 备份只在门禁全过、真正落盘前才创建；被拒绝的运行不会在磁盘上留下任何新文件。
  if (Test-Path -LiteralPath $backup) { Assert-PristineBackup -BackupPath $backup }
  $sourceForPatch = if (Test-Path -LiteralPath $backup) { $backup } else { $target.path }
  $originalHash = (Get-FileHash -LiteralPath $target.path -Algorithm SHA256).Hash

  $candidate = Join-Path $env:TEMP ("wtp-patched-" + [guid]::NewGuid().ToString('N') + '.mjs')
  try {
    Write-Info "生成补丁候选（源：$sourceForPatch）..."
    $genOut = & $Node $GenPatch $sourceForPatch $candidate 2>&1 | Out-String
    $genOut.Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidate)) {
      throw "生成失败（退出码 $LASTEXITCODE），未改动目标文件"
    }

    Write-Info '语法门禁：node --input-type=module --check ...'
    $syntax = Test-SyntaxGate -FilePath $candidate
    if (-not $syntax.ok) {
      throw "语法门禁未通过，未改动目标文件：`n$($syntax.output)"
    }
    Write-Ok '语法门禁通过'

    $candidateText = Get-Content -LiteralPath $candidate -Raw
    $sentinelCount = ([regex]::Matches($candidateText, [regex]::Escape($InjectionSentinel))).Count
    $retryCount = ([regex]::Matches($candidateText, [regex]::Escape('cloneRetrySanitized('))).Count
    if ($sentinelCount -ne 1) { throw "结构门禁未通过：注入标记出现 $sentinelCount 次（应为 1）" }
    if ($retryCount -lt 3) { throw "结构门禁未通过：cloneRetrySanitized 出现 $retryCount 次（应为定义 + 2 处调用）" }
    Write-Ok "结构门禁通过（注入标记 1 处，重试函数 $retryCount 处）"

    if ($DryRun) {
      Write-Warn2 'DryRun：门禁全过，但未覆盖目标文件，也未创建备份（候选临时文件已清理）。'
      exit 0
    }

    if (-not (Test-Path -LiteralPath $backup)) {
      Copy-Item -LiteralPath $target.path -Destination $backup -Force
      Write-Ok "已备份原始文件 → $backup"
    }
    Copy-Item -LiteralPath $candidate -Destination $target.path -Force
    $after = (Get-FileHash -LiteralPath $target.path -Algorithm SHA256).Hash
    if ($after -eq $originalHash) { throw '覆盖后哈希未变化，落盘异常' }
    Write-Ok '补丁已落盘并通过全部门禁'
    Write-Info "原始大小 : $((Get-Item -LiteralPath $backup).Length) 字节"
    Write-Info "补丁大小 : $((Get-Item -LiteralPath $target.path).Length) 字节"
    Write-Info "还原命令 : pwsh -File `"$(Join-Path $PSScriptRoot 'revert.ps1')`" -DistPath `"$($target.path)`""
  } finally {
    Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
  }

  Restart-GatewayIfRequested
  exit 0
}

# ── revert ──────────────────────────────────────────────────────────────────
if ($Action -eq 'revert') {
  Write-Step 'revert（从备份还原）'
  $targets = @(Get-TargetList)
  $target = Select-Target -Targets $targets -PreferBackup
  $backup = $target.backupPath
  Write-Info "目标文件 : $($target.path)"
  Assert-PristineBackup -BackupPath $backup

  Write-Info '语法门禁：校验备份文件 ...'
  $syntax = Test-SyntaxGate -FilePath $backup
  if (-not $syntax.ok) { throw "备份文件语法校验未通过，拒绝还原：`n$($syntax.output)" }
  Write-Ok '备份文件语法门禁通过'

  if ($DryRun) { Write-Warn2 'DryRun：未改动目标文件。'; exit 0 }

  Copy-Item -LiteralPath $backup -Destination $target.path -Force
  if ((Get-Content -LiteralPath $target.path -Raw) -match $PatchMarker) {
    throw '还原后目标文件仍含补丁标记，请人工检查'
  }
  Write-Ok '已从备份还原原文件'
  Write-Info "当前大小 : $((Get-Item -LiteralPath $target.path).Length) 字节"
  Restart-GatewayIfRequested
  exit 0
}

throw "未知 -Action：$Action"
