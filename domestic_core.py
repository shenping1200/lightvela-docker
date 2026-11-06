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
- 并发由本模块用多平台 worker 线程池控制：总并行 = 各「启用」接码平台并发数之和
  （A=5 + B=6 = 11），写入全局 CONCURRENCY 后注入每个 bot.js（供其判定是否开错峰发码）。
  各平台 worker 池彼此隔离、不串台；账号从共享队列单条取走即滑动窗口（非批处理）。
"""
import os
import json
import time
import re
import threading
import queue
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = os.environ.get("LIGHTVELA_NODE_BIN") or "node"
BOT = os.path.join(BASE, "domestic_lightvela_bot.js")
CONCURRENCY = int(os.environ.get("LIGHTVELA_DOMESTIC_CONCURRENCY") or 5)
PER_ACCT_TIMEOUT = int(os.environ.get("LIGHTVELA_DOMESTIC_TIMEOUT") or 40 * 60)  # 秒

# ★ 2026-11-01 新增：国内版「订购套餐」策略（对齐国际版三档）
#   launch_ai        = 只订 4500 积分的启航 Launch AI（常售罄）
#   launch           = 只订 100 积分的启航 Launch（现货）
#   auto_ai_fallback = 优先 4500，售罄降级 100
#   说明：与「放货监控」的 DOM_BUNDLE_STRATEGIES 是两回事——那个只决定"盯哪个包放货"，
#   这个决定"真正下单时抢哪个包"。由 start() 按前端传来的值覆盖，_run_one 注入子进程 env。
BUNDLE_STRATEGY = "auto_ai_fallback"
BUNDLE_STRATEGY_CHOICES = ("launch_ai", "launch", "auto_ai_fallback")


# ★ 多平台并行：平台 key → 面板日志前缀（中文名）
PROVIDER_LABEL = {
    "haozhuma": "豪猪",
    "feihu": "飞狐",
    "lubansms": "鲁班",
    "jcsms": "疾驰",
}

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
    "finishing": 0,       # ★ 收尾中的账号数：bot 退出后 wait/join/写结果还要几秒，这期间不算"假运行"
}

CRED_RE = re.compile(r"DOMESTIC_CRED_JSON=(\{.*\})")


# ===================== 国内版配置（接码平台账号/密码 + 代理 + 部署指令）=====================
DEFAULT_DOMESTIC_CONFIG = {
    "sms": {
        "provider": "haozhuma",   # 接码平台选择器：haozhuma（默认）| feihu；选哪套哪套生效，两套并存
        "apiBase": "https://api.haozhuma.com",
        "apiUser": "f632fc95683bd65352623febb154ffcae6550a33178a18c65921060810d0571c",
        "apiPass": "284d033beb03583ba15948792383e03683e36a6c90cf0c63a1ca767a2d70c2f6",
        "projectId": 21986,
        # 飞狐接码（与豪猪并存；provider=feihu 时生效）
        "feihu": {
            "apiBase": "http://api.feihu2026.com/api/sms",
            "apiKey": "",
            "apiSecret": "",
            "projectId": "",
        },
        # 鲁班接码（与豪猪/飞狐并存；provider=lubansms 时生效）
        #   鲁班免登录，所有请求直接带 apikey；取号必带 service_id（指定国家+应用，如 +86 中国服务编号）
        "luban": {
            "apiBase": "https://lubansms.com/v2/api",
            "apiKey": "",
            "serviceId": "",
        },
        # 疾驰短信接码（与豪猪/飞狐/鲁班并存；provider=jcsms 时生效）
        #   文档：https://www.jcsms.cc/index/index/apiDoc
        #   鉴权：Header 带 fcToken；取号/取码/释放都靠 project_id（+手机号）定位，没有 request_id
        #   ★ 验证码在返回的 msg 字段里；同一手机号每 5 秒最多查一次；文档无余额接口
        "jcsms": {
            "apiBase": "https://www.jcsms.cc",
            "fcToken": "",
            "projectId": "",
            "engine": "",       # 留空=官方引擎；填 b=引擎B
        },
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
    """读配置返回给前端。★ 2026-10-29（合并自远端）：顺带把四套接码平台
    （豪猪/飞狐/鲁班/疾驰）的段补齐——老配置文件里没有 jcsms 段，前端虽然用
    `|| 默认值` 兜着，但「当前：xx」这类回填会不准。这里只在内存里补，不写盘，
    等用户点保存才落盘。"""
    cfg = _read_config()
    try:
        sms = cfg.get("sms")
        if not isinstance(sms, dict):
            sms = {}
        for k in ("feihu", "luban", "jcsms"):
            if not isinstance(sms.get(k), dict):
                sms[k] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"][k]))
        if "provider" not in sms:
            sms["provider"] = "haozhuma"
        cfg["sms"] = sms
    except Exception:
        pass
    return {"ok": True, "config": cfg}


def set_sms_config(apiBase, apiUser, apiPass, projectId):
    """保存豪猪接码账密（不覆盖 provider / feihu 等并存字段）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    sms["apiBase"] = (apiBase or DEFAULT_DOMESTIC_CONFIG["sms"]["apiBase"]).strip()
    sms["apiUser"] = (apiUser or "").strip()
    sms["apiPass"] = (apiPass or "").strip()
    sms["projectId"] = int(projectId) if str(projectId).strip() else DEFAULT_DOMESTIC_CONFIG["sms"]["projectId"]
    # 保留 provider / feihu 字段，避免覆盖另一套平台配置
    if "provider" not in sms:
        sms["provider"] = "haozhuma"
    if "feihu" not in sms or not isinstance(sms.get("feihu"), dict):
        sms["feihu"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["feihu"]))
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True}


def set_sms_provider(provider):
    """切换接码平台：haozhuma | feihu | lubansms | jcsms（选哪套哪套生效）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    p = str(provider).strip().lower()
    sms["provider"] = p if p in ("feihu", "lubansms", "jcsms") else "haozhuma"
    if "feihu" not in sms or not isinstance(sms.get("feihu"), dict):
        sms["feihu"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["feihu"]))
    if "luban" not in sms or not isinstance(sms.get("luban"), dict):
        sms["luban"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["luban"]))
    if "jcsms" not in sms or not isinstance(sms.get("jcsms"), dict):
        sms["jcsms"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["jcsms"]))
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True, "provider": sms["provider"]}


def set_feihu_config(apiBase, apiKey, apiSecret, projectId):
    """保存飞狐接码配置（apiKey=平台账号，apiSecret=API密钥，projectId=pid）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    fh = sms.get("feihu") or {}
    if apiBase and apiBase.strip():
        fh["apiBase"] = apiBase.strip()
    fh["apiKey"] = (apiKey or "").strip()
    fh["apiSecret"] = (apiSecret or "").strip()
    fh["projectId"] = (projectId or "").strip()
    sms["feihu"] = fh
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True}


def set_luban_config(apiBase, apiKey, serviceId):
    """保存鲁班接码配置（apiKey=平台密钥，serviceId=+86 中国服务编号）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    lb = sms.get("luban") or {}
    if apiBase and apiBase.strip():
        lb["apiBase"] = apiBase.strip()
    lb["apiKey"] = (apiKey or "").strip()
    lb["serviceId"] = (serviceId or "").strip()
    sms["luban"] = lb
    # 保留 provider / feihu / haozhuma 字段，避免覆盖另外两套平台配置
    if "provider" not in sms:
        sms["provider"] = "haozhuma"
    if "feihu" not in sms or not isinstance(sms.get("feihu"), dict):
        sms["feihu"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["feihu"]))
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True}


def set_jcsms_config(apiBase, fcToken, projectId, engine=""):
    """保存疾驰短信接码配置（fcToken=平台 Token，projectId=项目 ID，engine 留空=官方引擎）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    jc = sms.get("jcsms") or {}
    if apiBase and apiBase.strip():
        jc["apiBase"] = apiBase.strip()
    jc["fcToken"] = (fcToken or "").strip()
    jc["projectId"] = str(projectId or "").strip()
    jc["engine"] = (engine or "").strip().lower()
    sms["jcsms"] = jc
    # 保留 provider / feihu / luban / haozhuma 字段，避免覆盖其他几套平台配置
    if "provider" not in sms:
        sms["provider"] = "haozhuma"
    if "feihu" not in sms or not isinstance(sms.get("feihu"), dict):
        sms["feihu"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["feihu"]))
    if "luban" not in sms or not isinstance(sms.get("luban"), dict):
        sms["luban"] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"]["luban"]))
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True}


def _claims_path():
    """接码平台认领表（跨轮保留）：记录每个账号成功用过的平台，防重跑时另一家重复取号。"""
    return os.path.join(_data_dir(), "domestic-sms-claims.json")


_claims_lock = threading.Lock()


def _load_claims():
    p = _claims_path()
    try:
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    return d
    except Exception:
        pass
    return {}


