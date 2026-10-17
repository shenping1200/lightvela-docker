# -*- coding: utf-8 -*-
"""
国内版 LightVela 核心（Web 版后端）
=================================
- 复用 domestic_lightvela_bot.js（支持 --account-idx / --login-only），每个账号独立子进程，
  内存隔离避免 CFG 全局单例并发污染；
- 模式：
    login = 只取号接码登录实名、拿 Bearer 凭证（不部署）
    full  = 全流程（登录→实名→抢套餐→建Bot→设主模型→发部署命令→抓回复判成功）
- 凭证写在 domestic-tokens.json（与国际版 lv-tokens.json 物理隔离）；
- 并发由本模块用线程池控制（默认 5，环境变量 LIGHTVELA_DOMESTIC_CONCURRENCY）。
"""
import os
import json
import time
import re
import threading
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = os.environ.get("LIGHTVELA_NODE_BIN") or "node"
BOT = os.path.join(BASE, "domestic_lightvela_bot.js")
CONCURRENCY = int(os.environ.get("LIGHTVELA_DOMESTIC_CONCURRENCY") or 5)
PER_ACCT_TIMEOUT = int(os.environ.get("LIGHTVELA_DOMESTIC_TIMEOUT") or 40 * 60)  # 秒

_lock = threading.Lock()
_state = {
    "running": False,
    "mode": None,          # "login" | "full"
    "total": 0,
    "done": 0,
    "started_at": 0,
    "results": [],         # 每账号 {idx,name,idCard,ok,phone,uid,bearer,instanceId,deployOk,log}
    "log": [],             # 实时日志（带账号前缀）
    "thread": None,
    "procs": [],
}

CRED_RE = re.compile(r"DOMESTIC_CRED_JSON=(\{.*\})")


# ===================== 国内版配置（接码平台账号/密码 + 代理 + 部署指令）=====================
DEFAULT_DOMESTIC_CONFIG = {
    "sms": {
        "apiBase": "https://api.haozhuma.com",
        "apiUser": "f632fc95683bd65352623febb154ffcae6550a33178a18c65921060810d0571c",
        "apiPass": "284d033beb03583ba15948792383e03683e36a6c90cf0c63a1ca767a2d70c2f6",
        "projectId": 21986,
    },
    "proxy": {
        "type": "socks5",
        "host": "a.rr2.kdns.fr",
        "port": "10800",
        "user": "6582443",
        "pass": "6582443",
    },
    "deploy": {
        "verify": True,        # F 主动验证：判失败后让机器人自查探针状态（PROBE_STATUS），真在跑就改判成功
        "retry": 2,            # D 免费重试：同一机器人重发部署命令次数（0=不重试；不花号不花套餐）
        "smsTimeoutSec": 180,  # 取码超时秒数（官方：超三分钟未收到验证码即拉黑重取号）
        "smsMaxRent": 3,       # 取码超时后最多换号次数
    },
}
DOMESTIC_DEPLOY_MSG_FILE = "domestic-deploy-msg.txt"
DOMESTIC_DEPLOY_MSG_DEFAULT = (
    "# 这里写【国内版部署指令】。把探针地址与命令贴进来。\n"
    "# 推荐做法：在本程序同目录放一个 _deploy_msg.txt，写入你的指令原文。\n"
    "# 程序会优先读它（该文件已在 .gitignore 中，不会被提交到仓库）。\n"
)


def _data_dir():
    return os.environ.get("LV_DATA_DIR") or BASE


def config_path():
    return os.path.join(_data_dir(), "domestic-config.json")


def _read_config():
    p = config_path()
    out = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG))  # 深拷贝默认
    if os.path.isfile(p):
        try:
            cfg = json.load(open(p, encoding="utf-8"))
            if isinstance(cfg, dict):
                for k in ("sms", "proxy", "deploy"):
                    if isinstance(cfg.get(k), dict):
                        out[k].update(cfg[k])
        except Exception:
            pass
    return out


def _write_config(cfg):
    p = config_path()
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def get_config():
    return {"ok": True, "config": _read_config()}


def set_sms_config(apiBase, apiUser, apiPass, projectId):
    cfg = _read_config()
    cfg["sms"] = {
        "apiBase": (apiBase or DEFAULT_DOMESTIC_CONFIG["sms"]["apiBase"]).strip(),
        "apiUser": (apiUser or "").strip(),
        "apiPass": (apiPass or "").strip(),
        "projectId": int(projectId) if str(projectId).strip() else DEFAULT_DOMESTIC_CONFIG["sms"]["projectId"],
    }
    _write_config(cfg)
    return {"ok": True}


