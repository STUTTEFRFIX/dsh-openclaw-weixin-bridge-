<#
.SYNOPSIS
  apply/revert 门禁自测 —— 在临时目录里跑真实的 patch-worker-pool.ps1，不碰任何已部署文件。

.DESCRIPTION
  验证四件事：
    1) 指纹缺失 → apply 失败，且目标文件字节不变（不落盘）；
    2) 语法门禁不过 → apply 失败，且目标文件字节不变（不落盘）；
    3) Happy path → apply 成功落盘（生成 .orig-bak），随后 revert 精确还原；
    4) 重复 apply 幂等、无备份时 revert 失败。

  所有读写都在 $env:TEMP 下的临时目录内完成；被测目标是一个**本仓库的合成夹具副本**，
  不是任何真实发行包文件。

.EXAMPLE
  pwsh -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$pkgRoot = Split-Path $PSScriptRoot -Parent
$patchScript = Join-Path $pkgRoot 'scripts/patch-worker-pool.ps1'
$fixture = Join-Path $PSScriptRoot 'fixtures/worker-task-pool-pristine.fixture.mjs'

if (-not (Test-Path $patchScript)) { throw "缺少被测脚本：$patchScript" }
if (-not (Test-Path $fixture)) { throw "缺少夹具：$fixture" }

$script:Passed = 0
$script:Failures = @()

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    $script:Passed += 1
    Write-Host "  PASS  $Name" -ForegroundColor Green
  } else {
    $script:Failures += "$Name$(if ($Detail) { " — $Detail" })"
    Write-Host "  FAIL  $Name$(if ($Detail) { " — $Detail" })" -ForegroundColor Red
  }
}

function Group { param([string]$Title) Write-Host "`n== $Title ==" -ForegroundColor Cyan }

function Invoke-Patch {
  param([string]$Action, [string]$Target, [switch]$DryRun)
  $arguments = @('-NoProfile', '-File', $patchScript, '-Action', $Action, '-DistPath', $Target)
  if ($DryRun) { $arguments += '-DryRun' }
  $output = & pwsh @arguments 2>&1 | Out-String
  return [pscustomobject]@{ exitCode = $LASTEXITCODE; output = $output }
}