def _save_claims(d):
    with _claims_lock:
        try:
            with open(_claims_path(), "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
        except Exception:
            pass


def set_sms_platforms(enabled, concurrency):
    """设置启用的接码平台列表 + 每平台并发数（多平台并行）。"""
    cfg = _read_config()
    sms = cfg.get("sms") or {}
    valid = ("haozhuma", "feihu", "lubansms", "jcsms")
    en = [str(x).strip().lower() for x in (enabled or []) if str(x).strip().lower() in valid]
    if not en:
        en = ["haozhuma"]
    sms["enabled"] = en
    cc = {}
    for p in valid:
        n = int((concurrency or {}).get(p) or 2)
        cc[p] = max(1, min(int(n), 20))
    sms["concurrency"] = cc
    sms["provider"] = en[0]   # 兼容旧 provider 字段：首个启用平台作为当前 provider
    for f in ("feihu", "luban", "jcsms"):
        if f not in sms or not isinstance(sms.get(f), dict):
            sms[f] = json.loads(json.dumps(DEFAULT_DOMESTIC_CONFIG["sms"].get(f, {})))
    cfg["sms"] = sms
    _write_config(cfg)
    return {"ok": True, "enabled": en, "concurrency": cc}


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


def test_sms(provider=None):
    """用配置里的账密登录指定平台（豪猪/飞狐/鲁班/疾驰）、查余额，返回 {ok, balance, error}。
    provider 为空时回退到配置里的 provider（多平台并行时前端可逐家传 provider 测）。"""
    cfg = _read_config()["sms"]
    provider = (provider or cfg.get("provider") or "haozhuma").lower()
    if provider == "feihu":
        return test_feihu()
    if provider == "lubansms":
        return test_luban()
    if provider == "jcsms":
        return test_jcsms()
    # —— 豪猪 ——
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


def test_feihu():
    """用配置里的飞狐 apiKey/apiSecret 登录、查余额，返回 {ok, balance, error}。"""
    cfg = (_read_config().get("sms") or {}).get("feihu") or {}
    api_base = (cfg.get("apiBase") or DEFAULT_DOMESTIC_CONFIG["sms"]["feihu"]["apiBase"]).split(",")[0].strip()
    api_key, api_secret = cfg.get("apiKey"), cfg.get("apiSecret")
    if not api_key or not api_secret:
        return {"ok": False, "error": "飞狐未填写 apiKey / API密钥"}
    try:
        import urllib.request, urllib.parse
        base = api_base.rstrip("/")
        url = base + "/login?user=" + urllib.parse.quote(api_key) + "&pass=" + urllib.parse.quote(api_secret)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode("utf-8", errors="replace"))
        if str(j.get("code")) != "200":
            return {"ok": False, "error": "飞狐登录失败: " + json.dumps(j, ensure_ascii=False)}
        token = (j.get("data") or {}).get("token")
        if not token:
            return {"ok": False, "error": "飞狐登录返回无 token: " + json.dumps(j, ensure_ascii=False)}
        url2 = base + "/userInfo?token=" + urllib.parse.quote(token)
        req2 = urllib.request.Request(url2, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req2, timeout=10) as r:
            j2 = json.loads(r.read().decode("utf-8", errors="replace"))
        return {"ok": True, "balance": (j2.get("data") or {}).get("money"), "summary": j2}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def test_luban():
    """用配置里的鲁班 apiKey 查余额，返回 {ok, balance, error}（鲁班免登录，所有请求直接带 apikey）。"""
    cfg = (_read_config().get("sms") or {}).get("luban") or {}
    api_base = (cfg.get("apiBase") or DEFAULT_DOMESTIC_CONFIG["sms"]["luban"]["apiBase"]).rstrip("/")
    api_key = cfg.get("apiKey")
    if not api_key:
        return {"ok": False, "error": "鲁班未填写 apiKey"}
    try:
        import urllib.request, urllib.parse
        url = api_base + "/getBalance?apikey=" + urllib.parse.quote(api_key)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode("utf-8", errors="replace"))
        if str(j.get("code")) != "0":
            return {"ok": False, "error": "鲁班查询失败: " + json.dumps(j, ensure_ascii=False)}
        return {"ok": True, "balance": j.get("balance"), "summary": j}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def test_jcsms():
    """用配置里的疾驰 fcToken 查项目列表，验证 Token 是否有效、项目 ID 是否存在。
    ★ 疾驰文档没有余额接口，所以这里只能验证连通性 + 项目，返回的 balance 是说明文字不是钱。"""
    cfg = (_read_config().get("sms") or {}).get("jcsms") or {}
    api_base = (cfg.get("apiBase") or DEFAULT_DOMESTIC_CONFIG["sms"]["jcsms"]["apiBase"]).rstrip("/")
    token = (cfg.get("fcToken") or "").strip()
    pid = str(cfg.get("projectId") or "").strip()
    if not token:
        return {"ok": False, "error": "疾驰未填写 fcToken（在平台「我的Token」页生成）"}
    try:
        import urllib.request
        url = api_base + "/api/user/projects?page=1&pagesize=100"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "fcToken": token})
        with urllib.request.urlopen(req, timeout=12) as r:
            j = json.loads(r.read().decode("utf-8", errors="replace"))
        if str(j.get("code")) != "1":
            return {"ok": False, "error": "疾驰查询失败: " + json.dumps(j, ensure_ascii=False)}
        items = j.get("data") or []
        if not isinstance(items, list):
            items = []
        if pid:
            hit = next((x for x in items if str(x.get("id")) == pid), None)
            if not hit:
                names = "、".join("%s(id=%s)" % (x.get("project_name"), x.get("id")) for x in items[:10])
                return {"ok": False,
                        "error": "Token 有效，但项目 ID %s 不在列表里。可选：%s" % (pid, names or "（空）"),
                        "projects": items[:20]}
            return {"ok": True, "balance": "（疾驰无余额接口）",
                    "project": hit,
                    "summary": "连通正常，项目「%s」单价 %s" % (hit.get("project_name"), hit.get("money"))}
        return {"ok": True, "balance": "（疾驰无余额接口）", "projects": items[:20],
                "summary": "Token 有效，共 %d 个项目（未填项目 ID）" % len(items)}
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


def sms_balance(provider=None):
    return test_sms(provider)


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


def _fmt_proxy(p):
    """把单个代理配置规整成 bot.js(normalizeProxy) 期望的字段 {type,host,port,username,password}。"""
    if not isinstance(p, dict):
        return None
    host = p.get("host") or p.get("proxyHost") or p.get("proxyServer")
    port = int(p.get("port") or p.get("proxyPort") or 0)
    if not host or not port:
        return None
    return {
        "type": (p.get("type") or p.get("proxyTypeName") or "socks5"),
        "host": host,
        "port": port,
        "username": p.get("username") or p.get("user") or p.get("proxyAccount") or p.get("proxyUserName") or "",
        "password": p.get("password") or p.get("pass") or p.get("proxyPassword") or "",
    }


def _normalize_proxy_cfg(px):
    """把 GUI 的 proxy 配置（dict / list / 字符串）转成 LIGHTVELA_EGRESS_PROXY(JSON)。
    支持：单对象、代理池(数组)、"host:port" 字符串、JSON 字符串。"""
    if isinstance(px, list):
        arr = [_fmt_proxy(x) for x in px]
        arr = [x for x in arr if x]
        return json.dumps(arr) if arr else None
    if isinstance(px, dict):
        f = _fmt_proxy(px)
        return json.dumps(f) if f else None
    if isinstance(px, str):
        s = px.strip()
        if not s:
            return None
        # ① 先尝试当 JSON 解析（可能是数组/对象字符串）
        try:
            return _normalize_proxy_cfg(json.loads(s))
        except Exception:
            pass
        # ② 兜底：host:port / host:port:user:pass / scheme://user:pass@host:port
        body = re.sub(r'^(socks5|http|https)://', '', s)
        hp = body.rsplit(':', 1)
        if len(hp) == 2 and hp[1].isdigit():
            host = hp[0]
            port = int(hp[1])
            user = passwd = ""
            if '@' in host:
                auth, host = host.rsplit('@', 1)
                if ':' in auth:
                    user, passwd = auth.split(':', 1)
            return json.dumps({"type": "socks5", "host": host, "port": port, "username": user, "password": passwd})
    return None


def _env_from_config(cfg):
    """把国内版配置转成子进程环境变量（SMS+proxy）。"""
    env = {}
    sms = (cfg or {}).get("sms") or {}
    provider = (sms.get("provider") or "haozhuma").lower()
    # ★ 平台选择器：选哪套哪套生效（两套凭证都透传，bot.js 按此 env 决定用哪套）
    env["LIGHTVELA_SMS_PROVIDER"] = provider
    if sms.get("apiBase"):
        env["LIGHTVELA_SMS_API_BASE"] = sms["apiBase"]
    if sms.get("apiUser"):
        env["LIGHTVELA_SMS_USER"] = sms["apiUser"]
    if sms.get("apiPass"):
        env["LIGHTVELA_SMS_PASS"] = sms["apiPass"]
    if sms.get("projectId"):
        env["LIGHTVELA_SMS_PROJECT_ID"] = str(sms["projectId"])
    # 飞狐凭证（无论当前是否选中都透传，切换即可生效）
    fh = sms.get("feihu") or {}
    if fh.get("apiBase"):
        env["LIGHTVELA_FEIHU_API_BASE"] = fh["apiBase"]
    if fh.get("apiKey"):
        env["LIGHTVELA_FEIHU_API_KEY"] = fh["apiKey"]
    if fh.get("apiSecret"):
        env["LIGHTVELA_FEIHU_API_SECRET"] = fh["apiSecret"]
    if fh.get("projectId"):
        env["LIGHTVELA_FEIHU_PROJECT_ID"] = str(fh["projectId"])
    # 鲁班凭证（无论当前是否选中都透传，切换即可生效）
    lb = sms.get("luban") or {}
    if lb.get("apiBase"):
        env["LIGHTVELA_LUBAN_API_BASE"] = lb["apiBase"]
    if lb.get("apiKey"):
        env["LIGHTVELA_LUBAN_API_KEY"] = lb["apiKey"]
    if lb.get("serviceId"):
        env["LIGHTVELA_LUBAN_SERVICE_ID"] = str(lb["serviceId"])
    # 疾驰短信凭证（无论当前是否选中都透传，切换即可生效）
    jc = sms.get("jcsms") or {}
    if jc.get("apiBase"):
        env["LIGHTVELA_JCSMS_API_BASE"] = jc["apiBase"]
    if jc.get("fcToken"):
        env["LIGHTVELA_JCSMS_TOKEN"] = jc["fcToken"]
    if jc.get("projectId"):
        env["LIGHTVELA_JCSMS_PROJECT_ID"] = str(jc["projectId"])
    if jc.get("engine"):
        env["LIGHTVELA_JCSMS_ENGINE"] = str(jc["engine"])
    px = (cfg or {}).get("proxy")
    if px:
        env["LIGHTVELA_EGRESS_PROXY"] = _normalize_proxy_cfg(px)
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


# ---------------- 数据中心（凭证中心）对接 2026-10-29 ----------------
# 规则（老大定）：勾了「复用凭证」时，本地令牌库没有的号 → 按身份证号问数据中心，
#   要到的凭证追加写进本地 domestic-tokens.ndjson；bot.js 的 readDomesticToken
#   本来就按 idCard 读这个文件，所以自然复用上，不用重新取号/实名（省钱、不换号）。
#   ★ 国内版数据中心接口与别的平台不同：GET /creds/lookup?platform=domestic&id_card=xxx
#     （不是 username；传 username 会返回 400 id_card required）
CENTER_BASE = os.environ.get("LIGHTVELA_CENTER", "http://43.167.192.48:18090")
CENTER_TOKEN = os.environ.get("LIGHTVELA_CENTER_TOKEN", "lvc-9f3a7d2e6b1c4a85")
CENTER_TIMEOUT = float(os.environ.get("LIGHTVELA_CENTER_TIMEOUT", "6"))