def set_proxy_config(ptype, host, port, user, pw):
    cfg = _read_config()
    cfg["proxy"] = {
        "type": (ptype or "socks5").strip(),
        "host": (host or "").strip(),
        "port": str(port or "").strip(),
        "user": (user or "").strip(),
        "pass": (pw or "").strip(),
    }
    _write_config(cfg)
    return {"ok": True}


def _to_int(v, default, lo, hi):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def set_deploy_config(verify, retry, smsTimeoutSec, smsMaxRent):
    """保存部署策略开关（面板上的「部署策略」卡）。字段超范围会被夹到安全区间。"""
    cfg = _read_config()
    d = cfg.get("deploy") or {}
    d["verify"] = verify if isinstance(verify, bool) else str(verify).strip().lower() in ("1", "true", "on", "yes", "是")
    d["retry"] = _to_int(retry, DEFAULT_DOMESTIC_CONFIG["deploy"]["retry"], 0, 5)
    d["smsTimeoutSec"] = _to_int(smsTimeoutSec, DEFAULT_DOMESTIC_CONFIG["deploy"]["smsTimeoutSec"], 30, 900)
    d["smsMaxRent"] = _to_int(smsMaxRent, DEFAULT_DOMESTIC_CONFIG["deploy"]["smsMaxRent"], 1, 10)
    cfg["deploy"] = d
    _write_config(cfg)
    return {"ok": True, "deploy": d}


def test_sms():
    """用配置里的账密登录豪猪、查余额，返回 {ok, balance, error}。"""
    cfg = _read_config()["sms"]
    if not cfg.get("apiUser") or not cfg.get("apiPass"):
        return {"ok": False, "error": "未填写接码平台账号/密码"}
    try:
        import urllib.request, urllib.parse
        base = (cfg.get("apiBase") or DEFAULT_DOMESTIC_CONFIG["sms"]["apiBase"]).rstrip("/")
        url = base + "/sms/?api=login&user=" + urllib.parse.quote(cfg["apiUser"]) + "&pass=" + urllib.parse.quote(cfg["apiPass"])
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode("utf-8", errors="replace"))
        if str(j.get("code")) not in ("0", "200"):
            return {"ok": False, "error": "豪猪登录失败: " + json.dumps(j, ensure_ascii=False)}
        token = j.get("token")
        if not token:
            return {"ok": False, "error": "豪猪登录返回无 token: " + json.dumps(j, ensure_ascii=False)}
        url2 = base + "/sms/?api=getSummary&token=" + urllib.parse.quote(token)
        req2 = urllib.request.Request(url2, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req2, timeout=10) as r:
            j2 = json.loads(r.read().decode("utf-8", errors="replace"))
        return {"ok": True, "balance": j2.get("money"), "summary": j2}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def test_proxy(ptype, host, port, user, pw):
    """复用国际版 core.Api.test_proxy（如已加载），否则做一次最小连通性检查。"""
    try:
        import lv_gui_core as core
        if hasattr(core, "Api"):
            api = core.Api()
            if hasattr(api, "test_proxy"):
                r = api.test_proxy(ptype or "socks5", host or "", str(port or ""), user or "", pw or "")
                return r if isinstance(r, dict) else {"ok": True, "data": r}
        if hasattr(core, "normalize_proxy"):
            p = core.normalize_proxy(ptype or "socks5", host or "")
            return {"ok": True, "proxy": p}
        return {"ok": True, "note": "代理设置已保存（未实际测出口）"}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def sms_balance():
    return test_sms()


# ---- 国内版部署指令（与国际版 _deploy_msg.txt 同模式）----
def _dom_deploy_msg_path():
    return os.path.join(_data_dir(), DOMESTIC_DEPLOY_MSG_FILE)


def get_deploy_msg():
    p = _dom_deploy_msg_path()
    saved = False
    text = ""
    if os.path.isfile(p):
        try:
            text = open(p, encoding="utf-8").read().strip()
            saved = bool(text)
        except Exception:
            pass
    if not text:
        text = DOMESTIC_DEPLOY_MSG_DEFAULT
    return {"ok": True, "text": text, "saved": saved}


def set_deploy_msg(text):
    p = _dom_deploy_msg_path()
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write((text or "").strip() + "\n")
    return {"ok": True, "len": len((text or "").strip())}


def reset_deploy_msg():
    p = _dom_deploy_msg_path()
    try:
        if os.path.isfile(p):
            os.remove(p)
    except Exception:
        pass
    return {"ok": True, "text": DOMESTIC_DEPLOY_MSG_DEFAULT}


