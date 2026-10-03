# ============================================================================
#  桥接验证脚本：模拟 ClawBot 调用 DSH 桥接入口，创建一条新会话
# ============================================================================
#  用法:
#    pwsh -File test-bridge.ps1                      # 默认发一句测试文本
#    pwsh -File test-bridge.ps1 -Text "写一个冒泡排序"
#    pwsh -File test-bridge.ps1 -Text "..." -Sender "oXXXX@im.wechat"
#    pwsh -File test-bridge.ps1 -NegativeCase        # 只跑“错误密钥应被拒”的负例
#
#  密钥来源: $env:DSH_BRIDGE_SECRET_FILE（推荐，指向仓库外的密钥文件）
#            或 <stateDir>/bridge-secret.txt（stateDir = $env:DSH_HOME，缺省 $env:USERPROFILE\.dsh）
#            不回显明文；本机真实值不要写回本脚本，见 config/dsh-webhook-bridge.patch.local.yml
# ============================================================================

param(
  [string]$Text = "你好，我是通过桥接创建的会话。请用一句话确认你收到了这条消息。",
  [string]$Sender = "",
  [string]$Title = "",
  [string]$Workspace = "",
  [string]$BaseUrl = $(if ($env:DSH_BRIDGE_BASE_URL) { $env:DSH_BRIDGE_BASE_URL } else { "http://127.0.0.1:25567" }),
  [string]$Path = "/openclaw-wechat",
  [string]$SecretFile = $(
    if ($env:DSH_BRIDGE_SECRET_FILE) { $env:DSH_BRIDGE_SECRET_FILE }
    elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'bridge-secret.txt' }
    else { Join-Path (Join-Path $env:USERPROFILE '.dsh') 'bridge-secret.txt' }
  ),
  [switch]$NegativeCase,
  [switch]$Wait
)

$ErrorActionPreference = 'Stop'

function Get-BridgeSecret {
  if (-not (Test-Path $SecretFile)) { throw "找不到密钥文件: $SecretFile" }
  $line = (Get-Content $SecretFile | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1)
  if (-not $line) { throw "密钥文件为空: $SecretFile" }
  return $line.Trim()
}

function Invoke-Bridge {
  param([string]$Secret, [hashtable]$Body)
  $json = $Body | ConvertTo-Json -Depth 6 -Compress
  $headers = @{ Authorization = "Bearer $Secret"; 'Content-Type' = 'application/json' }
  try {
    $r = Invoke-WebRequest -Uri ($BaseUrl + $Path) -Method Post -Headers $headers -Body $json -TimeoutSec 30 -ErrorAction Stop
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $code = 0; $msg = $_.Exception.Message
    if ($_.Exception.Response) {
      $code = [int]$_.Exception.Response.StatusCode
      try { $msg = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    }
    return [pscustomobject]@{ Status = $code; Body = $msg }
  }
}

Write-Host "=== 桥接验证 ===" -ForegroundColor Cyan
Write-Host ("目标 : {0}{1}" -f $BaseUrl, $Path)
Write-Host ("密钥 : {0}（长度 {1}，不回显）" -f $SecretFile, (Get-BridgeSecret).Length)

# ── 负例：错误密钥必须被拒（预期 401）─────────────────────────────────────────
Write-Host "`n--- 负例：错误密钥（预期 401）---" -ForegroundColor Yellow
$bad = Invoke-Bridge -Secret "definitely-not-the-right-secret" -Body @{ text = "should be rejected" }
Write-Host ("状态 {0}  响应 {1}" -f $bad.Status, $bad.Body) -ForegroundColor $(if ($bad.Status -eq 401) { 'Green' } else { 'Red' })
if ($bad.Status -ne 401) { Write-Host "⚠ 负例未按预期被拒——请勿上线！" -ForegroundColor Red }

if ($NegativeCase) { exit 0 }

# ── 正例：应返回 202 并创建新会话 ────────────────────────────────────────────
Write-Host "`n--- 正例：有效密钥（预期 202）---" -ForegroundColor Yellow
$secret = Get-BridgeSecret
$body = @{ text = $Text }
if ($Sender) { $body.sender = $Sender }
if ($Title) { $body.title = $Title }
if ($Workspace) { $body.workspacePath = $Workspace }
if ($Wait) { $body.wait = $true }

$ok = Invoke-Bridge -Secret $secret -Body $body
Write-Host ("状态 {0}  响应 {1}" -f $ok.Status, $ok.Body) -ForegroundColor $(if ($ok.Status -eq 202) { 'Green' } else { 'Red' })
if ($ok.Status -eq 202) {
  Write-Host "`n✅ 已确认创建会话（响应含 sessionId）。" -ForegroundColor Green
} else {
  Write-Host "`n❌ 未受理。404=路由未挂载或目录不存在；502=派发后未建成会话；401=密钥错；503=密钥不可用。" -ForegroundColor Red
}


