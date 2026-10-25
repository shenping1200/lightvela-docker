# LightVela 抢名额 · Web 版（ARM64 / x86 通用）
# 基础镜像自带 Node 22，编排层用 Python（复用 lv_gui_core 的 Job/Api）
FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LV_DATA_DIR=/data \
    LV_PORT=8000 \
    PATH="/venv/bin:$PATH"

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /venv

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 谷歌授权登录需要真实浏览器引擎（node:22 自带 npm，此处装 Playwright + Chromium）
# 注意：npm install 必须放在 COPY 源码之前，避免每次改源码都重下浏览器。
RUN npm install playwright

COPY lv_gui_core.py webapp.py lv_gui.html lv_google_login.js \
     lightvela-purecode.js lv-proxy.js lv-ptystart-fn.js \
     domestic_core.py domestic_lightvela_bot.js domestic_lightvela_batch.js \
     _probe_full.js _probe_instances.js _recheck_probe.js ./

# 安装 Chromium 浏览器及其系统依赖（--with-deps 需要 root，基础镜像默认即 root）
RUN npx playwright install --with-deps chromium

RUN mkdir -p /data \
 && echo "node: $(node -v)" \
 && echo "python: $(python3 -V)" \
 && echo "playwright: $(node -e "console.log(require('playwright/package.json').version)" 2>/dev/null || echo unknown)"

EXPOSE 8000

CMD ["python3", "webapp.py"]
