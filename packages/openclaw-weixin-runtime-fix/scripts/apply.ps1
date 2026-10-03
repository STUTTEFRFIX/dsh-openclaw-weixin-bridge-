<#
.SYNOPSIS
  apply —— 给 OpenClaw 的 worker-task-pool 打「克隆失败 → 净化重试」补丁。

.DESCRIPTION
  scripts/patch-worker-pool.ps1 -Action apply 的薄包装。完整说明、门禁与代价见该脚本头部
  注释与包 README。

.EXAMPLE
  pwsh -File scripts/apply.ps1
  pwsh -File scripts/apply.ps1 -DistPath "C:\Users\<you>\.dsh-win\node\node_modules\openclaw\dist\worker-task-pool-XXXX.mjs"
  pwsh -File scripts/apply.ps1 -DryRun      # 只生成 + 过门禁，不覆盖目标文件
#>
[CmdletBinding()]
param(
  [string]$DistPath = '',
  [switch]$DryRun,
  [switch]$RestartGateway
)

& (Join-Path $PSScriptRoot 'patch-worker-pool.ps1') -Action apply -DistPath $DistPath -DryRun:$DryRun -RestartGateway:$RestartGateway
exit $LASTEXITCODE
