#!/usr/bin/env bash
# =============================================================================
# LightVela Web —— 一行命令安装入口
# -----------------------------------------------------------------------------
# 在【新服务器】上直接执行这一行即可部署（会自动安装 Docker、拉代码、问端口密码）：
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/shenping1200/lightvela-docker/main/install.sh)
#
# 这个脚本只做一件事：把项目克隆 / 拉取到 ./lightvela-docker，然后调用里面的 deploy.sh。
# 端口与登录密码会在 deploy.sh 里【交互询问】；不想交互就加环境变量：
#
#   LV_WEB_PASSWORD='你的密码' LV_PORT=8080 \
#     bash <(curl -fsSL https://raw.githubusercontent.com/shenping1200/lightvela-docker/main/install.sh)
#
# 只更新代码不部署：加  PULL_ONLY=1
# 换仓库 / 目录：    REPO_URL=... TARGET_DIR=...
# =============================================================================

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/shenping1200/lightvela-docker.git}"
TARGET_DIR="${TARGET_DIR:-lightvela-docker}"

C_B="\033[36m"; C_R="\033[0m"; C_G="\033[32m"
info() { printf "${C_B}[install]${C_R} %s\n" "$*"; }
ok()   { printf "${C_G}[install]${C_R} %s\n" "$*"; }

echo
echo "=========================================================="
echo "  LightVela Web 一键安装"
echo "  仓库：$REPO_URL"
echo "  目录：$TARGET_DIR"
echo "=========================================================="
echo

# 没装 git 就先装（clone 用）
if ! command -v git >/dev/null 2>&1; then
  info "安装 git ..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null 2>&1 || true
    sudo apt-get install -y --no-install-recommends git >/dev/null 2>&1 || true
  fi
fi

# 拉取 / 更新代码
if [ -d "$TARGET_DIR/.git" ]; then
  info "已存在，拉取更新 ..."
  git -C "$TARGET_DIR" pull --ff-only || true
elif [ -e "$TARGET_DIR" ]; then
  echo "目录 $TARGET_DIR 已存在但不是仓库，请先处理。" >&2
  exit 1
else
  info "克隆项目 ..."
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR" || { echo "克隆失败"; exit 1; }
fi

ok "代码就绪：./$TARGET_DIR"
echo

# 转交给真正的部署脚本（端口 / 密码的交互在这里进行）
cd "$TARGET_DIR"
exec bash ./deploy.sh "$@"