function HashOf {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$workspace = Join-Path $env:TEMP ("wtp-gate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace | Out-Null
$fixtureText = Get-Content -LiteralPath $fixture -Raw

try {
  # ── 1. 指纹缺失 ───────────────────────────────────────────────────────────
  Group '指纹缺失（apply 必须失败且不落盘）'
  $noFingerprint = Join-Path $workspace 'worker-task-pool-nofp.mjs'
  Set-Content -LiteralPath $noFingerprint -Value ($fixtureText -replace '(?m)^(\s*)input,$', '$1inputRenamed,') -NoNewline
  $before = HashOf $noFingerprint
  $run = Invoke-Patch -Action apply -Target $noFingerprint
  Check 'apply 退出码非 0' ($run.exitCode -ne 0) "exit=$($run.exitCode)"
  Check '目标文件字节不变' ((HashOf $noFingerprint) -eq $before)
  Check '未创建备份文件' (-not (Test-Path "$noFingerprint.orig-bak"))
  Check -Name '失败信息提到未找到指纹' -Condition ($run.output -match 'no-fingerprint') -Detail $run.output.Trim()

  # ── 2. 语法门禁不通过 ─────────────────────────────────────────────────────
  Group '语法门禁（apply 必须失败且不落盘）'
  $broken = Join-Path $workspace 'worker-task-pool-broken.mjs'
  Set-Content -LiteralPath $broken -Value ($fixtureText + "`nexport const brokenSyntax = ;`n") -NoNewline
  $beforeBroken = HashOf $broken
  $run = Invoke-Patch -Action apply -Target $broken
  Check 'apply 退出码非 0' ($run.exitCode -ne 0) "exit=$($run.exitCode)"
  Check '目标文件字节不变（语法门禁拦住了落盘）' ((HashOf $broken) -eq $beforeBroken)
  Check -Name '失败信息提到语法门禁' -Condition ($run.output -match '语法门禁') -Detail $run.output.Trim()
  Check '语法门禁失败时不创建备份文件' (-not (Test-Path "$broken.orig-bak"))

  # ── 3. DryRun ─────────────────────────────────────────────────────────────
  Group 'DryRun（生成并通过门禁，但不覆盖目标）'
  $dryTarget = Join-Path $workspace 'worker-task-pool-dry.mjs'
  Set-Content -LiteralPath $dryTarget -Value $fixtureText -NoNewline
  $beforeDry = HashOf $dryTarget
  $run = Invoke-Patch -Action apply -Target $dryTarget -DryRun
  Check 'DryRun 退出码 0' ($run.exitCode -eq 0) "exit=$($run.exitCode)"
  Check 'DryRun 不改动目标文件' ((HashOf $dryTarget) -eq $beforeDry)
  Check -Name 'DryRun 输出提到未覆盖' -Condition ($run.output -match 'DryRun') -Detail $run.output.Trim()
  Check 'DryRun 不创建备份文件' (-not (Test-Path "$dryTarget.orig-bak"))

  # ── 4. Happy path + revert ────────────────────────────────────────────────
  Group 'apply 落盘 → revert 精确还原'
  $happy = Join-Path $workspace 'worker-task-pool-happy.mjs'
  Set-Content -LiteralPath $happy -Value $fixtureText -NoNewline
  $beforeHappy = HashOf $happy
  $applyRun = Invoke-Patch -Action apply -Target $happy
  Check 'apply 退出码 0' ($applyRun.exitCode -eq 0) "exit=$($applyRun.exitCode)`n$($applyRun.output)"
  Check 'apply 后目标文件含补丁标记' ((Get-Content -LiteralPath $happy -Raw) -match 'FIX-CLONE')
  Check 'apply 生成了原始备份' (Test-Path "$happy.orig-bak")
  Check '备份是原文件（哈希一致）' ((HashOf "$happy.orig-bak") -eq $beforeHappy)
  Check 'apply 后文件确实变化' ((HashOf $happy) -ne $beforeHappy)
  $syntax = (Get-Content -LiteralPath $happy -Raw | & node --input-type=module --check 2>&1 | Out-String)
  Check 'apply 后的文件通过 ESM 语法校验' ($LASTEXITCODE -eq 0) $syntax.Trim()

  $hashBeforeRepeat = HashOf $happy
  $repeat = Invoke-Patch -Action apply -Target $happy
  Check -Name '重复 apply 幂等（退出码 0、提示无需重复、文件不再变化）' -Condition ($repeat.exitCode -eq 0 -and $repeat.output -match '无需重复应用' -and (HashOf $happy) -eq $hashBeforeRepeat) -Detail $repeat.output.Trim()

  $revertRun = Invoke-Patch -Action revert -Target $happy
  Check 'revert 退出码 0' ($revertRun.exitCode -eq 0) "exit=$($revertRun.exitCode)`n$($revertRun.output)"
  Check 'revert 后与原始字节完全一致' ((HashOf $happy) -eq $beforeHappy)
  Check 'revert 后不再含补丁标记' (-not ((Get-Content -LiteralPath $happy -Raw) -match 'FIX-CLONE'))

  # ── 5. 无备份时 revert ────────────────────────────────────────────────────
  Group '无备份时 revert 必须失败'
  $noBackup = Join-Path $workspace 'worker-task-pool-nobak.mjs'
  Set-Content -LiteralPath $noBackup -Value $fixtureText -NoNewline
  $beforeNoBackup = HashOf $noBackup
  $run = Invoke-Patch -Action revert -Target $noBackup
  Check 'revert 退出码非 0' ($run.exitCode -ne 0) "exit=$($run.exitCode)"
  Check '无备份时不改动目标文件' ((HashOf $noBackup) -eq $beforeNoBackup)

  # ── 6. 污染备份必须被拒绝 ─────────────────────────────────────────────────
  Group '备份被污染时拒绝 apply/revert'
  $dirty = Join-Path $workspace 'worker-task-pool-dirty.mjs'
  Set-Content -LiteralPath $dirty -Value $fixtureText -NoNewline
  Set-Content -LiteralPath "$dirty.orig-bak" -Value ($fixtureText + "`n// FIX-CLONE polluted backup`n") -NoNewline
  $beforeDirty = HashOf $dirty
  $run = Invoke-Patch -Action apply -Target $dirty
  Check 'apply 退出码非 0' ($run.exitCode -ne 0) "exit=$($run.exitCode)"
  Check -Name '提示备份被污染' -Condition ($run.output -match '污染') -Detail $run.output.Trim()
  Check '目标文件不变' ((HashOf $dirty) -eq $beforeDirty)
} finally {
  Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n---- 门禁自测汇总：$($script:Passed) passed, $($script:Failures.Count) failed ----"
if ($script:Failures.Count -gt 0) {
  foreach ($failure in $script:Failures) { Write-Host "  FAILED: $failure" -ForegroundColor Red }
  exit 1
}
Write-Host '全部门禁断言通过。' -ForegroundColor Green
exit 0
