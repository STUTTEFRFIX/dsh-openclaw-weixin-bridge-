<#
.SYNOPSIS
  revert —— 从 <目标>.orig-bak 还原 OpenClaw 的 worker-task-pool 原文件。

.DESCRIPTION
  scripts/patch-worker-pool.ps1 -Action revert 的薄包装。还原前会校验备份文件未被污染，
  并对备份做一次语法门禁（不通过绝不落盘）。

.EXAMPLE
  pwsh -File scripts/revert.ps1
  pwsh -File scripts/revert.ps1 -DistPath "C:\Users\<you>\.dsh-win\node\node_modules\openclaw\dist\worker-task-pool-XXXX.mjs"
  pwsh -File scripts/revert.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$DistPath = '',
  [switch]$DryRun,
  [switch]$RestartGateway
)

& (Join-Path $PSScriptRoot 'patch-worker-pool.ps1') -Action revert -DistPath $DistPath -DryRun:$DryRun -RestartGateway:$RestartGateway
exit $LASTEXITCODE
