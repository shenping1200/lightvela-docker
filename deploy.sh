#!/usr/bin/env bash
# =============================================================================
# LightVela 抢名额 · Web 版 —— 一键部署脚本
# -----------------------------------------------------------------------------
# 用法：
#   A. 一行命令直接装（推荐，无需先传文件）：
#        bash <(curl -fsSL https://raw.githubusercontent.com/shenping1200/lightvela-docker/main/install.sh)
#
#   B. 已经进到项目目录里：
#        bash deploy.sh
#
# 它会自动完成：
#   1. 检查 / 安装 Docker 与 docker compose
#   2. 拉取（或更新）项目代码到 ./lightvela-docker
#   3. 交互询问端口与面板登录密码（也可环境变量免交互指定）
#   4. 生成 .env（登录密码 + 随机签名密钥，权限 600）
#   5. 开放防火墙端口
#   6. 构建镜像并启动容器
#   7. 自检并打印访问地址
#
# 免交互指定端口 / 密码 / 目录 / 仓库：
#   LV_WEB_PASSWORD='你的密码' LV_PORT=8080 bash deploy.sh
#   REPO_URL=https://github.com/you/repo.git TARGET_DIR=/opt/xxx bash deploy.sh
#
# 只更新代码不部署：
#   PULL_ONLY=1 bash deploy.sh
# =============================================================================

set -euo pipefail

# ---------------------------- 可配置项 ---------------------------------------
# 默认登录密码（最后一位是英文句点，别漏）
# ⚠️ 这是公开的默认值，正式部署建议用 LV_WEB_PASSWORD='自己的密码' 覆盖
DEFAULT_PASSWORD='QQqq120656387.'
# 宿主机对外端口（容器内固定 8000）
HOST_PORT="${LV_PORT:-18080}"
# 数据目录（存放凭证 lv-tokens.json，容器内挂到 /data）
DATA_DIR="./data"
# 代码仓库与安装目录
REPO_URL="${REPO_URL:-https://github.com/shenping1200/lightvela-docker.git}"
TARGET_DIR="${TARGET_DIR:-lightvela-docker}"
# 只更新代码、不重新部署
PULL_ONLY="${PULL_ONLY:-0}"
# -----------------------------------------------------------------------------

# --------------------------------- 小工具 -----------------------------------
C_R="\033[0m"; C_G="\033[32m"; C_Y="\033[33m"; C_B="\033[36m"; C_E="\033[31m"
info() { printf "${C_B}[信息]${C_R} %s\n" "$*"; }
ok()   { printf "${C_G}[成功]${C_R} %s\n" "$*"; }
warn() { printf "${C_Y}[注意]${C_R} %s\n" "$*"; }
die()  { printf "${C_E}[失败]${C_R} %s\n" "$*" >&2; exit 1; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      SUDO=""
      warn "当前不是 root，且没有 sudo，后续需要权限的步骤可能失败"
    fi
  else
    SUDO=""
  fi
}

# ---------------------------- 1. 环境检查 -----------------------------------
need_root
info "检查 Docker 环境 ..."

if ! command -v docker >/dev/null 2>&1; then
  warn "没装 Docker，尝试自动安装（仅支持 Debian/Ubuntu）..."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y --no-install-recommends ca-certificates curl gnupg
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
    ok "Docker 安装完成"
  else
    die "这台机器不是 Debian/Ubuntu，请先手动安装 Docker 后再跑本脚本"
  fi
else
  ok "Docker 已存在：$(docker --version)"
fi

# 判断用 "docker compose" 还是老版 "docker-compose"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  warn "找不到 compose 插件，尝试安装 ..."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y docker-compose-plugin || $SUDO apt-get install -y docker-compose
    if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
  else
    die "请先手动安装 docker compose 后重试"
  fi
fi
ok "编排命令：$DC"

# ---------------------------- 2. 拉取 / 更新代码 ------------------------------
in_project() { [ -f ./Dockerfile ] && [ -f ./docker-compose.yml ]; }

if in_project; then
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    info "检测到 git 仓库，拉取最新代码 ..."
    if git pull --ff-only >/dev/null 2>&1; then
      ok "已更新到最新版本"
    else
      warn "更新失败（可能有本地改动或网络问题），继续用当前代码部署"
    fi
  else
    info "使用当前目录的代码部署"
  fi
else
  info "当前目录没有项目代码，准备拉取仓库 ..."
  if ! command -v git >/dev/null 2>&1; then
    warn "没装 git，尝试安装 ..."
    if command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update -y >/dev/null
      $SUDO apt-get install -y --no-install-recommends git >/dev/null
      ok "git 安装完成"
    else
      die "这台机器没有 git 也装不了，请先手动安装 git"
    fi
  fi

  if [ -d "$TARGET_DIR/.git" ]; then
    info "目录 $TARGET_DIR 已存在，拉取更新 ..."
    git -C "$TARGET_DIR" pull --ff-only || warn "更新失败，继续用已有代码"
  elif [ -e "$TARGET_DIR" ]; then
    die "目录 $TARGET_DIR 已存在但不是 git 仓库，请先改名/删除它，或指定 TARGET_DIR=别的目录"
  else
    info "克隆到 $TARGET_DIR ..."
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR" || die "克隆失败，检查网络或仓库地址"
    ok "代码拉取完成"
  fi

  info "进入项目目录：$TARGET_DIR"
  cd "$TARGET_DIR"
