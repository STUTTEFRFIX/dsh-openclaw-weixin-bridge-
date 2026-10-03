#!/usr/bin/env bash
# ============================================================================
#  dsh-openclaw-weixin-bridge 一键部署（Linux / macOS / WSL）
# ============================================================================
#  幂等脚本：把本仓库的 OpenClaw hook pack 接进你的 OpenClaw 实例。
#  只改 OpenClaw 配置，不改本仓库文件、不安装依赖、不注册系统服务。
#
#  用法：
#    ./deploy.sh --dry-run      # 只打印将要做的改动
#    ./deploy.sh                # 实际部署
#    ./deploy.sh --uninstall    # 回滚（移除 extraDirs 与 hook 条目）
#
#  环境变量：
#    OPENCLAW_CONFIG   默认 ~/.openclaw/openclaw.json
#    DSH_SECRET_FILE   默认 ~/.dsh/bridge-secret.txt（仅用于提示）
# ============================================================================
set -euo pipefail

DRY_RUN=0
UNINSTALL=0
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
SECRET_FILE="${DSH_SECRET_FILE:-$HOME/.dsh/bridge-secret.txt}"
HOOK_NAME="dsh-bridge"

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PACK="$REPO_ROOT/plugins/openclaw-hook-dsh-bridge"

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [OK]   %s\n' "$1"; }
skip() { printf '  [SKIP] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
PROBLEMS=0

# ── 1. 前置检查 ─────────────────────────────────────────────────────────────
step "1/4 前置检查"
command -v node >/dev/null 2>&1 && ok "node $(node --version)" || fail "未找到 node（需要 >= 22.13）"
command -v openclaw >/dev/null 2>&1 && ok "openclaw $(openclaw --version 2>&1 | head -n1)" || fail "未找到 openclaw 命令"
[ -d "$HOOK_PACK" ] && ok "hook pack 就位: $HOOK_PACK" || fail "hook pack 目录不存在: $HOOK_PACK"
[ -f "$OPENCLAW_CONFIG" ] && ok "配置文件: $OPENCLAW_CONFIG" || fail "找不到 OpenClaw 配置: $OPENCLAW_CONFIG"

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n前置检查未通过，已中止（未做任何改动）。\n' >&2
  exit 1
fi

# ── 2. 备份 ─────────────────────────────────────────────────────────────────
step "2/4 备份配置"
if [ "$DRY_RUN" -eq 1 ]; then
  skip "dry-run：跳过备份"
else
  BAK="$OPENCLAW_CONFIG.bak-deploy-$(date +%Y%m%d-%H%M%S)"
  cp "$OPENCLAW_CONFIG" "$BAK"
  ok "已备份 → $BAK"
fi

# ── 3. 生成并应用配置片段 ───────────────────────────────────────────────────
step "3/4 接入 hook pack"
PATCH_FILE="$(mktemp -t dsh-bridge-deploy-XXXXXX.json5)"
trap 'rm -f "$PATCH_FILE"' EXIT

if [ "$UNINSTALL" -eq 1 ]; then
  cat >"$PATCH_FILE" <<EOF
{
  hooks: {
    internal: {
      load: { extraDirs: [] },
      entries: { "$HOOK_NAME": { enabled: false } },
    },
  },
}
EOF
else
  cat >"$PATCH_FILE" <<EOF
{
  // 由 deploy.sh 生成：把 OpenClaw 的 hook 加载目录指向本仓库的 hook pack。
  hooks: {
    internal: {
      enabled: true,
      load: { extraDirs: ["$HOOK_PACK"] },
      entries: { "$HOOK_NAME": { enabled: true } },
    },
  },
}
EOF
fi

if [ "$DRY_RUN" -eq 1 ]; then
  skip "dry-run：将执行 openclaw config patch --file <临时文件>"
  echo "--- 将要应用的配置片段 ---"
  sed 's/^/  /' "$PATCH_FILE"
else
  openclaw config patch --file "$PATCH_FILE"
  ok "配置已写入"
  openclaw config validate || warn "配置校验未通过，请检查上面的输出"
fi

# ── 4. 下一步提示 ───────────────────────────────────────────────────────────
step "4/4 下一步（必读）"
cat <<EOF
本脚本只完成"把 hook 接进 OpenClaw"。要让消息真正流到 DSH，还需：

  a) 给 OpenClaw 进程提供桥接地址与共享密钥（二选一）：
     - 环境变量：DSH_BRIDGE_URL / DSH_BRIDGE_SECRET
     - 旁挂文件：~/.openclaw/dsh-bridge-hook.json
       （样例见 config/dsh-bridge-hook.sample.json）

  b) 共享密钥文件（本脚本仅提示，未创建）：
     $SECRET_FILE

  c) 在 DSH 侧安装并配置 Cordis 桥接插件：
     片段见 config/dsh-webhook-bridge.patch.sample.yml

  d) 重启 OpenClaw 使配置生效：
     openclaw gateway restart && openclaw hooks list

警告（详见 STATUS.md / docs/*/known-issues.md）：
  - 本项目处于【测试阶段】，端到端未在干净环境验证。
  - 若微信通道出现"消息可收不可回"，需额外运行时修复包：
    packages/openclaw-weixin-runtime-fix（非受支持改法，升级后会丢失）。
EOF

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n完成，但有 %s 项失败，请查看上面的 [FAIL]。\n' "$PROBLEMS" >&2
  exit 1
fi
printf '\n部署步骤完成。\n'
