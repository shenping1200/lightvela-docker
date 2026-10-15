# -*- coding: utf-8 -*-
"""
LightVela 抢名额 · Web 版服务端
================================
设计原则：**不重写编排逻辑**。
- 直接复用 lv_gui_core 里的 Api / Job（账号解析、登录、抢单、建Bot、部署全不动）；
- 只把原来"弹系统文件对话框"的 4 处（选txt / 存导出 / 存凭证 / 取凭证）换成 HTTP 上传下载；
- 新增两件事：① 密码登录（带失败限速）② 一键删除凭证。

所有配置走环境变量：
  LV_WEB_PASSWORD  登录密码（必填，默认 lightvela）
  LV_SECRET        会话签名密钥（建议设置；不设则每次重启失效）
  LV_DATA_DIR      凭证文件所在目录（Docker 里指向挂载的数据盘）
  LV_PORT          监听端口（默认 8000）
  LV_COOKIE_SECURE 置 1 时给 cookie 加 Secure（走 HTTPS 时开）
"""
import os
import json
import time
import hmac
import hashlib
import secrets
import threading

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn

import lv_gui_core as core

BASE = os.path.dirname(os.path.abspath(__file__))

# ---------------- 配置 ----------------
PASSWORD = os.environ.get("LV_WEB_PASSWORD") or "lightvela"
SECRET = os.environ.get("LV_SECRET") or secrets.token_hex(32)
COOKIE_NAME = "lv_session"
SESSION_TTL = int(os.environ.get("LV_SESSION_TTL") or 7 * 86400)
COOKIE_SECURE = os.environ.get("LV_COOKIE_SECURE") == "1"
HOST = os.environ.get("LV_HOST") or "0.0.0.0"
PORT = int(os.environ.get("LV_PORT") or 8000)

# 登录失败限速：同一 IP 10 分钟内失败满 8 次 → 锁 10 分钟
MAX_FAIL = 8
FAIL_WINDOW = 600
_fail = {}
_fail_lock = threading.Lock()

app = FastAPI(title="LightVela Web", docs_url=None, redoc_url=None, openapi_url=None)
API = core.Api()          # ← 复用现有 Api（内部含 Job 编排与 Node 引擎桥）


# ---------------- 会话票据（HMAC 签名，无状态） ----------------
def make_session():
    exp = int(time.time()) + SESSION_TTL
    payload = str(exp)
    sig = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return payload + "." + sig


def check_session(tok):
    if not tok or "." not in tok:
        return False
    payload, sig = tok.rsplit(".", 1)
    good = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        return False
    try:
        return int(payload) > time.time()
    except Exception:
        return False


def client_ip(request):
    xf = request.headers.get("x-forwarded-for")
    if xf:
        return xf.split(",")[0].strip()
    return request.client.host if request.client else "?"


def _fail_count(ip):
    with _fail_lock:
        rec = _fail.get(ip)
        if not rec:
            return 0
        ts, n = rec
        if time.time() - ts > FAIL_WINDOW:
            _fail.pop(ip, None)
            return 0
        return n


def _fail_add(ip):
    with _fail_lock:
        ts, n = _fail.get(ip, (time.time(), 0))
        if time.time() - ts > FAIL_WINDOW:
            ts, n = time.time(), 0
        _fail[ip] = (ts, n + 1)


def _fail_reset(ip):
    with _fail_lock:
        _fail.pop(ip, None)


def require_login(request):
    if not check_session(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="未登录")


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return {}


def _args(body):
    if isinstance(body, dict):
        a = body.get("args")
        return a if isinstance(a, list) else []
    if isinstance(body, list):
        return body
    return []