def _center_machine_id():
    """本机标识：环境变量 → 数据目录下 machine-id → 空字符串。"""
    v = (os.environ.get("LIGHTVELA_MACHINE_ID") or "").strip()
    if v:
        return v
    try:
        p = os.path.join(_data_dir(), "machine-id")
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


# ---------------- 上传重试 + 待补传队列（2026-11-06 老大要求）----------------
# ① 当场重试 3 次（1s / 3s / 8s）—— 解决网络抖动
# ② 仍失败 → 落 pending 队列，不丢
# ③ ★ 只有队列非空时才启动补传线程；队列空了线程自己退出（不空转、不占资源）
# ④ 补传超 20 次或滞留超 7 天 → 移入死信池，不再自动重试，但保留可查
_PENDING_PATH = os.path.join(_data_dir(), "center_push_pending.ndjson")
_DEAD_PATH = os.path.join(_data_dir(), "center_push_dead.ndjson")
_PENDING_MAX_TRIES = 20
_PENDING_MAX_DAYS = 7
_PENDING_INTERVAL = 600          # 补传间隔 10 分钟
_pending_lock = threading.Lock()
_pending_worker = None


def _pending_count():
    """待补传条数（文件不存在 = 0）。"""
    try:
        n = 0
        with open(_PENDING_PATH, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
        return n
    except Exception:
        return 0


def pending_stats():
    """给面板用：待补传 / 死信 各多少条。"""
    dead = 0
    try:
        with open(_DEAD_PATH, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    dead += 1
    except Exception:
        pass
    return {"pending": _pending_count(), "dead": dead}


def _center_post(cred, instance_id=None):
    """真正发一次 POST /creds。返回 (ok, err)。不抛异常。"""
    idc = str(cred.get("idCard") or cred.get("id_card") or "").strip()
    bearer = str(cred.get("bearer") or cred.get("token") or "").strip()
    if not (idc and bearer):
        return False, "缺 idCard/bearer"
    if str(os.environ.get("LIGHTVELA_CENTER_PUSH", "1")).strip() == "0":
        return False, "上传开关已关"
    try:
        import urllib.request
        acct_key = str(cred.get("uid") or "").strip() or idc
        payload = {
            "platform": "domestic",
            "account_key": acct_key,
            "token": bearer,
            "name": (cred.get("name") or None),
            "id_card": idc,
            "phone": (cred.get("phone") or None),
            "instance_id": (instance_id or cred.get("instanceId") or cred.get("instance_id") or None),
            "owner": (_center_machine_id() or None),
            "status": "ok",
            "extra": {"uid": (cred.get("uid") or None)},
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            CENTER_BASE + "/creds", data=body,
            headers={"Content-Type": "application/json", "X-Auth-Token": CENTER_TOKEN},
            method="POST")
        with urllib.request.urlopen(req, timeout=CENTER_TIMEOUT) as r:
            code = int(getattr(r, "status", 200))
            return (code == 200), ("" if code == 200 else "HTTP %d" % code)
    except Exception as e:
        return False, repr(e)[:120]


def _pending_add(cred, err, tries=0):
    """上传彻底失败 → 落待补传队列（绝不丢），并确保补传线程起来了。"""
    rec = {
        "uid": str(cred.get("uid") or ""),
        "bearer": str(cred.get("bearer") or ""),
        "name": cred.get("name"),
        "idCard": cred.get("idCard") or cred.get("id_card"),
        "phone": cred.get("phone"),
        "instanceId": cred.get("instanceId") or cred.get("instance_id"),
        "tries": int(tries),
        "first_fail": time.strftime("%Y-%m-%d %H:%M:%S"),
        "last_try": time.strftime("%Y-%m-%d %H:%M:%S"),
        "err": (err or "")[:120],
    }
    try:
        with _pending_lock:
            with open(_PENDING_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        return
    ensure_pending_worker()


def ensure_pending_worker():
    """★ 老大要求：只有队列里有东西、且当前没有补传线程在跑，才启动一个。"""
    global _pending_worker
    with _pending_lock:
        if _pending_worker is not None and _pending_worker.is_alive():
            return
        if _pending_count() <= 0:
            return
        _pending_worker = threading.Thread(target=_pending_loop,
                                           name="center-push-retry", daemon=True)
        _pending_worker.start()


def _pending_loop():
    """补传循环：进来先补一次，之后每 10 分钟一次；队列清空就退出线程（不常驻）。"""
    global _pending_worker
    while True:
        left = _pending_flush()
        if left <= 0:
            with _pending_lock:
                # ★ 再确认一次：flush 收尾这几毫秒里可能又有新失败的条目追加进来，
                #   此时直接退出会导致「队列有货但没线程补」。有就继续跑。
                if _pending_count() > 0:
                    need_more = True
                else:
                    _pending_worker = None
                    need_more = False
            if need_more:
                time.sleep(1)
                continue
            return
        time.sleep(_PENDING_INTERVAL)


def _pending_flush():
    """把队列逐条重试一遍：成功删掉；失败 tries+1；超限进死信。返回剩余条数。

    ★ 并发安全（2026-11-06）：先把队列文件**原子改名**成 .processing 再处理，
      处理期间新失败的条目会追加到新的 pending 文件，不会被本轮写回覆盖。
      （旧写法用 "w" 覆盖，补传那几秒里新失败的条目会被静默抹掉。）
    """
    proc = _PENDING_PATH + ".processing"
    try:
        with _pending_lock:
            if not os.path.exists(_PENDING_PATH):
                return 0
            os.replace(_PENDING_PATH, proc)
    except Exception:
        return _pending_count()
    try:
        with open(proc, encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
    except Exception:
        lines = []
    keep, dead = [], []
    now = time.time()
    for line in lines:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        tries = int(rec.get("tries") or 0)
        try:
            t0 = time.mktime(time.strptime(rec.get("first_fail") or "",
                                           "%Y-%m-%d %H:%M:%S"))
        except Exception:
            t0 = now
        if tries >= _PENDING_MAX_TRIES:
            rec["dead_reason"] = "重试超 %d 次" % _PENDING_MAX_TRIES
            dead.append(rec)
            continue
        if (now - t0) > _PENDING_MAX_DAYS * 86400:
            rec["dead_reason"] = "滞留超 %d 天" % _PENDING_MAX_DAYS
            dead.append(rec)
            continue
        ok, err = _center_post(rec, rec.get("instanceId"))
        if ok:
            continue
        rec["tries"] = tries + 1
        rec["last_try"] = time.strftime("%Y-%m-%d %H:%M:%S")
        rec["err"] = (err or "")[:120]
        keep.append(rec)
    # 写回：追加到新的 pending（本轮期间新失败的条目已经在里面，不会覆盖）
    if keep:
        try:
            with _pending_lock:
                with open(_PENDING_PATH, "a", encoding="utf-8") as f:
                    for r in keep:
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
        except Exception:
            pass
    if dead:
        try:
            with open(_DEAD_PATH, "a", encoding="utf-8") as f:
                for r in dead:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        except Exception:
            pass
    try:
        os.remove(proc)
    except Exception:
        pass
    return _pending_count()


def center_push_cred(cred, instance_id=None):
    """上传一条凭证：当场重试 3 次（1s/3s/8s），仍失败 → 落待补传队列。

    返回 bool（兼容旧调用方：True=已上传，False=失败但已入队，本地也已存）。
    绝不抛异常、绝不影响本次任务。
    """
    if not isinstance(cred, dict):
        return False
    err = ""
    for k, wait in enumerate((1, 3, 8)):
        ok, err = _center_post(cred, instance_id)
        if ok:
            return True
        if k < 2:
            time.sleep(wait)
    _pending_add(cred, err)
    return False


def center_lookup(id_card):
    """按身份证号问数据中心要国内版凭证。连不上/查不到都返回 None（调用方自行回退）。"""
    if not id_card:
        return None
    try:
        import urllib.parse
        import urllib.request
        q = urllib.parse.urlencode({"platform": "domestic", "id_card": id_card})
        req = urllib.request.Request(CENTER_BASE + "/creds/lookup?" + q,
                                     headers={"X-Auth-Token": CENTER_TOKEN})
        with urllib.request.urlopen(req, timeout=CENTER_TIMEOUT) as r:
            d = json.loads(r.read().decode("utf-8"))
        hit = None
        for c in (d.get("creds") or []):
            if c.get("token"):
                hit = c        # ★ 取最后一条（id 最大 = 最新注册的），不是第一条（最老的）
        return hit
    except Exception:
        pass
    return None


def _prefetch_center_creds(accounts):
    """批次开跑前：本地没有的号去数据中心取凭证，取到就追加进本地 ndjson。
    返回 (取到数, 查过数)。任何异常都不影响主流程。"""
    try:
        local = _read_tokens()
    except Exception:
        local = {}
    have = set()
    for k, v in (local or {}).items():
        if k:
            have.add(k)
        if isinstance(v, dict) and v.get("idCard"):
            have.add(v["idCard"])
    got = 0
    asked = 0
    nd = token_nd_path()
    for a in (accounts or []):
        idc = (a.get("idCard") or "").strip()
        if not idc or idc in have:
            continue
        asked += 1
        c = center_lookup(idc)
        if not c:
            continue
        rec = {"name": c.get("name") or a.get("name") or "",
               "idCard": idc,
               "phone": c.get("phone") or "",
               "uid": c.get("account_key") or "",
               "bearer": c.get("token") or ""}
        if not rec["bearer"]:
            continue
        try:
            with open(nd, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            got += 1
            have.add(idc)
        except Exception:
            pass
    return got, asked


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
    # ★ 根因修复：bot.js 很多行带前导缩进（如「  ✅ 登录成功」「  已发验证码」），
    #   不先 strip 会让下面所有 startswith 判断全部失效（之前 uid/attemptId 尾巴砍不掉就是这原因）
    s = s.strip()
    if _is_noise_line(s):
        return None
    # 业务过程噪音行
    for pat in _BUILD_DROP:
        if pat in s:
            return None
    # 启动头部（单账号模式那行，前缀已有账号名，纯冗余）
    if s.startswith("[单账号模式]"):
        return None
    # 余额行：去掉括号里的充值提示
    if s.startswith("[豪猪] 当前余额"):
        return re.sub(r"\s*[（(].*$", "", s).rstrip()
    # 账号分隔行整行丢：前缀「[00 范益民]」已带账号名，这行纯重复、零信息量
    if s.startswith("===== 账号:"):
        return None
    # 凭证追加行：去掉路径与身份证，只留状态
    if s.startswith("[凭证] 已追加"):
        return "[凭证] 已追加"
    # 订阅阶段：中间行丢，成功行统一成「[订阅] ✅ 复核通过」
    if s.startswith("[订阅]"):
        if any(p in s for p in _SUBSCRIBE_DROP):
            return None
        if "已有有效订阅" in s or "复核通过" in s:
            return "[订阅] ✅ 复核通过"
        return None  # 其它 [订阅] 行不显示
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
    # 「已发验证码: {"cooldownSeconds":60}」——老大要留「已发验证码」这句，只砍冒号后的 JSON 尾巴
    # （下一行「验证码: 893213」才带真码，那行照常保留）
    if "cooldownSeconds" in s:
        return re.sub(r"\s*[:：].*$", "", s)
    # [建Bot] 结果行整行丢：老大明确不要这行（实例ID/最终状态/名称=… 全是无用字符串；
    # 结果表已带实例ID，面板日志只留状态文字即可）。曾一度改成「截短保留」属倒退，已改回。
    if s.startswith("[建Bot]"):
        return None
    # 成功行去掉竖线后的调试尾巴（uid / attemptId 等，对老大没用）
    if s.startswith("✅ 登录成功") or s.startswith("✅ 实名成功"):
        return s.split(" | ")[0]
    # 续跑模式提示行：统一成一句人话（不带 uid/手机号）
    if s.startswith("[续跑]"):
        return "正在续跑（复用已登录凭证）"
    return s


def _append_log(line, prefix=""):
    with _lock:
        _state["log"].append((prefix + line).rstrip("\n"))
        if len(_state["log"]) > 5000:
            _state["log"] = _state["log"][-3500:]


def _hard_kill(proc):
    """杀 bot 子进程，并确认真死了。
    ★ 2026-10-23 实测：TerminateProcess(proc.kill) 在个别场景不生效（bot 线程卡在内核调用里时
      进程会挂起 5 个多小时才自己消失），所以 kill 后等 5 秒，还活着就 taskkill /F /T 补刀。
    """
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
        return
    except Exception:
        pass
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, timeout=15)
    except Exception:
        pass


def _run_one(idx, acc, mode, accounts_file, use_saved=False, provider=None, plat_label=""):
    """单账号子进程：spawn node bot.js --account-idx idx [--login-only]，实时读日志。
    ★ 多平台并行：provider 指定本账号用哪套接码平台（写入 env LIGHTVELA_SMS_PROVIDER，
      bot.js 据此选平台）；plat_label 是日志前缀（如 [飞狐]），用于面板区分平台。"""
    # ★ 全局停止闸门①：线程被调度到时若已停止，连子进程都不起，占位（姓名+身份证）原样保留
    with _lock:
        if not _state["running"]:
            return None
    args = [NODE_BIN, BOT, "--account-idx", str(idx)]
    if mode == "login":
        args.append("--login-only")
    # ★ 2026-11-06 修复（老大定的）：只有「续跑」才复用本地凭证。
    #   做新号时若传 --resume，js 会按身份证去本地 ndjson 捞"这个人之前的号码"的凭证复用，
    #   同一身份证的第二个号码就被顶掉、压根没注册（今天 3,451 个凭证丢失的主因）。
    if mode == "resume":
        args.append("--resume")   # 续跑：复用已登录凭证，跳过取号/登录/实名
    env = dict(os.environ)
    env["LIGHTVELA_ACCOUNTS_FILE"] = accounts_file
    env["LIGHTVELA_DOMESTIC_TOKENS"] = token_path()
    # ★ 注入国内版配置（接码平台账密 / 出口代理），子进程 bot.js 按 env 解析
    env.update(_env_from_config(_read_config()))
    # ★ 多平台并行：本账号指定接码平台，注入 env 让 bot.js 选对应平台（豪猪/飞狐/鲁班/疾驰）
    if provider:
        env["LIGHTVELA_SMS_PROVIDER"] = str(provider).lower()
    # ★ 部署命令文件路径对齐：面板把部署命令存到数据盘 domestic-deploy-msg.txt，
    #   必须显式告诉 bot.js（否则它默认去脚本目录找 deploy_cmd.txt，容器里没有 → 部署阶段报"文件不存在"）
    env["LIGHTVELA_DEPLOY_FILE"] = _dom_deploy_msg_path()
    # ★ 把并发数传给 bot.js：仅当并发>1 时才启用发码错峰门控（单账号无需错峰）
    env["LIGHTVELA_DOMESTIC_CONCURRENCY"] = str(CONCURRENCY)
    # ★ 2026-11-01：把「订购套餐策略」传给 bot.js（launch_ai / launch / auto_ai_fallback）
    #   bot.js 据此决定抢哪个 0 元包；未设时 bot.js 自身也按 auto_ai_fallback 兜底
    env["LIGHTVELA_BUNDLE_STRATEGY"] = BUNDLE_STRATEGY
    log_file = os.path.join(BASE, "run_domestic_%02d_%s.log" % (idx, acc["name"]))
    # ★ 仅清空上一轮日志；本轮日志改由 bot 经 LIGHTVELA_LOG_FILE 自写（父进程 webapp 被重启也不丢、bot 还能跑完）
    try:
        with open(log_file, "w", encoding="utf-8"):
            pass
    except Exception:
        pass
    env["LIGHTVELA_LOG_FILE"] = log_file
    # ★ 2026-10-23 修复（重大根因）：text=True 不传 encoding 时按系统 locale 解码，
    #   中文 Windows（计划任务环境，无 UTF-8 mode）= GBK/cp936；bot 输出的是 UTF-8 中文，
    #   _reader 读到第一行中文就抛 UnicodeDecodeError → 被 except 吞掉 → reader 线程静默死亡
    #   → 面板日志只剩 [已启动]；管道没人读被填满后 bot 同步写管道永久阻塞（JS 线程卡死），
    #   最终被看门狗误杀。必须显式 UTF-8 + errors=replace（Node 输出恒为 UTF-8）。
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, cwd=BASE, text=True, encoding="utf-8", errors="replace", bufsize=1)
    # ★ 全局停止闸门②：Popen 之后到入列之前的窗口里被停止，立即杀掉，不让它跑
    with _lock:
        if not _state["running"]:
            try:
                proc.kill()
            except Exception:
                pass
            return None
        _state["procs"].append(proc)
    cred = {}
    exit_code = None
    # ★ 部署阶段区间压缩：打印「正在部署」后，直到最终的 ✅/❌ 判定行之前，
    #   中间的「安装脚本/部署报告/检测结果」等过程行一律不进面板（仍写文件备查）。
    in_deploy = False
    last_output = [time.time()]          # 静默看门狗：记录最近一次收到子进程输出的时间
    fail_reason = [None]                 # 捕获 bot.js 打印的「❌ 账号失败: ...」原因
    log_done = threading.Event()

    def _reader():
        nonlocal in_deploy
        try:
            for line in proc.stdout:
                last_output[0] = time.time()
                s = line.rstrip("\n")
                if "❌ 账号失败:" in s:
                    fail_reason[0] = s.split("❌ 账号失败:", 1)[1].strip()
                if in_deploy:
                    # 部署过程中：只放行最终判定行，其余（安装输出/部署报告/检测明细）全丢
                    if s.startswith("RESULT=OK"):
                        cleaned = "✅ 部署成功"; in_deploy = False
                    elif s.startswith("RESULT=FAIL") or s.startswith("RESULT=ERROR"):
                        cleaned = "❌ 部署失败"; in_deploy = False
                    else:
                        cleaned = None
                else:
                    cleaned = _panel_line(s)
                    if cleaned == "正在部署":
                        in_deploy = True  # 进入部署阶段，后续过程行压掉
                if cleaned is not None:
                    _append_log(cleaned, "[%s][%02d %s] " % (plat_label or "?", idx, acc["name"]))
                m = CRED_RE.search(line)
                if m:
                    try:
                        cred.update(json.loads(m.group(1)))
                    except Exception:
                        pass
        except Exception as e:
            # ★ 2026-10-23：reader 死掉绝不能静默——以前这里 except: pass 吞掉一切，
            #   面板看不出任何异常；且 reader 死后没人读管道，bot 同步写满 64KB 管道缓冲区后
            #   会永久阻塞（JS 线程卡死）→ 被看门狗误杀。现在：① 面板可见真实原因；
            #   ② 自动起保底排水线程继续抽干管道，bot 绝不因管道满而卡死。
            _append_log("[系统] 日志读取线程异常（已切换保底排水，bot 不会卡死）: %r" % (e,), "")
            def _drain():
                try:
                    while True:
                        chunk = proc.stdout.read(4096)
                        if not chunk:
                            break
                except Exception:
                    pass
            try:
                threading.Thread(target=_drain, daemon=True).start()
            except Exception:
                pass
        finally:
            log_done.set()

    rt = threading.Thread(target=_reader, daemon=True)
    rt.start()

    # ★ 看门狗：整体超时(PER_ACCT_TIMEOUT) + 静默超时(子进程长时间不出任何输出) + 用户停止
    #   三者任一触发立即杀掉子进程，避免某个账号卡死把整批(batch)拖死、面板“不再往下进行”。
    overall_deadline = time.time() + PER_ACCT_TIMEOUT
    silence_timeout = float(os.environ.get("LIGHTVELA_ACCT_SILENCE_TIMEOUT") or 600)  # 默认10分钟静默判定
    killed = None
    while True:
        rc = proc.poll()
        if rc is not None:
            break
        now = time.time()
        if now > overall_deadline:
            killed = "TIMEOUT"
            break
        if now - last_output[0] > silence_timeout:
            killed = "TIMEOUT_SILENCE"
            break
        if not _state["running"]:
            killed = "STOPPED"
            break
        time.sleep(1)
    # ★ 2026-10-23：进入收尾窗口。bot 进程已退出（或将被杀），但 wait/join/写结果还要几秒，
    #   这期间 procs 已空——status() 的"假运行纠正"若此时抢跑，前端会立刻打出
    #   「[全部结束] 完成 0 / 1」（结果还没写上），几秒后才悄悄变成 1/1。用 finishing 计数挡住。
    with _lock:
        _state["finishing"] += 1
    try:
        if killed:
            _hard_kill(proc)
            exit_code = killed
        else:
            try:
                proc.wait(timeout=10)
                exit_code = proc.returncode
            except Exception:
                _hard_kill(proc)
                exit_code = "TIMEOUT"
        try:
            rt.join(timeout=5)
        except Exception:
            pass
        ok = (exit_code == 0)
        if ok:
            err_msg = None
        elif fail_reason[0]:
            err_msg = fail_reason[0]
        elif exit_code == "TIMEOUT":
            err_msg = "执行超时（超过 %d 分钟）" % (PER_ACCT_TIMEOUT // 60)
        elif exit_code == "TIMEOUT_SILENCE":
            err_msg = "子进程长时间无响应，已被看门狗终止"
        elif exit_code == "STOPPED":
            err_msg = "用户手动停止"
        else:
            err_msg = "执行失败（详见日志）"
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
            "error": err_msg,
            "log": os.path.basename(log_file),
        }
        # ★ 2026-10-29（合并自远端）：凭证上传数据中心。之前国内版只有「读」，登录/实名拿到的
        #   凭证只落在本机 ndjson，多台机器互相看不见。这里补上「写」——账号一跑完（成功失败
        #   都算，只要拿到 bearer）就推一条，跨机可复用，避免重复登录触发 2FA/接码。
        if cred.get("bearer"):
            try:
                if center_push_cred(cred, res.get("instanceId")):
                    _append_log("[数据中心] ☁ 凭证已上传（%s）" % (acc.get("name") or acc.get("idCard") or ""))
                else:
                    _append_log("[数据中心] ⚠ 凭证上传未成功（本地已存，不影响本次）")
            except Exception:
                pass
        with _lock:
            while len(_state["results"]) <= idx:
                _state["results"].append(None)
            _state["results"][idx] = res
            _state["done"] += 1
        return res
    finally:
        with _lock:
            _state["finishing"] -= 1


def _run_thread(accounts, mode, prelude=None, use_saved=False):
    # ★ 实名补救跨进程协调：每轮运行开头清空上轮残留的「身份占用标记」(domestic-claims.json/lock)，
    #   否则上一轮标记的 consumed/bad 会让本轮同序号（同一人）被误跳过或无法补救。
    #   ★ 注意：接码平台认领表 domestic-sms-claims.json 是「跨轮绑定记忆」，【不清】，只清身份占用标记。
    for _f in ("domestic-claims.json", "domestic-claims.json.lock"):
        try:
            os.remove(os.path.join(BASE, _f))
        except FileNotFoundError:
            pass
        except Exception:
            pass
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
        cfg = _read_config()
        sms = cfg.get("sms") or {}
        valid = ("haozhuma", "feihu", "lubansms", "jcsms")
        enabled = [p for p in (sms.get("enabled") or [sms.get("provider") or "haozhuma"]) if p in valid]
        if not enabled:
            enabled = ["haozhuma"]
        conc = sms.get("concurrency") or {}
        plats = [(p, max(1, int(conc.get(p) or 2))) for p in enabled]   # [(平台, 该平台并发)]
        # ★ 总并行 = 各「启用」平台并发数之和；写入全局 CONCURRENCY 供 _run_one 注入 bot.js。
        #   bot.js 用 _domConc>1 判定是否开错峰发码：总和>1 即自动开（A=5+B=6→11 开，单平台1→不开），
        #   不再需要参数设置里的独立「并发」输入框。各平台 worker 池彼此隔离、不串台（见下方 _worker）。
        global CONCURRENCY
        CONCURRENCY = sum(pconc for _, pconc in plats)
        claims = _load_claims()   # 跨轮记忆：{idx: {provider, ok}}
        with _lock:
            _state["total"] = total
            _state["done"] = 0
            _state["results"] = [{"idx": i, "name": a["name"], "idCard": a["idCard"]} for i, a in enumerate(accounts)]
            # 续跑时 prelude 是「[跳过] 某某：原因」明细，放在日志最前面
            _state["log"] = list(prelude or [])
            _state["procs"] = []
            _state["_plat_info"] = {"enabled": enabled, "concurrency": dict(plats)}
        # ★ 启动新运行前，清掉上一轮 webapp 重启留下的孤儿 bot 进程（命令行含 domestic_lightvela_bot.js）
        kill_orphan_bots()
        # ★ 数据中心取凭证（2026-10-29 新增）：勾了「复用凭证」时，本地令牌库没有的号
        #   按身份证号问数据中心要，要到的追加进本地 ndjson，机器人自然复用上，不用重新取号/实名。
        # ★ 2026-11-06 修复（老大定的）：只有「续跑」才去中心按身份证预取凭证。
        #   勾「复用凭证」做新号时绝不能预取 —— 同一身份证的新号会被老号凭证顶掉，
        #   新号白注册、凭证压根不上传（今天 3,451 个凭证丢失就是这么来的）。
        if mode == "resume":
            try:
                _got, _asked = _prefetch_center_creds(accounts)
                if _asked:
                    _append_log("☁ 数据中心：查了 %d 个号，取到 %d 个凭证" % (_asked, _got))
            except Exception as _e:
                _append_log("⚠ 数据中心预取凭证失败（不影响本次）：%s" % _e)
        # ★ 多平台并行：每启用平台一个 worker 池（池大小=该平台并发数），共享同一账号队列。
        #   账号被某平台 worker 取走即认领（内存 in_flight 防同批重复），成功则落盘绑定（跨轮）。
        #   某平台取号失败 → 放回队列、标记该家试过，由另一家有空位的平台重试（封顶一次防死循环）。
        q = queue.Queue()
        for i in range(total):
            q.put(i)
        in_flight = set()
        in_flight_lock = threading.Lock()
        tried = {}          # idx -> set(已试过的平台)
        tried_lock = threading.Lock()
        def _worker(p, pconc):
            label = PROVIDER_LABEL.get(p, p)
            while True:
                if not _state["running"]:
                    return
                try:
                    idx = q.get(timeout=1)
                except queue.Empty:
                    return   # 队列空，本平台 worker 退出
                acc = accounts[idx]
                # 认领检查：已被别的平台认领 → 放回让别的 worker 处理
                with in_flight_lock:
                    if idx in in_flight:
                        q.put(idx)
                        continue
                    in_flight.add(idx)
                # 跨轮绑定：该账号已成功且绑定原平台（且原平台仍启用）→ 用原平台，不换家
                claim = claims.get(str(idx)) or claims.get(idx)
                use_p = p
                if claim and claim.get("ok") and claim.get("provider") in enabled:
                    use_p = claim["provider"]
                # ★ 绑定到别的平台：当前 worker 不是它家，放回队列让它家 worker 认领，
                #   避免「用 A 家 provider 跑却贴 B 家标签」的错乱（provider 仍正确，只是标签要对应）
                if use_p != p:
                    with in_flight_lock:
                        in_flight.discard(idx)
                    q.put(idx)
                    continue
                # 本平台已试过该账号（失败）→ 换下一平台，放回队列
                with tried_lock:
                    tset = tried.setdefault(idx, set())
                    if use_p == p and p in tset:
                        with in_flight_lock:
                            in_flight.discard(idx)
                        q.put(idx)
                        continue
                _append_log("领取账号 %02d %s" % (idx, acc["name"]), "[%s] " % label)
                res = _run_one(idx, acc, mode, tmp, use_saved, provider=use_p, plat_label=label)
                if res and res.get("ok"):
                    claims[str(idx)] = {"provider": use_p, "name": acc["name"], "idCard": acc["idCard"], "ok": True}
                    _save_claims(claims)
                    with in_flight_lock:
                        in_flight.discard(idx)
                    continue
                # 失败：标记本平台试过，若还有未试平台则放回重试，否则标记最终失败
                with tried_lock:
                    tset = tried.setdefault(idx, set())
                    tset.add(p)
                    if len(tset) < len(plats):
                        with in_flight_lock:
                            in_flight.discard(idx)
                        q.put(idx)        # 放回队列，其他平台 worker 抢
                        continue
                    claims[str(idx)] = {"provider": use_p, "name": acc["name"], "idCard": acc["idCard"], "ok": False, "tried": list(tset)}
                    _save_claims(claims)
                    with in_flight_lock:
                        in_flight.discard(idx)
        threads = []
        for p, pconc in plats:
            for _ in range(pconc):
                t = threading.Thread(target=_worker, args=(p, pconc), daemon=True)
                threads.append(t)
                t.start()
        for t in threads:
            t.join()           # 等所有在飞账号收尾（停止时也等它们退出）
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
        with _lock:
            # ★ 2026-10-24：整轮跑完也兜一次底——中途被停止闸门跳过的账号（提前 return None）
            #   如果日志里其实已经跑出结果了，把格子补上，别留在「等待中」
            _backfill_pending_results()
            _state["running"] = False


def _resume_pick(accs):
    """续跑筛选（老大 2026-10-17 定）：必须三条同时满足才跑——
       ① 账号区（面板粘贴的清单）里有这个人
       ② 已保存凭证里有这个人（有凭证 = 已实名完成，因为凭证是实名通过后才落盘的）
       ③ 这个人上一轮是「部署失败」
       其余一律不跑。返回 (可跑列表, [(姓名, 不跑原因), ...])。
    """
    saved = _read_tokens()          # {idCard: 该账号最后一条记录}（按身份证合并，后写覆盖先写）
    run, skip = [], []
    for a in accs:
        idc = a.get("idCard")
        rec = saved.get(idc) if idc else None
        if not rec:
            skip.append((a.get("name"), "凭证里没有他"))
            continue
        ok = rec.get("deployOk")
        if ok is True:
            skip.append((a.get("name"), "已部署成功"))
            continue
        if ok is False:
            run.append(a)
            continue
        skip.append((a.get("name"), "没跑过部署"))   # deployOk 缺失 = 只做了登录/实名，没做后续
    return run, skip


def start(mode, text, use_saved=False, bundle_strategy="auto_ai_fallback"):
    """启动一次运行（后台线程）。mode='login'|'full'|'resume'。返回 {ok, total}。

    并发数不再由参数设置框单独输入：总并行 = 各启用接码平台并发数之和，
    在 _run_thread 里算好后写入全局 CONCURRENCY，再注入每个 bot.js 子进程
    （bot.js 据此决定是否开启错峰发码：总和>1 即开）。

    bundle_strategy：订购套餐策略（对齐国际版三档）。只对 mode='full'/'resume' 有意义，
    'login' 模式不下单、忽略此参数。非法值回退 auto_ai_fallback。
    """
    global BUNDLE_STRATEGY
    _bs = (bundle_strategy or "auto_ai_fallback").strip()
    BUNDLE_STRATEGY = _bs if _bs in BUNDLE_STRATEGY_CHOICES else "auto_ai_fallback"
    # ★ 2026-11-06：上次有没传上去的凭证，这里把补传线程拉起来（队列空则什么都不做，不占资源）
    try:
        ensure_pending_worker()
    except Exception:
        pass
    accs = parse_accounts(text)
    if not accs:
        return {"ok": False, "error": "没有解析到账号（支持空格/----/——/|/、/逗号等任意分隔，每行一条：姓名 身份证）"}
    # ★ 续跑：先把账号区名单拿去跟已保存凭证比对，只留「两边都有 + 上轮部署失败」的
    prelude = []
    if mode == "resume":
        accs, skipped = _resume_pick(accs)
        prelude = ["[跳过] %s：%s" % (nm, why) for nm, why in skipped]
        if not accs:
            brief = "；".join("%s(%s)" % (nm, why) for nm, why in skipped[:8])
            return {"ok": False, "error": "没有符合续跑条件的账号（须同时满足：账号区有 + 凭证里有 + 上轮部署失败）。共 %d 个被跳过：%s"
                    % (len(skipped), brief)}
    with _lock:
        if _state["running"]:
            return {"ok": False, "error": "已有任务在运行，请先停止"}
        _state["running"] = True
        _state["mode"] = mode
        _state["started_at"] = int(time.time())
        _state["thread"] = threading.Thread(target=_run_thread, args=(accs, mode, prelude, use_saved), daemon=True)
        _state["thread"].start()
    return {"ok": True, "total": len(accs), "mode": mode}


def kill_orphan_bots():
    """启动新运行前，清掉上一轮 webapp 重启留下的孤儿 bot 进程（命令行含 domestic_lightvela_bot.js）。
    返回清理掉的进程数；出错时记日志并返回 0。"""
    try:
        out = subprocess.run(
            ["wmic", "process", "where",
             "name='node.exe' and commandline like '%domestic_lightvela_bot.js%'",
             "get", "processid"],
            capture_output=True, text=True,
        ).stdout
        pids = [ln.strip() for ln in out.splitlines() if ln.strip().isdigit()]
        killed = 0
        for pid in pids:
            try:
                subprocess.run(["taskkill", "/PID", pid, "/F", "/T"], capture_output=True, text=True)
                killed += 1
            except Exception:
                pass
        if killed:
            _append_log("[清理] 已结束 %d 个上一轮遗留的孤儿 bot 进程" % killed)
        return killed
    except Exception as e:
        _append_log("[清理] 孤儿进程清理失败: " + str(e))
        return 0


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


def _backfill_pending_results():
    """★ 2026-10-24 新增：把「日志里明明成功、格子里却显示等待中」的账号回填进结果表。

    成因：某些账号的收尾回执还没写回结果表，运行状态就被判结束了（假运行纠正触发 /
    停止闸门提前 return None），那个格子就一直停在只有「姓名+身份证」的占位状态
    → 面板显示「等待中」，完成计数也少一个（老大 2026-10-24 反馈何利丹这一例）。

    依据：**只认本轮机器人自己写的运行日志** run_domestic_序号_姓名.log，且修改时间必须
    晚于本轮开始时间。绝不拿凭证文件去判成败——凭证是跨轮累积的，拿它回填会把上一轮的
    成功错记到这一轮头上（张华这类"上一轮成、这一轮败"的会被误判成成功）。
      - 日志里有 RESULT=OK                                        → 部署成功
      - 日志里有 RESULT=FAIL / RESULT=ERROR / [RUNFAIL] / ❌ 账号失败 → 部署失败
      - 只登录模式：日志里有「登录成功」                            → 登录成功
      - 以上都没有 → 说明真没跑完，不瞎猜，保持「等待中」
    凭证文件只用来补手机号 / 实例号这些展示字段。
    调用方必须已经持有 _lock。返回回填的格子数。
    """
    started = int(_state.get("started_at") or 0)
    mode = _state.get("mode")
    try:
        saved = _read_tokens() or {}
    except Exception:
        saved = {}
    filled = 0
    for r in _state["results"]:
        if not r or r.get("ok") is not None:      # 已落定的不碰
            continue
        lp = os.path.join(BASE, "run_domestic_%02d_%s.log" % (int(r.get("idx") or 0), r.get("name") or ""))
        if not os.path.isfile(lp):
            continue
        try:
            if started and int(os.path.getmtime(lp)) < started - 5:
                continue                          # 不是本轮写的日志，不认
            txt = open(lp, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        if mode == "login":
            if "登录成功" not in txt:
                continue                          # 登录都没成，不瞎写
            ok, err = True, None
        elif "RESULT=OK" in txt:
            ok, err = True, None
        elif ("RESULT=FAIL" in txt or "RESULT=ERROR" in txt
              or "[RUNFAIL]" in txt or "❌ 账号失败" in txt):
            ok, err = False, "部署失败（从本轮运行日志回填）"
        else:
            continue                              # 看不出结果，不瞎写
        rec = saved.get(r.get("idCard")) or {}
        r["ok"] = ok
        r["error"] = err
        r["phone"] = rec.get("phone")
        r["uid"] = rec.get("uid")
        r["bearer"] = rec.get("bearer")
        r["instanceId"] = rec.get("instanceId") if mode != "login" else None
        r["deployOk"] = (True if ok else False) if mode != "login" else None
        r["log"] = os.path.basename(lp)
        _state["done"] += 1
        filled += 1
    if filled:
        _state["log"].append("[系统] 已从本轮运行日志回填 %d 个卡在「等待中」的格子" % filled)
    return filled


def status():
    with _lock:
        # ★ 防御：标记在跑但已无存活子进程（如 webapp 重启后子进程变孤儿），纠正为假运行，避免面板一直显示"进行中"
        #   ★ 2026-10-23：必须排除"收尾窗口"——bot 退出后 _run_one 还要花几秒 wait/join/写结果，
        #      这期间 procs 已空但结果没落定，若此时纠正 running，前端会立刻打出错误的
        #      「[全部结束] 完成 0 / 1」。finishing>0 = 有账号正在收尾，一律不纠正。
        if _state["running"]:
            alive = [p for p in _state["procs"] if p.poll() is None] if _state["procs"] else []
            # ★ 2026-10-24：批次空档闸——批循环总管线程（_state["thread"]）还活着，
            #   说明整轮还在正常跑；此刻 procs 为空只是"上一批刚 join 完、下一批还没 spawn"
            #   的瞬间空档，一律不许判结束。只有总管线程也死了（真卡死 / webapp 重启），
            #   才允许纠正。这一道闸同时堵住"批次空档"和"收尾空档"两类误判结束。
            _master_alive = bool(_state.get("thread") and _state["thread"].is_alive())
            if not _master_alive and not alive and _state.get("finishing", 0) == 0 and (int(time.time()) - (_state["started_at"] or 0)) > 10:
                _state["running"] = False
                _state["log"].append("[系统] 检测到子进程已全部退出（可能 webapp 重启导致），已自动纠正运行状态")
                # ★ 2026-10-24：宣布结束前，先把「日志里已成功、格子里还是等待中」的账号补上，
                #   免得真成功的账号被当成没跑，老大还得翻日志才知道真假
                _backfill_pending_results()
        return {
            "ok": True,
            "running": _state["running"],
            "mode": _state["mode"],
            "total": _state["total"],
            "done": _state["done"],
            "started_at": _state["started_at"],
            "results": [r for r in _state["results"] if r],
            "logs": list(_state["log"]),
            "enabled": (_state.get("_plat_info") or {}).get("enabled"),
            "concurrency": (_state.get("_plat_info") or {}).get("concurrency"),
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


# ==========================================================================
# 国内版放货监控 2026-10-30
# ★ 照搬国际版 lv_gui_core.py 的 Monitor + TG 模块，只有三处不同：
#   ① 域名：api.lightvela.ai（国际版）→ api.lightvela.com（国内版）
#   ② 认证：GitHub token → 国内版 bearer（复用 domestic-tokens.ndjson 已存凭证）
#   ③ TG：token/chat_id 沿用国际版 lv-tg.json；推送开关各管各的（domestic-tg.json）
# ==========================================================================
DOM_API = "https://api.lightvela.com"          # ★ 国内版（国际版是 .ai）
DOM_BUNDLE_LAUNCH_AI = "bundle_launch_ai_01"   # 4500 积分
DOM_BUNDLE_LAUNCH = "bundle_launch_01"         # 100 积分
DOM_BUNDLE_STRATEGIES = {
    "launch_ai":        (DOM_BUNDLE_LAUNCH_AI, None),           # 只盯 4500
    "launch":           (DOM_BUNDLE_LAUNCH, None),              # 只盯 100
    "auto_ai_fallback": (DOM_BUNDLE_LAUNCH_AI, DOM_BUNDLE_LAUNCH),  # 优先4500，降级100
}
INTL_TG_FILE = "lv-tg.json"        # 沿用国际版：token / chat_id
DOM_TG_FILE = "domestic-tg.json"   # 国内版独有：只存 enabled 开关


def _intl_tg_path():
    d = os.environ.get("LV_DATA_DIR") or BASE
    return os.path.join(d, INTL_TG_FILE)


def _dom_tg_path():
    d = os.environ.get("LV_DATA_DIR") or BASE
    return os.path.join(d, DOM_TG_FILE)


def dom_tg_config():
    """国内版 TG 配置：token/chat_id 沿用国际版 lv-tg.json，enabled 用国内版独立开关。"""
    cfg = {"token": "", "chat_id": "", "enabled": True}
    try:
        p = _intl_tg_path()
        if os.path.isfile(p):
            d = json.load(open(p, encoding="utf-8"))
            if isinstance(d, dict):
                cfg["token"] = str(d.get("token") or "").strip()
                cfg["chat_id"] = str(d.get("chat_id") or "").strip()
    except Exception:
        pass
    try:
        p = _dom_tg_path()
        if os.path.isfile(p):
            d = json.load(open(p, encoding="utf-8"))
            if isinstance(d, dict) and "enabled" in d:
                cfg["enabled"] = bool(d["enabled"])
    except Exception:
        pass
    return cfg


def dom_tg_set_enabled(enabled):
    """只改国内版自己的推送开关，绝不碰国际版 lv-tg.json。返回 dict（接口层要求）。"""
    try:
        with open(_dom_tg_path(), "w", encoding="utf-8") as f:
            json.dump({"enabled": bool(enabled)}, f, ensure_ascii=False, indent=2)
        return {"ok": True, "enabled": bool(enabled)}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def _dom_http(method, url, data=None, headers=None, proxy_url=None, timeout=25):
    """发请求：直连优先；给了代理且直连不成 → 再走代理。返回 (ok, status, text)。"""
    tries = [None] + ([proxy_url] if proxy_url else [])
    last = ""
    for px in tries:
        try:
            import requests
        except ImportError:
            requests = None
        try:
            if requests is not None:
                s = requests.Session()
                s.trust_env = False
                if px:
                    s.proxies = {"http": px, "https": px}
                r = (s.post(url, data=data, timeout=timeout) if method == "POST"
                     else s.get(url, headers=headers, timeout=timeout))
                if 200 <= r.status_code < 300:
                    return True, r.status_code, (r.text or "")
                last = "HTTP %s %s" % (r.status_code, (r.text or "")[:120])
            else:
                import urllib.request
                import urllib.parse
                req = urllib.request.Request(url, headers=headers or {})
                if data:
                    req.data = urllib.parse.urlencode(data).encode()
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return True, resp.status, resp.read().decode("utf-8", "replace")
        except Exception as e:
            last = ("经代理" if px else "直连") + "异常：" + str(e)[:120]
    return False, -1, last


def dom_tg_send(text, proxy_url=None):
    """给 TG 推一条，返回 (ok, 说明)。异常全吞，绝不影响监控主流程。"""
    cfg = dom_tg_config()
    if not cfg.get("enabled", True):
        return False, "国内版推送开关已关闭"
    token = cfg.get("token") or ""
    chat_id = cfg.get("chat_id") or ""
    if not token or not chat_id:
        return False, "未配置机器人令牌或会话ID（沿用国际版 lv-tg.json）"
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    body = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
            "disable_web_page_preview": "true"}
    ok, st, tx = _dom_http("POST", url, data=body, proxy_url=proxy_url)
    if ok:
        return True, "已发送"
    return False, "HTTP %s %s" % (st, (tx or "")[:150])


def dom_fetch_bundles(proxy_url=None, bearer=None):
    """GET 国内版 /v1/bundles → 套餐列表。★ 必须带 bearer，不带平台回 401（列表为空）。"""
    if not bearer:
        return []
    headers = {"Authorization": "Bearer " + bearer,
               "Accept": "application/json",
               "User-Agent": "Mozilla/5.0 LightVelaDomestic"}
    ok, st, tx = _dom_http("GET", DOM_API + "/v1/bundles",
                           headers=headers, proxy_url=proxy_url)
    if not ok:
        return []
    try:
        d = json.loads(tx).get("data", {})
        return d.get("bundles") or d.get("items") or []
    except Exception:
        return []


def dom_bundle_state(proxy_url=None, bundle_id=DOM_BUNDLE_LAUNCH_AI, bearer=None):
    """返回目标包的 bundle_sales_state（'AVAILABLE'/'SOLD_OUT'/...），取不到返回 None。"""
    for b in dom_fetch_bundles(proxy_url, bearer):
        if b.get("bundle_id") == bundle_id:
            return b.get("bundle_sales_state")
    return None


def _pick_state(bundles, bundle_id):
    """从【已拉到】的套餐列表里取指定包状态（不再重复发请求）。

    ★ 实测：连着发两次 /v1/bundles 会被官网限流，第二次拿不到（返回 None），
      导致状态误判。所以监控每轮只拉一次全量，主/降级两个包都在本地匹配。
    """
    if not bundle_id:
        return None
    for b in (bundles or []):
        if b.get("bundle_id") == bundle_id:
            return b.get("bundle_sales_state")
    return None


def dom_build_available_text(bundle, bundle_fallback, st_p, st_f,
                             accounts_n=0, auto_rush=False, seq=None, test=False):
    """生成「放货了」文案。真实推送与测试推送共用（点测试就能看到真放货的样子）。"""
    lines = ["<b>🎯 LightVela 国内版 放货了</b>" + (("（第 %d 条）" % seq) if seq else "")]
    if st_p == "AVAILABLE":
        lines.append("✅ 主套餐 <b>%s</b>（4500 积分）现在可买" % bundle)
    if bundle_fallback and st_f == "AVAILABLE":
        lines.append("✅ 降级套餐 <b>%s</b>（100 积分）现在可买" % bundle_fallback)
    if st_p and st_p != "AVAILABLE":
        lines.append("· 主套餐 %s：%s" % (bundle, st_p))
    if bundle_fallback and st_f and st_f != "AVAILABLE":
        lines.append("· 降级套餐 %s：%s" % (bundle_fallback, st_f))
    lines.append("")
    lines.append("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("站点：api.lightvela.com（国内版）")
    if accounts_n:
        lines.append("待跑账号：%d 个" % accounts_n)
    lines.append("自动开抢：%s" % ("已开启" if auto_rush else "未开启（请自己点开始）"))
    if test:
        lines.append("")
        lines.append("<i>—— 以上是测试推送，真实放货时发的就是这条 ——</i>")
    return "\n".join(lines)


class DomesticMonitor(object):
    """国内版放货监控（照搬国际版 Monitor）。

    ① 取一个可用凭证（默认复用已存，不重新登录花钱）
    ② 按 interval 秒轮询国内版 /v1/bundles，盯 bundle_sales_state 从 SOLD_OUT 翻 AVAILABLE
    ③ 一放货就每 5 秒推一条 TG，直到点「停止推送」或状态退回售罄
    ④ 勾了「自动开抢」才触发国内版全流程
    """

    def __init__(self, accounts, proxy, interval_sec, parallel,
                 bundle=DOM_BUNDLE_LAUNCH_AI, bundle_fallback=None,
                 auto_rush=False, tg_enabled=True, use_saved=True):
        self.accounts = accounts or []
        self.proxy = proxy or ""
        self.interval = max(1, int(interval_sec or 5))
        self.parallel = max(1, int(parallel or 1))
        self.bundle = bundle
        self.bundle_fallback = bundle_fallback
        self.auto_rush = bool(auto_rush)
        self.use_saved = bool(use_saved)     # ★ 老大要求：一定要沿用复用凭证
        self.tg_enabled = bool(tg_enabled)
        self.tg_state = None
        self.tg_last_result = ""
        self.push_interval = 5.0
        self.push_stopped = False
        self.last_push_at = 0.0
        self.push_count = 0
        self.last_avail = None
        self.lock = threading.Lock()
        self.logs = []
        self.stop_flag = False
        self.done = False
        self.phase = "idle"          # idle→detect→polling→rushing→done
        self.last_state = None
        self.last_check = 0.0
        self.summary = ""
        self.first_bearer = ""

    # --- 日志 ---
    def log(self, msg):
        with self.lock:
            self.logs.append("[%s] %s" % (time.strftime("%H:%M:%S"), msg))
            if len(self.logs) > 4000:
                del self.logs[:1500]

    def _stopped(self):
        return self.stop_flag

    def stop(self):
        self.stop_flag = True
        self.log("⏹ 收到停止指令")

    def stop_push(self):
        self.push_stopped = True
        self.log("🔕 已停止推送（监控仍在轮询，只是不再发 TG；已推 %d 条）" % self.push_count)

    # --- 推送 ---
    def _notify(self, text):
        if not self.tg_enabled:
            return False
        ok, info = dom_tg_send(text, proxy_url=self.proxy)
        self.tg_last_result = ("成功：" if ok else "失败：") + info
        self.log(("📨 TG 推送" + ("成功" if ok else "失败")) + "：" + info)
        return ok

    def _maybe_push(self):
        """最近一次查到可买 → 每 push_interval 秒推一条，直到点「停止推送」或退回售罄。"""
        if self.push_stopped or not self.tg_enabled or not self.last_avail:
            return False
        now = time.time()
        if now - self.last_push_at < self.push_interval:
            return False
        self.last_push_at = now
        self.push_count += 1
        st_p, st_f = self.last_avail
        ok = self._notify(dom_build_available_text(
            self.bundle, self.bundle_fallback, st_p, st_f,
            accounts_n=len(self.accounts), auto_rush=self.auto_rush,
            seq=self.push_count))
        # ★ TG 限流（429）：退避 60 秒，别把「5 秒一条」打成失败死循环
        if not ok and "429" in (self.tg_last_result or ""):
            self.last_push_at = time.time() + 60
            self.log("⏳ TG 限流（429），暂停推送 60 秒后再试")
        return ok

    def _notify_soldout(self, st_p, st_f):
        """从"可买"退回"售罄" → 推一条，避免你以为还能抢。"""
        lines = ["<b>⛔ LightVela 国内版 又售罄了（已停止推送）</b>"]
        if st_p:
            lines.append("· 主套餐 %s：%s" % (self.bundle, st_p))
        if self.bundle_fallback and st_f:
            lines.append("· 降级套餐 %s：%s" % (self.bundle_fallback, st_f))
        lines.append("")
        lines.append("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
        lines.append("本轮共推送 %d 条" % self.push_count)
        self._notify("\n".join(lines))

    # --- 阶段 1：拿一个可用凭证 ---
    def _pick_saved_bearer(self):
        """★ 复用已存凭证：从国内版凭证库取第一个带 bearer 的。返回 (bearer, 来源)。"""
        try:
            toks = _read_tokens()
        except Exception:
            toks = {}
        for k, v in (toks or {}).items():
            if isinstance(v, dict) and v.get("bearer"):
                return v["bearer"], "本地凭证库（%s）" % (v.get("name") or k)
        return "", ""

    def _detect_first(self):
        if not self.use_saved:
            self.log("❌ 未开启「复用凭证」。国内版登录要取号+实名（花钱），"
                     "监控不自动登录——请勾选复用凭证，或先用「① 登录+拿凭证」跑一个号。")
            return False
        bearer, src = self._pick_saved_bearer()
        if not bearer:
            self.log("❌ 本地没有国内版凭证。请先用「① 登录+拿凭证」跑通一个号，再启动监控。")
            return False
        self.log("🔑 复用已存凭证（来自%s），跳过登录" % src)
        if not dom_fetch_bundles(self.proxy, bearer):
            self.log("❌ 该凭证已失效（401/拉不到套餐），请重新登录一个号后再启动监控。")
            return False
        self.log("✅ 凭证可用（%s）Bearer=%s…" % (DOM_API, bearer[:12]))
        self.first_bearer = bearer
        return True

    # --- 主循环 ---
    def run(self):
        self.log("===== 国内版监控启动 | 账号 %d 个 | 间隔 %ds | 并发 %d | 目标 %s | 复用凭证 %s ====="
                 % (len(self.accounts), self.interval, self.parallel,
                    self.bundle, "开" if self.use_saved else "关"))
        try:
            self.phase = "detect"
            if not self._detect_first():
                self.summary = "启动检测失败：没有可用的国内版凭证"
                self.log("❌ " + self.summary)
                self.done = True
                self.phase = "done"
                return
            self.log("✅ 开始轮询国内版 bundles ...")
            self.phase = "polling"
            while not self._stopped():
                self.last_check = time.time()
                # ★ 每轮只拉一次全量，主/降级包都在本地匹配
                #   （连发两次会被官网限流，第二次返回不了 → 状态误判）
                bs = dom_fetch_bundles(self.proxy, self.first_bearer)
                st_p = _pick_state(bs, self.bundle)
                st_f = _pick_state(bs, self.bundle_fallback) if self.bundle_fallback else None
                avail = (st_p == "AVAILABLE") or bool(self.bundle_fallback and st_f == "AVAILABLE")
                known = (st_p is not None) or bool(self.bundle_fallback and st_f is not None)

                if avail:
                    which = []
                    if st_p == "AVAILABLE":
                        which.append("主套餐 " + self.bundle)
                    if self.bundle_fallback and st_f == "AVAILABLE":
                        which.append("降级套餐 " + self.bundle_fallback)
                    self.last_state = " + ".join(which) + " 可买"
                    self.tg_state = "AVAILABLE"
                    self.last_avail = (st_p, st_f)
                    self.log("🎯 轮询：" + self.last_state
                             + ("（每 %.0f 秒推送一次，点「停止推送」才停）" % self.push_interval
                                if not self.push_stopped else "（推送已停止）"))
                    self._maybe_push()
                    if self.auto_rush:
                        self._rush()
                        break
                else:
                    if known:
                        self.last_avail = None
                        if self.tg_state == "AVAILABLE" and not self.push_stopped:
                            self.tg_state = "SOLD_OUT"
                            self.log("⛔ 轮询：又售罄了 → 停止推送并告知")
                            self._notify_soldout(st_p, st_f)
                        elif self.tg_state is None:
                            self.tg_state = "SOLD_OUT"
                    self.last_state = st_p
                    if not known:
                        self.log("⚠ 轮询：套餐状态查不到（凭证失效或网络抖动），下一轮再试")
                    else:
                        self.log("轮询：%s = %s（降级 %s = %s）"
                                 % (self.bundle, st_p, self.bundle_fallback or '-', st_f or '-'))
                # 可打断地等 interval 秒；期间每秒检查一次是否该推
                for _ in range(int(self.interval)):
                    if self._stopped():
                        break
                    time.sleep(1)
        finally:
            self.done = True
            self.phase = "done"
            self.log("监控已结束")

    def _rush(self):
        """放货后自动开抢：调国内版全流程。"""
        self.phase = "rushing"
        self.log("🚀 自动开抢：启动国内版全流程 ...")
        try:
            text = "\n".join("%s %s" % (a.get("name", ""), a.get("idCard", ""))
                             for a in self.accounts)
            r = start("full", text, use_saved=True)
            if r.get("ok"):
                self.log("✅ 已触发全流程，共 %s 个账号" % r.get("total"))
            else:
                self.log("❌ 触发失败：" + str(r.get("error")))
        except Exception as e:
            self.log("❌ 自动开抢异常：%s" % e)


# --- 模块级状态 ---
_mon = None
_mon_thread = None
_test_push = {"thread": None, "stop": False, "count": 0, "last": "", "interval": 5}


def domestic_monitor_start(text="", proxy="", interval=5, parallel=1,
                           bundle_strategy="launch_ai", auto_rush=False, use_saved=True):
    """启动国内版放货监控。"""
    global _mon, _mon_thread
    try:
        with _lock:
            if _state.get("running"):
                return {"ok": False, "error": "已有任务在跑，请先停止"}
            if _mon and not _mon.done:
                return {"ok": False, "error": "监控已在运行"}
        primary, fallback = DOM_BUNDLE_STRATEGIES.get(
            (bundle_strategy or "launch_ai").strip(),
            DOM_BUNDLE_STRATEGIES["launch_ai"])
        accs = parse_accounts(text or "")
        _mon = DomesticMonitor(accs, proxy, interval, parallel,
                               bundle=primary, bundle_fallback=fallback,
                               auto_rush=auto_rush, use_saved=use_saved)
        if fallback:
            _mon.log("监控策略：优先 %s，售罄降级 %s" % (primary, fallback))
        else:
            _mon.log("监控策略：只盯 %s（未配降级套餐）" % primary)
        _mon_thread = threading.Thread(target=_mon.run, daemon=True)
        _mon_thread.start()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def domestic_monitor_stop():
    global _mon
    try:
        if _mon and not _mon.done:
            _mon.stop()
            return {"ok": True}
        return {"ok": False, "error": "没有运行中的监控"}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def domestic_monitor_stop_push():
    """统一「停止推送」：监控推送 + 测试模拟推送，一起停。"""
    try:
        stopped = []
        if _mon and not _mon.done:
            _mon.stop_push()
            stopped.append("监控推送")
        t = _test_push.get("thread")
        if t and t.is_alive() and not _test_push.get("stop"):
            _test_push["stop"] = True
            stopped.append("测试推送")
        if not stopped:
            return {"ok": False, "error": "当前没有在推送"}
        return {"ok": True, "stopped": stopped, "pushed": _test_push.get("count", 0)}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def _test_push_loop(interval, proxy):
    """后台循环：每 interval 秒推一条「放货了」，直到 stop 置位。"""
    seq = 0
    try:
        while not _test_push.get("stop"):
            seq += 1
            text = dom_build_available_text(
                DOM_BUNDLE_LAUNCH_AI, DOM_BUNDLE_LAUNCH,
                "AVAILABLE", "AVAILABLE",
                accounts_n=0, auto_rush=False, seq=seq, test=True)
            ok, info = dom_tg_send(text, proxy_url=proxy or None)
            _test_push["count"] = seq
            _test_push["last"] = ("成功：" if ok else "失败：") + info
            wait = 60 if (not ok and "429" in (info or "")) else interval
            for _ in range(int(wait)):
                if _test_push.get("stop"):
                    break
                time.sleep(1)
    except Exception:
        pass


def domestic_tg_test(proxy="", interval=5):
    """「推送测试」= 模拟现在可买，每 interval 秒推一条，直到点「停止推送」。
    ★ 与真实监控独立：不需要凭证、不需要开监控。
    ★ 参数顺序与国际版 tg_test(proxy, interval) 保持一致，避免前端调用错位。"""
    try:
        cfg = dom_tg_config()
        if not (cfg.get("token") and cfg.get("chat_id")):
            return {"ok": False, "error": "还没保存机器人令牌或会话ID（沿用国际版 lv-tg.json）"}
        t = _test_push.get("thread")
        if t and t.is_alive() and not _test_push.get("stop"):
            return {"ok": False, "error": "测试推送正在跑，先点「停止推送」"}
        _test_push["stop"] = False
        _test_push["count"] = 0
        _test_push["last"] = ""
        _test_push["interval"] = max(1, int(interval or 5))
        th = threading.Thread(target=_test_push_loop,
                              args=(_test_push["interval"], proxy or ""), daemon=True)
        _test_push["thread"] = th
        th.start()
        return {"ok": True, "interval": _test_push["interval"]}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def domestic_monitor_status():
    try:
        t = _test_push.get("thread")
        test_running = bool(t and t.is_alive() and not _test_push.get("stop"))
        cfg = dom_tg_config()
        base = {"ok": True,
                "tg_enabled": cfg.get("enabled", True),
                "tg_token_set": bool(cfg.get("token") and cfg.get("chat_id")),
                "test_push_running": test_running,
                "test_push_count": _test_push.get("count", 0),
                "test_push_last": _test_push.get("last", "")}
        if not _mon:
            base.update({"running": False, "phase": "idle", "logs": [],
                         "state": "", "summary": "", "push_count": 0})
            return base
        with _mon.lock:
            logs = list(_mon.logs[-200:])
        base.update({"running": not _mon.done,
                     "phase": _mon.phase,
                     "logs": logs,
                     "state": _mon.last_state or "",
                     "summary": _mon.summary or "",
                     "tg_state": _mon.tg_state,
                     "tg_last": _mon.tg_last_result,
                     "push_count": _mon.push_count,
                     "push_stopped": _mon.push_stopped,
                     "bundle": _mon.bundle,
                     "bundle_fallback": _mon.bundle_fallback})
        return base
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