fi

# 只更新代码模式（不部署）
if [ "$PULL_ONLY" = "1" ]; then
  ok "代码已更新到最新（PULL_ONLY=1），未做部署。需要部署时运行：bash deploy.sh"
  exit 0
fi

# ---------------------------- 3. 交互设置（端口 / 密码）-----------------------
# 判断能否交互：真实 SSH 终端有 /dev/tty 即可（兼容 bash <(curl ...) 这种 stdin 是管道的情况）
can_ask() { [ -r /dev/tty ] && [ -w /dev/tty ]; }
if can_ask; then
  # 端口
  if [ -z "${LV_PORT:-}" ]; then
    printf "请输入对外端口（直接回车用默认 %s）：" "$HOST_PORT"
    read -r PORT_IN </dev/tty || PORT_IN=""
    if [ -n "$PORT_IN" ]; then HOST_PORT="$PORT_IN"; fi
  fi
  # 密码（若 .env 已有则跳过询问，沿用旧密码）
  if [ -z "${LV_WEB_PASSWORD:-}" ] && { [ ! -f .env ] || ! grep -q '^LV_WEB_PASSWORD=' .env; }; then
    printf "请设置面板登录密码（直接回车用默认密码 %s）：" "$DEFAULT_PASSWORD"
    read -r PW_IN </dev/tty || PW_IN=""
    if [ -n "$PW_IN" ]; then LV_WEB_PASSWORD="$PW_IN"; fi
  fi
fi

# ---------------------------- 4. 生成 .env -----------------------------------
info "准备 .env（密码 + 签名密钥）..."

if [ -n "${LV_WEB_PASSWORD:-}" ]; then
  PW="$LV_WEB_PASSWORD"
  info "使用环境变量 / 交互输入的密码"
elif [ -f .env ] && grep -q '^LV_WEB_PASSWORD=' .env; then
  PW="$(grep '^LV_WEB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  info "沿用已有 .env 里的密码"
else
  PW="$DEFAULT_PASSWORD"
  info "使用默认密码"
fi

# 签名密钥：已有则沿用，否则新生成（改了会让所有人重新登录）
if [ -f .env ] && grep -q '^LV_SECRET=' .env; then
  SECRET="$(grep '^LV_SECRET=' .env | head -1 | cut -d= -f2-)"
else
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

umask 077
printf 'LV_WEB_PASSWORD=%s\nLV_SECRET=%s\n' "$PW" "$SECRET" > .env
chmod 600 .env
ok ".env 已写入（权限 600）"

mkdir -p "$DATA_DIR"
ok "数据目录：$DATA_DIR"

# ---------------------------- 5. 防火墙 --------------------------------------
info "尝试放行端口 ${HOST_PORT} ..."
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  $SUDO ufw allow "${HOST_PORT}/tcp" >/dev/null 2>&1 && ok "ufw 已放行 ${HOST_PORT}/tcp" || warn "ufw 放行失败，请手动放行"
elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="${HOST_PORT}/tcp" >/dev/null 2>&1 && \
  $SUDO firewall-cmd --reload >/dev/null 2>&1 && ok "firewalld 已放行 ${HOST_PORT}/tcp" || warn "firewalld 放行失败，请手动放行"
elif command -v iptables >/dev/null 2>&1; then
  $SUDO iptables -C INPUT -p tcp --dport "${HOST_PORT}" -j ACCEPT 2>/dev/null || \
  $SUDO iptables -I INPUT -p tcp --dport "${HOST_PORT}" -j ACCEPT 2>/dev/null || true
  ok "iptables 已尝试放行（重启后可能失效）"
else
  warn "未检测到本机防火墙工具，若连不上请到云厂商控制台安全组放行 ${HOST_PORT}/tcp"
fi

# ---------------------------- 6. 构建并启动 ----------------------------------
info "构建镜像（首次会拉 node:22 基础镜像，耐心等 1-3 分钟）..."
$DC build

info "启动容器 ..."
LV_PORT="$HOST_PORT" $DC up -d

info "等待服务起来 ..."
sleep 5

# ---------------------------- 7. 自检 ----------------------------------------
info "自检中 ..."
HEALTH_OK="no"
for i in $(seq 1 20); do
  if $DC exec -T lightvela-web python3 -c \
      "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3)" >/dev/null 2>&1; then
    HEALTH_OK="yes"; break
  fi
  sleep 2
done

PUB_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || \
          curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || true)"

echo
echo "=================================================================="
if [ "$HEALTH_OK" = "yes" ]; then
  ok "部署完成，服务运行正常"
  echo
  echo "  访问地址： http://${PUB_IP:-<你的服务器IP>}:${HOST_PORT}"
  echo "  登录密码： ${PW}"
  echo
  echo "  数据目录： ${DATA_DIR}  （凭证 lv-tokens.json 存这里）"
  echo "  改密码：   LV_WEB_PASSWORD='新密码' bash deploy.sh"
  echo "  看日志：   $DC logs -f lightvela-web"
  echo "  停止：     $DC down"
else
  warn "容器已启动，但健康检查没通过，请查看日志："
  echo "    $DC logs --tail 50 lightvela-web"
  echo
  echo "  也可能只是启动慢，稍等十几秒再刷新浏览器试试。"
fi
echo "=================================================================="