def _env_from_config(cfg):
    """把国内版配置转成子进程环境变量（SMS+proxy）。"""
    env = {}
    sms = (cfg or {}).get("sms") or {}
    if sms.get("apiBase"):
        env["LIGHTVELA_SMS_API_BASE"] = sms["apiBase"]
    if sms.get("apiUser"):
        env["LIGHTVELA_SMS_USER"] = sms["apiUser"]
    if sms.get("apiPass"):
        env["LIGHTVELA_SMS_PASS"] = sms["apiPass"]
    if sms.get("projectId"):
        env["LIGHTVELA_SMS_PROJECT_ID"] = str(sms["projectId"])
    px = (cfg or {}).get("proxy") or {}
    if px.get("host"):
        env["LIGHTVELA_EGRESS_PROXY"] = json.dumps({
            "type": px.get("type") or "socks5",
            "host": px.get("host"),
            "port": int(px.get("port") or 0),
            "username": px.get("user") or "",
            "password": px.get("pass") or "",
        })
    # 部署策略（面板「部署策略」卡的开关，子进程 bot.js 按 env 解析）
    dep = (cfg or {}).get("deploy") or {}
    if "verify" in dep:
        env["LIGHTVELA_VERIFY"] = "1" if dep["verify"] else "0"
    if "retry" in dep:
        env["LIGHTVELA_DEPLOY_RETRY"] = str(int(dep["retry"]))
    if dep.get("smsTimeoutSec"):
        env["LIGHTVELA_SMS_CODE_TIMEOUT_MS"] = str(int(dep["smsTimeoutSec"]) * 1000)
    if dep.get("smsMaxRent"):
        env["LIGHTVELA_SMS_MAX_RENT"] = str(int(dep["smsMaxRent"]))
    return env


def token_path():
    """国内版凭证文件：与国际版 lv-tokens.json 隔离。"""
    d = os.environ.get("LV_DATA_DIR") or BASE
    return os.path.join(d, "domestic-tokens.json")


def token_nd_path():
    return re.sub(r"\.json$", ".ndjson", token_path())


