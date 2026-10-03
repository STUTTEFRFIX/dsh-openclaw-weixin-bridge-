<#
.SYNOPSIS
  dsh-openclaw-weixin-bridge 一键部署（Windows / PowerShell 7+）

.DESCRIPTION
  幂等部署脚本：把本仓库的 OpenClaw hook pack 接进你的 OpenClaw 实例，并可选地把
  DSH 侧 Cordis 插件片段打印出来供你粘贴。

  它做四件事：
    1. 前置检查（node / openclaw / 目标目录可写）
    2. 备份 openclaw.json
    3. 把 hooks.internal.load.extraDirs 指向本仓库的 hook pack，并显式登记 hook 条目
    4. 打印下一步（配置 URL 与共享密钥、重启 Gateway）

.PARAMETER DryRun
  只打印将要做的改动，不写任何文件。

.PARAMETER Uninstall
  回滚：从配置里移除本仓库的 extraDirs 与 hook 条目（不动其它设置）。

.PARAMETER OpenClawConfig
  openclaw.json 路径。默认 %USERPROFILE%\.openclaw\openclaw.json

.PARAMETER SecretFile
  共享密钥文件路径（仅用于提示，不会写入配置明文）。默认 %USERPROFILE%\.dsh\bridge-secret.txt

.EXAMPLE
  pwsh -File .\deploy.ps1 -DryRun
  pwsh -File .\deploy.ps1
  pwsh -File .\deploy.ps1 -Uninstall

.NOTES
  本脚本只改 OpenClaw 配置，不改本仓库文件、不安装依赖、不启动常驻服务。
  系统级服务注册请使用 OpenClaw 自己的 `openclaw gateway install`。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Uninstall,
  [string]$OpenClawConfig = (Join-Path $env:USERPROFILE ".openclaw\openclaw.json"),
  [string]$SecretFile = (Join-Path $env:USERPROFILE ".dsh\bridge-secret.txt")
)

$ErrorActionPreference = 'Stop'
$script:Problems = @()

function Write-Step { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Skip { param([string]$m) Write-Host "  [SKIP] $m" -ForegroundColor DarkGray }
function Write-Warn { param([string]$m) Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Problems += $m }

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HookPack = Join-Path $RepoRoot "plugins\openclaw-hook-dsh-bridge"
$HookName = "dsh-bridge"

# ── 1. 前置检查 ─────────────────────────────────────────────────────────────
Write-Step '1/4 前置检查'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Err "未找到 node（需要 Node >= 22.13）" } else { Write-Ok ("node " + (& node --version)) }
if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) { Write-Err "未找到 openclaw 命令（请先安装并确保在 PATH 中）" } else { Write-Ok ("openclaw " + ((& openclaw --version 2>&1) -join ' ').Trim()) }
if (-not (Test-Path $HookPack)) { Write-Err "hook pack 目录不存在: $HookPack" } else { Write-Ok "hook pack 就位: $HookPack" }
if (-not (Test-Path $OpenClawConfig)) { Write-Err "找不到 OpenClaw 配置: $OpenClawConfig" } else { Write-Ok "配置文件: $OpenClawConfig" }

if ($script:Problems.Count -gt 0) {
  Write-Host "`n前置检查未通过，已中止（未做任何改动）。" -ForegroundColor Red
  exit 1
}

# ── 2. 备份 ─────────────────────────────────────────────────────────────────
Write-Step '2/4 备份配置'
if ($DryRun) {
  Write-Skip "DryRun：跳过备份"
} else {
  $bak = "$OpenClawConfig.bak-deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $OpenClawConfig $bak -Force
  Write-Ok "已备份 → $bak"
}

# ── 3. 写入 extraDirs 与 hook 条目 ──────────────────────────────────────────
Write-Step '3/4 接入 hook pack'
$patchFile = Join-Path $env:TEMP ("dsh-bridge-deploy-" + [guid]::NewGuid().ToString("N") + ".json5")
$extraDirJson = $HookPack -replace '\\', '\\'

if ($Uninstall) {
  $patch = @"
{
  hooks: {
    internal: {
      load: { extraDirs: [] },
      entries: { "$HookName": { enabled: false } },
    },
  },
}
"@
} else {
  $patch = @"
{
  // 由 deploy.ps1 生成：把 OpenClaw 的 hook 加载目录指向本仓库的 hook pack。
  hooks: {
    internal: {
      enabled: true,
      load: { extraDirs: ["$extraDirJson"] },
      entries: { "$HookName": { enabled: true } },
    },
  },
}
"@
}
Set-Content -Path $patchFile -Value $patch -Encoding utf8

if ($DryRun) {
  Write-Skip "DryRun：将执行 openclaw config patch --file <临时文件>"
  Write-Host "--- 将要应用的配置片段 ---" -ForegroundColor DarkGray
  Get-Content $patchFile | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else {
  & openclaw config patch --file $patchFile 2>&1 | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Write-Err "配置写入失败（退出码 $LASTEXITCODE）" } else { Write-Ok "配置已写入" }
  & openclaw config validate 2>&1 | ForEach-Object { Write-Host "  $_" }
}
Remove-Item $patchFile -Force -ErrorAction SilentlyContinue

# ── 4. 下一步提示 ───────────────────────────────────────────────────────────
Write-Step '4/4 下一步（必读）'
Write-Host @"
本脚本只完成"把 hook 接进 OpenClaw"。要让消息真正流到 DSH，还需：

  a) 给 OpenClaw 进程提供桥接地址与共享密钥（二选一）：
     - 环境变量：DSH_BRIDGE_URL / DSH_BRIDGE_SECRET
     - 旁挂文件：`$env:USERPROFILE\.openclaw\dsh-bridge-hook.json`
       （样例见 config\dsh-bridge-hook.sample.json）

  b) 共享密钥文件（本脚本仅提示，未创建）：
     $SecretFile

  c) 在 DSH 侧安装并配置 Cordis 桥接插件：
     片段见 config\dsh-webhook-bridge.patch.sample.yml

  d) 重启 OpenClaw 使配置生效：
     openclaw gateway restart
     openclaw hooks list        # 应看到 dsh-bridge

警告（详见 STATUS.md / docs\*/known-issues.md）：
  - 本项目处于【测试阶段】，端到端未在干净环境验证。
  - 若你的 OpenClaw 微信通道出现"消息可收不可回"，需要额外运行时修复包：
    packages\openclaw-weixin-runtime-fix（非受支持改法，OpenClaw 升级后会丢失）。
"@ -ForegroundColor Gray

if ($script:Problems.Count -gt 0) {
  Write-Host "`n完成，但有 $($script:Problems.Count) 项失败，请查看上面的 [FAIL]。" -ForegroundColor Yellow
  exit 1
}
Write-Host "`n部署步骤完成。" -ForegroundColor Green
