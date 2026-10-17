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

COPY lv_gui_core.py webapp.py lv_gui.html \
     lightvela-purecode.js lv-proxy.js lv-ptystart-fn.js \
     domestic_core.py domestic_lightvela_bot.js domestic_lightvela_batch.js \
     _probe_full.js _probe_instances.js _recheck_probe.js ./

RUN mkdir -p /data \
 && echo "node: $(node -v)" \
 && echo "python: $(python3 -V)"

EXPOSE 8000

CMD ["python3", "webapp.py"]
