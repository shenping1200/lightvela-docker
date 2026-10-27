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
    return {"ok": True, "config": _read_config()}


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
    """用配置里的账密登录当前所选平台（豪猪/飞狐/鲁班）、查余额，返回 {ok, balance, error}。"""
    cfg = _read_config()["sms"]
    provider = (cfg.get("provider") or "haozhuma").lower()
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


def _run_one(idx, acc, mode, accounts_file, use_saved=False):
    """单账号子进程：spawn node bot.js --account-idx idx [--login-only]，实时读日志。"""
    # ★ 全局停止闸门①：线程被调度到时若已停止，连子进程都不起，占位（姓名+身份证）原样保留
    with _lock:
        if not _state["running"]:
            return None
    args = [NODE_BIN, BOT, "--account-idx", str(idx)]
    if mode == "login":
        args.append("--login-only")
    if mode == "resume" or (mode == "full" and use_saved):
        args.append("--resume")   # 复用/补全：bot.js 自行判断"有凭证复用、无凭证登录补全"
    env = dict(os.environ)
    env["LIGHTVELA_ACCOUNTS_FILE"] = accounts_file
    env["LIGHTVELA_DOMESTIC_TOKENS"] = token_path()
    # ★ 注入国内版配置（接码平台账密 / 出口代理），子进程 bot.js 按 env 解析
    env.update(_env_from_config(_read_config()))
    # ★ 部署命令文件路径对齐：面板把部署命令存到数据盘 domestic-deploy-msg.txt，
    #   必须显式告诉 bot.js（否则它默认去脚本目录找 deploy_cmd.txt，容器里没有 → 部署阶段报"文件不存在"）
    env["LIGHTVELA_DEPLOY_FILE"] = _dom_deploy_msg_path()
    # ★ 把并发数传给 bot.js：仅当并发>1 时才启用发码错峰门控（单账号无需错峰）
    env["LIGHTVELA_DOMESTIC_CONCURRENCY"] = str(CONCURRENCY)
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
                    _append_log(cleaned, "[%02d %s] " % (idx, acc["name"]))
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
        with _lock:
            _state["total"] = total
            _state["done"] = 0
            _state["results"] = [{"idx": i, "name": a["name"], "idCard": a["idCard"]} for i, a in enumerate(accounts)]
            # 续跑时 prelude 是「[跳过] 某某：原因」明细，放在日志最前面
            _state["log"] = list(prelude or [])
            _state["procs"] = []
        # ★ 启动新运行前，清掉上一轮 webapp 重启留下的孤儿 bot 进程（命令行含 domestic_lightvela_bot.js）
        kill_orphan_bots()
        # ★ 2026-10-26：并发改为「滑动窗口」（信号量），不再整批 join。
        #   同时最多 CONCURRENCY 个账号在跑；任意一个跑完（槽位释放）立刻补起下一个，
        #   始终维持设定的并发数在场，消除「最慢那个等验证码把整批拖住、其余空等」的问题。
        sem = threading.Semaphore(CONCURRENCY)
        threads = []
        def _worker(idx, acc):
            try:
                _run_one(idx, acc, mode, tmp, use_saved)
            finally:
                sem.release()   # 跑完即腾出槽位，下一个排队账号立刻补位
        for idx, acc in enumerate(accounts):
            # 全局停止：不再给排队账号起进程（在跑的会继续跑完或被看门狗杀）
            if not _state["running"]:
                break
            sem.acquire()       # 槽位满则阻塞，等某账号跑完腾出位置才放行下一个
            t = threading.Thread(target=_worker, args=(idx, acc), daemon=True)
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


def start(mode, text, concurrency=None, use_saved=False):
    """启动一次运行（后台线程）。mode='login'|'full'|'resume'。返回 {ok, total}。"""
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
        if concurrency:
            global CONCURRENCY
            CONCURRENCY = max(1, min(int(concurrency), 20))
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
