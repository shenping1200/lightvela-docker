#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""凭证定时补传 —— 本地记账版（只查新增，不会越来越慢）

原理：
  1. 本地维护 .uploaded 文件，记下"已确认上传过的 uid"
  2. 每次只处理"没记过的"（新增的）凭证
  3. 上传成功 → 写入 .uploaded
  4. 老凭证永远不查 → 耗时不随总量增长

部署：cron 每 30 分钟跑一次
  */30 * * * * /usr/bin/python3 /root/lightvela-docker/backfill_creds.py >> /root/lightvela-docker/backfill.log 2>&1
"""
import json
import os
import platform
import sys
import time
import urllib.parse
import urllib.request

CENTER = os.environ.get("LIGHTVELA_CENTER", "http://43.167.192.48:18090")
TOKEN = os.environ.get("LIGHTVELA_CENTER_TOKEN", "lvc-9f3a7d2e6b1c4a85")

# 自动找数据目录（容器内 /data，宿主机 /root/lightvela-docker/data）
HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = [
    os.path.join(HERE, "domestic-tokens.ndjson"),          # 脚本同目录（本机）
    os.path.join(HERE, "data", "domestic-tokens.ndjson"),  # 脚本目录/data
    "/data/domestic-tokens.ndjson",
    "/root/lightvela-docker/data/domestic-tokens.ndjson",
    "/home/ubuntu/lightvela-docker/data/domestic-tokens.ndjson",
]
DATA = next((p for p in CANDIDATES if os.path.isfile(p)), None)
if not DATA:
    print("[backfill] 找不到 domestic-tokens.ndjson，退出")
    sys.exit(0)

MARK = os.path.join(os.path.dirname(DATA), ".uploaded_uids")


def load_mark():
    try:
        with open(MARK, encoding="utf-8") as f:
            return {l.strip() for l in f if l.strip()}
    except Exception:
        return set()


def save_mark(s):
    try:
        tmp = MARK + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(s)))
        os.replace(tmp, MARK)
    except Exception as e:
        print("[backfill] 写标记失败:", repr(e)[:60])


def push(c):
    """上传一条，返回 True/False"""
    body = {
        "platform": "domestic",
        "account_key": c.get("uid") or c["idCard"],
        "token": c["bearer"],
        "name": c.get("name"),
        "id_card": c["idCard"],
        "phone": c.get("phone"),
        "owner": "backfill-" + (os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "local"),
        "status": "ok",
        "extra": {"uid": c.get("uid")},
    }
    try:
        req = urllib.request.Request(
            CENTER + "/creds",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Auth-Token": TOKEN},
            method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception as e:
        print("[backfill] 上传失败 %s: %r" % (c.get("name"), e)[:100])
        return False


def main():
    t0 = time.time()
    mark = load_mark()
    creds = []
    for line in open(DATA, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("bearer") and o.get("idCard"):
            creds.append(o)

    new = [c for c in creds if (c.get("uid") or c["idCard"]) not in mark]
    print("[backfill] 本地 %d 条，已传 %d，待查 %d" % (len(creds), len(mark), len(new)))

    if not new:
        print("[backfill] 没有新增，跳过（耗时 %.1fs）" % (time.time() - t0))
        return

    ok = fail = 0
    for c in new:
        if push(c):
            mark.add(c.get("uid") or c["idCard"])
            ok += 1
        else:
            fail += 1

    save_mark(mark)
    print("[backfill] 完成：成功 %d 失败 %d，耗时 %.1fs" % (ok, fail, time.time() - t0))


if __name__ == "__main__":
    main()