def _read_tokens():
    """读取国内版凭证：优先 .ndjson（并发追加的权威源），按 idCard 合并；兼容旧单文件 .json。"""
    merged = {}
    nd = token_nd_path()
    if os.path.isfile(nd):
        try:
            with open(nd, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    key = obj.get("idCard") or obj.get("name")
                    if key:
                        merged[key] = obj
        except Exception:
            pass
    if not merged and os.path.isfile(token_path()):
        try:
            merged = json.load(open(token_path(), encoding="utf-8")) or {}
        except Exception:
            merged = {}
    return merged


def parse_accounts(text):
    """解析「姓名 + 身份证」文本（每行一条，姓名与身份证之间可用空格/----/——/|/、/逗号等任意分隔）。
    返回 [{name, idCard}]。优先按 18 位身份证特征抓取，姓名取其前的文字。"""
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        # 身份证：18 位，前 17 位数字、末位为数字或 X
        m = re.search(r"(\d{17}[\dXx])", line)
        if not m:
            continue
        idc = m.group(1)
        # 姓名 = 身份证之前的文字，清掉残留的分隔符/标点
        name = line[:m.start()].strip()
        name = re.sub(r"[\s\-—_|,:，。、；;]+", "", name)
        if not name:
            continue
        out.append({"name": name, "idCard": idc})
    return out


_NOISE_PAT = re.compile(
    r"\[WS\]|\[TAT\]|\[Hermes\]|\[代理\]|\[发送\]|\[回复全文长度|\[回复\]\s*$|"
    r"HTTP/1\.1|TLS 就绪|PtyStart|PtyProxyNew|BSON|字节|session\.create|"
    r"session_id|函数长度|代理通道就绪|WS 握手|Sec-WebSocket"
)

def _is_noise_line(s):
    """底层协议/调试行（WS 帧、TAT 中继、Hermes token、TLS、BSON 等）拦截，不进面板日志。"""
    return bool(_NOISE_PAT.search(s))


# ---- 面板日志精简：业务行里有价值的留、啰嗦的丢、关键的改写 ----
# 订阅阶段里「候选套餐 / 下单 / 老接口」这些中间过程行，对老大没用，直接丢
_SUBSCRIBE_DROP = ("候选套餐", "dianshi/order-and-pay", "POST /v1/passes")
# 建Bot / 模型 / 部署 / REST / 凭证回显 等过程行与回显，丢
_BUILD_DROP = (
    "BOT=", "[建Bot] 复用", "[建Bot] 查询", "[建Bot] POST",
    "[模型] 设主模型", "[部署] 待发消息", "[REST]", "[回复全文长度]",
    "DOMESTIC_CRED_JSON=",
)


def _panel_line(s):
    """面板日志行：返回改写后的文本；返回 None 表示丢。

    老大要求「简洁明快 一目了然」——只保留「正在进行的步骤」：
      ① 协议/调试噪音（_is_noise_line）直接丢；
      ② bot.js 业务行里的中间过程（候选套餐、BOT=、POST /v1、REST、凭证回显…）丢；
      ③ 关键节点改写成人话：
         - [订阅] …复核通过，有效订阅: xxx        →  [订阅] ✅ 复核通过
         - [模型] 主模型已设为: …                 →  正在部署
         - RESULT=OK|deploy_success…              →  ✅ 部署成功
         - RESULT=FAIL|… / RESULT=ERROR|…         →  ❌ 部署失败
    """
    if not s or not s.strip():
        return None
    if _is_noise_line(s):
        return None
    # 业务过程噪音行
    for pat in _BUILD_DROP:
        if pat in s:
            return None
    # 订阅阶段：中间行丢，成功行统一成「[订阅] ✅ 复核通过」
    if s.startswith("[订阅]"):
        if any(p in s for p in _SUBSCRIBE_DROP):
            return None
        if "已有有效订阅" in s or "复核通过" in s:
            return "[订阅] ✅ 复核通过"
        return None  # 其它 [订阅] 行不显示
    # 建Bot 只留最终那一行「[建Bot] 实例=… 最终状态=…」（BOT= 已在上面丢）
    if s.startswith("[建Bot] 实例="):
        return s
    # 模型 / 部署结果
    if s.startswith("[模型] 主模型已设为"):
        return "正在部署"
    if s.startswith("RESULT=OK"):
        return "✅ 部署成功"
    if s.startswith("RESULT=FAIL") or s.startswith("RESULT=ERROR"):
        return "❌ 部署失败"
    # SUBSCRIBE= 状态行（OK/RETRY）丢
    if s.startswith("SUBSCRIBE="):
        return None
    return s


def _append_log(line, prefix=""):
    with _lock:
        _state["log"].append((prefix + line).rstrip("\n"))
        if len(_state["log"]) > 5000:
            _state["log"] = _state["log"][-3500:]


def _run_one(idx, acc, mode, accounts_file):
    """单账号子进程：spawn node bot.js --account-idx idx [--login-only]，实时读日志。"""
    # ★ 全局停止闸门①：线程被调度到时若已停止，连子进程都不起，占位（姓名+身份证）原样保留
    with _lock:
        if not _state["running"]:
            return None
    args = [NODE_BIN, BOT, "--account-idx", str(idx)]
    if mode == "login":
        args.append("--login-only")
    env = dict(os.environ)
    env["LIGHTVELA_ACCOUNTS_FILE"] = accounts_file
    env["LIGHTVELA_DOMESTIC_TOKENS"] = token_path()
    # ★ 注入国内版配置（接码平台账密 / 出口代理），子进程 bot.js 按 env 解析
    env.update(_env_from_config(_read_config()))
    # ★ 部署命令文件路径对齐：面板把部署命令存到数据盘 domestic-deploy-msg.txt，
    #   必须显式告诉 bot.js（否则它默认去脚本目录找 deploy_cmd.txt，容器里没有 → 部署阶段报"文件不存在"）
    env["LIGHTVELA_DEPLOY_FILE"] = _dom_deploy_msg_path()
    log_file = os.path.join(BASE, "run_domestic_%02d_%s.log" % (idx, acc["name"]))
    try:
        fd = open(log_file, "w", encoding="utf-8")
    except Exception:
        fd = None
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, cwd=BASE, text=True, bufsize=1)
    # ★ 全局停止闸门②：Popen 之后到入列之前的窗口里被停止，立即杀掉，不让它跑
    with _lock:
        if not _state["running"]:
            try:
                proc.kill()
            except Exception:
                pass
            if fd:
                fd.close()
            return None
        _state["procs"].append(proc)
    cred = {}
    exit_code = None
    try:
        for line in proc.stdout:
            s = line.rstrip("\n")
            cleaned = _panel_line(s)
            if cleaned is not None:
                _append_log(cleaned, "[%02d %s] " % (idx, acc["name"]))
            if fd:
                fd.write(line)
            m = CRED_RE.search(line)
            if m:
                try:
                    cred = json.loads(m.group(1))
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        if fd:
            fd.close()
    try:
        proc.wait(timeout=PER_ACCT_TIMEOUT)
        exit_code = proc.returncode
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except Exception:
            pass
        exit_code = "TIMEOUT"
    ok = (exit_code == 0)
    res = {
        "idx": idx,
        "name": acc["name"],
        "idCard": acc["idCard"],
        "ok": ok,
        "phone": cred.get("phone"),
        "uid": cred.get("uid"),
        "bearer": cred.get("bearer"),
        "instanceId": None,
        "deployOk": (ok if mode == "full" else None),
        "log": os.path.basename(log_file),
    }
    with _lock:
        while len(_state["results"]) <= idx:
            _state["results"].append(None)
        _state["results"][idx] = res
        _state["done"] += 1
    return res


