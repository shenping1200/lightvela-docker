#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""凭证定时补传 —— 本地记账版（只查新增，不会越来越慢）

原理：
  1. 本地维护 .uploaded 文件，记下"已确认上传过的 uid"
  2. 每次只处理"没记过的"（新增的）凭证
  3. 上传成功 → 写入 .uploaded
  4. 老凭证永远不查 → 耗时不随总量增长

★ 2026-11-07 新增：上传时带 instance_id（实例号）
  - 以前上传不带实例号，导致数据中心很多号明明有 bot 却显示"没 bot"，
    活跃/部署任务会把它们整批跳过。
  - 现在实例号来源：本地凭证的 instanceId → 数据中心 /export 里已登记的值
  - 每次启动拉一次 /export（全量映射，一次请求），对比出"本地有、中心缺"
    的条目做一次性回填；回填完差异归零，以后每次都是 0 秒，不会越来越慢。

部署：cron 每 30 分钟跑一次
  */30 * * * * /usr/bin/python3 /root/lightvela-docker/backfill_creds.py >> /root/lightvela-docker/backfill.log 2>&1
"""
import json
import os
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


def _count_lines(p):
    """数一个文件有多少行；读不了返回 -1。"""
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except Exception:
        return -1


# ★ 2026-11-11 修：**不能按顺序取第一个命中的**。
#   实测 9 台机器上，脚本同目录都残留着一个 11-09 的旧文件 domestic-tokens.ndjson（只有 28 条），
#   它排在候选第一位 → 回填任务一直在同步这 28 条，真正在 data/ 下那 800~1200 条从来没被回填过，
#   结果就是「本地有凭证、数据中心没有」。改成：把存在的候选全数一遍，取**条数最多**的那个。
_exist = [(p, _count_lines(p)) for p in CANDIDATES if os.path.isfile(p)]
if _exist:
    DATA = max(_exist, key=lambda x: x[1])[0]
    if len(_exist) > 1:
        print("[backfill] 发现 %d 个候选文件，选中条数最多的：%s"
              % (len(_exist), DATA))
        for p, n in _exist:
            print("           %-58s %d 条" % (p, n))
else:
    DATA = None
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


def center_instances():
    """一次拉全量，拿到数据中心已登记的 uid -> instance_id 映射"""
    try:
        url = CENTER + "/export?platform=domestic"
        req = urllib.request.Request(url, headers={"X-Auth-Token": TOKEN})
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode("utf-8", "replace")
        m = {}
        for line in txt.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("instanceId") and o.get("uid"):
                m[o["uid"]] = o["instanceId"]
        return m
    except Exception as e:
        print("[backfill] 拉取中心实例号失败（不影响本次上传）:", repr(e)[:80])
        return {}


def local_instance(c):
    """兼容几种字段名"""
    for k in ("instanceId", "instance_id", "ins"):
        v = c.get(k)
        if v:
            return v
    return ""


def push(c, center_map=None, only_ins=False):
    """上传一条，返回 True/False。only_ins=True 时只补实例号，不动其他字段。"""
    uid = c.get("uid") or c["idCard"]
    ins = local_instance(c) or (center_map or {}).get(uid, "")
    if only_ins:
        body = {"platform": "domestic", "account_key": uid, "instance_id": ins}
    else:
        body = {
            "platform": "domestic",
            "account_key": uid,
            "token": c["bearer"],
            "name": c.get("name"),
            "id_card": c["idCard"],
            "phone": c.get("phone"),
            "owner": "backfill-" + (os.environ.get("COMPUTERNAME")
                                    or os.environ.get("HOSTNAME") or "local"),
            "status": "ok",
            "extra": {"uid": c.get("uid")},
        }
        if ins:
            body["instance_id"] = ins
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

    # 一次拉全量映射（一个请求，不随凭证数量变慢）
    cmap = center_instances()
    print("[backfill] 本地 %d 条，已传 %d，中心已登记实例号 %d 个"
          % (len(creds), len(mark), len(cmap)))

    # ① 实例号回填：本地有、中心缺或不一致的，只补这一列
    need = []
    seen = set()
    for c in creds:
        uid = c.get("uid") or c["idCard"]
        ins = local_instance(c)
        if ins and uid not in seen and cmap.get(uid) != ins:
            need.append(c)
            seen.add(uid)
    if need:
        ok = 0
        for c in need:
            if push(c, cmap, only_ins=True):
                ok += 1
        print("[backfill] 实例号回填：%d 个差异，成功 %d，耗时 %.1fs"
              % (len(need), ok, time.time() - t0))

    # ② 新增凭证正常上传（带实例号）
    new = [c for c in creds if (c.get("uid") or c["idCard"]) not in mark]
    if not new:
        print("[backfill] 没有新增凭证，跳过（总耗时 %.1fs）" % (time.time() - t0))
        return

    ok = fail = 0
    for c in new:
        if push(c, cmap):
            mark.add(c.get("uid") or c["idCard"])
            ok += 1
        else:
            fail += 1

    save_mark(mark)
    print("[backfill] 完成：新增成功 %d 失败 %d，总耗时 %.1fs"
          % (ok, fail, time.time() - t0))


if __name__ == "__main__":
    main()