# ---------------- 凭证相关（替代原来的系统对话框） ----------------
def _export_tokens():
    p = core.token_path()
    if not os.path.isfile(p):
        return {"ok": False, "error": "还没有凭证文件"}
    try:
        raw = json.load(open(p, encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": "读凭证文件失败：%s" % e}
    if not isinstance(raw, dict) or not raw:
        return {"ok": False, "error": "凭证文件是空的"}
    return {"ok": True, "count": len(raw),
            "text": json.dumps(raw, ensure_ascii=False, indent=2),
            "filename": "lv-tokens-%s.json" % time.strftime("%Y%m%d-%H%M")}


def _import_tokens_text(text):
    try:
        incoming = json.loads(text or "")
    except Exception as e:
        return {"ok": False, "error": "不是合法的 JSON：%s" % e}
    if not isinstance(incoming, dict):
        return {"ok": False, "error": "文件格式不对（应该是一个 JSON 对象）"}
    local = {}
    p = core.token_path()
    if os.path.isfile(p):
        try:
            local = json.load(open(p, encoding="utf-8")) or {}
        except Exception:
            local = {}
    merged, added, updated = core.merge_tokens(local, incoming)
    if not merged:
        return {"ok": False, "error": "这份文件里没有可用的凭证"}
    core.write_tokens(merged)
    return {"ok": True, "added": added, "updated": updated, "total": len(merged)}


def _delete_tokens(login):
    """login 为空 → 删除全部凭证文件；否则只删该账号一条。"""
    p = core.token_path()
    if not os.path.isfile(p):
        return {"ok": False, "error": "没有凭证文件"}
    if not login:
        try:
            os.remove(p)
        except Exception as e:
            return {"ok": False, "error": "删除失败：%s" % e}
        _reload_job_tokens()
        return {"ok": True, "deleted": "all"}
    try:
        raw = json.load(open(p, encoding="utf-8")) or {}
    except Exception as e:
        return {"ok": False, "error": "读凭证文件失败：%s" % e}
    if login not in raw:
        return {"ok": False, "error": "没有这个账号的凭证：%s" % login}
    raw.pop(login, None)
    core.write_tokens(raw)
    _reload_job_tokens()
    return {"ok": True, "deleted": login, "left": len(raw)}


def _reload_job_tokens():
    """删完凭证后，把内存里那份也刷新，避免和磁盘不一致。"""
    try:
        if API.job is not None:
            API.job.tokens = core.load_tokens()
    except Exception:
        pass


# ---------------- 路由：登录相关（放在 /api/{name} 之前，优先匹配） ----------------
@app.post("/api/login")
async def api_login(request: Request):
    ip = client_ip(request)
    if _fail_count(ip) >= MAX_FAIL:
        return JSONResponse({"ok": False, "error": "尝试次数过多，请 10 分钟后再试"}, status_code=429)
    body = await _body(request)
    pw = str(body.get("password") or "")
    if not hmac.compare_digest(pw, PASSWORD):
        _fail_add(ip)
        left = MAX_FAIL - _fail_count(ip)
        return JSONResponse({"ok": False, "error": "密码不对（还可尝试 %d 次）" % max(0, left)},
                            status_code=401)
    _fail_reset(ip)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE_NAME, make_session(), max_age=SESSION_TTL, httponly=True,
                    samesite="lax", secure=COOKIE_SECURE, path="/")
    return resp


@app.post("/api/logout")
async def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/session")
async def api_session(request: Request):
    return {"ok": True, "logged_in": check_session(request.cookies.get(COOKIE_NAME))}


# ---------------- 路由：业务接口（全部复用 core.Api） ----------------
HANDLERS = {
    "parse":             lambda a: API.parse(a[0] if a else ""),
    "normalize_proxy":   lambda a: API.normalize_proxy(*a),
    "test_proxy":        lambda a: API.test_proxy(*a),
    "start":             lambda a: API.start(*a),
    "stop":              lambda a: API.stop(),
    "poll":              lambda a: API.poll(),
    "export_text":       lambda a: API.export_text(a[0] if a else "all"),
    "tokens_info":       lambda a: API.tokens_info(),
    "export_tokens":     lambda a: _export_tokens(),
    "import_tokens_text": lambda a: _import_tokens_text(a[0] if a else ""),
    "delete_tokens":     lambda a: _delete_tokens(a[0] if a else ""),
}


@app.post("/api/{name}")
async def api_dispatch(name: str, request: Request):
    require_login(request)
    fn = HANDLERS.get(name)
    if not fn:
        raise HTTPException(status_code=404, detail="未知接口：%s" % name)
    args = _args(await _body(request))
    try:
        out = fn(args)
    except Exception as e:
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    if not isinstance(out, dict):
        out = {"ok": True, "data": out}
    return JSONResponse(out)


# ---------------- 页面 ----------------
@app.get("/")
async def index():
    with open(os.path.join(BASE, "lv_gui.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/healthz")
async def healthz():
    return {"ok": True, "data_dir": os.environ.get("LV_DATA_DIR") or core.app_dir()}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info", access_log=False)