def _run_thread(accounts, mode):
    tmp = os.path.join(BASE, "accounts_run_tmp.js")
    try:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("module.exports = " + json.dumps(accounts, ensure_ascii=False) + ";\n")
        except Exception as e:
            with _lock:
                _state["running"] = False
            _append_log("写临时账号文件失败: " + str(e))
            return
        total = len(accounts)
        with _lock:
            _state["total"] = total
            _state["done"] = 0
            _state["results"] = [{"idx": i, "name": a["name"], "idCard": a["idCard"]} for i, a in enumerate(accounts)]
            _state["log"] = []
            _state["procs"] = []
        for i in range(0, total, CONCURRENCY):
            # ★ 全局停止：每批开始前检查，停止后不再启动排队账号
            if not _state["running"]:
                break
            batch = []
            for k in range(CONCURRENCY):
                if i + k >= total:
                    break
                # ★ 本批内若中途被停止，也不补起剩余线程
                if not _state["running"]:
                    break
                t = threading.Thread(target=_run_one, args=(i + k, accounts[i + k], mode, tmp), daemon=True)
                batch.append(t)
                t.start()
            for t in batch:
                t.join()
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
        with _lock:
            _state["running"] = False


def start(mode, text, concurrency=None):
    """启动一次运行（后台线程）。mode='login'|'full'。返回 {ok, total}。"""
    accs = parse_accounts(text)
    if not accs:
        return {"ok": False, "error": "没有解析到账号（支持空格/----/——/|/、/逗号等任意分隔，每行一条：姓名 身份证）"}
    with _lock:
        if _state["running"]:
            return {"ok": False, "error": "已有任务在运行，请先停止"}
        if concurrency:
            global CONCURRENCY
            CONCURRENCY = max(1, min(int(concurrency), 20))
        _state["running"] = True
        _state["mode"] = mode
        _state["started_at"] = int(time.time())
        _state["thread"] = threading.Thread(target=_run_thread, args=(accs, mode), daemon=True)
        _state["thread"].start()
    return {"ok": True, "total": len(accs), "mode": mode}


def stop():
    """全局停止：杀掉所有正在跑的子进程，并置 running=False。
    配合 _run_thread 批循环与 _run_one 的 running 闸门，排队中的账号也不会再被启动。"""
    with _lock:
        procs = list(_state["procs"])
        _state["procs"] = []
        _state["running"] = False
    for p in procs:
        try:
            p.kill()
        except Exception:
            pass
    return {"ok": True, "stopped": len(procs)}


def status():
    with _lock:
        return {
            "ok": True,
            "running": _state["running"],
            "mode": _state["mode"],
            "total": _state["total"],
            "done": _state["done"],
            "started_at": _state["started_at"],
            "results": [r for r in _state["results"] if r],
            "logs": list(_state["log"]),
        }


def tokens_info():
    raw = _read_tokens()
    if not raw:
        return {"ok": False, "error": "还没有国内版凭证"}
    return {"ok": True, "count": len(raw), "filename": os.path.basename(token_path())}


def export_tokens_text():
    raw = _read_tokens()
    if not raw:
        return {"ok": False, "error": "还没有国内版凭证"}
    return {"ok": True, "count": len(raw),
            "text": json.dumps(raw, ensure_ascii=False, indent=2),
            "filename": "domestic-tokens-%s.json" % time.strftime("%Y%m%d-%H%M")}


def delete_tokens():
    p = token_path()
    nd = token_nd_path()
    removed = False
    for f in (p, nd):
        if os.path.isfile(f):
            try:
                os.remove(f)
                removed = True
            except Exception:
                pass
    if not removed:
        return {"ok": False, "error": "没有凭证文件"}
    return {"ok": True, "deleted": "all"}
