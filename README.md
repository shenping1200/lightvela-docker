# LightVela Docker Web

> 把「LightVela 抢名额」批量自动化工具，从 Windows 桌面程序改造成 **Docker 化的网页服务** —— 部署在 VPS 上，用浏览器访问，带密码登录。

---

## 这个项目是干什么的

**LightVela** 是一个 AI 沙箱平台（`lightvela.ai`），它偶尔会放出**限时 0 元试用套餐**（`bundle_launch_ai_01`，一个月免费）。这个项目就是用来**批量、自动地**完成下面这套流程：

1. 拿一批账号（邮箱 + 密码 + 2FA 密钥）
2. **纯代码登录** —— 不需要浏览器，全程 HTTP 请求搞定 GitHub 登录 + TOTP 两步验证 + OAuth 授权
3. 拿到平台的 **Bearer 令牌**（64 位十六进制，不是 JWT）
4. 用令牌去 **抢 0 元套餐**（手快有手慢无，售罄就返回 `PASS_BUNDLE_SOLD_OUT`）
5. 订阅成功后，**创建 Bot** 并把部署命令发给机器人
6. 全程可查看日志、导出结果、查看每个账号拿到的凭证

整个过程通过**轮换代理池**出口，服务器真实 IP 不会暴露给目标平台。

---

## 它是怎么从桌面程序变成网页的

原始版本是一个 **pywebview 桌面程序**（本地 Python 后端 + 一个 HTML 界面，靠 `window.pywebview.api` 通信）。

改造成网页服务的关键思路是 **"零重写"** —— 后端逻辑（`lv_gui_core.py` 的 `Job`/`Api`）一个字没动，只换了一层"壳"：

| 原桌面版 | Web 版做法 |
|---|---|
| 前端调 `window.pywebview.api.xxx(args)` | 前端用 `Proxy` 把所有调用转成 `fetch('/api/xxx')` |
| 后端由 pywebview 自动暴露 Python 方法 | 后端用一张 `HANDLERS` 字典，把 `POST /api/{名字}` 映射到 `Api` 的方法 |
| 弹系统文件对话框选文件 | 用隐藏的 `<input type="file">` + `FileReader` |
| 保存文件到本地 | 用 `Blob` + `<a download>` 触发浏览器下载 |

改动只有 4 处文件对话框 + 一层登录壳，**引擎（Node 脚本）完全没动**。

### 核心三招

**第一招 —— 前端顶替 `window.pywebview.api`：**

```js
const API = new Proxy({}, {
  get(_t, name) {
    return (...args) => fetch('/api/' + name, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({args: args})
    }).then(r => r.json());
  }
});
```

**第二招 —— 后端一张 `HANDLERS` 映射表：**

```python
HANDLERS = {
    "parse":       lambda a: API.parse(a[0] if a else ""),
    "start":       lambda a: API.start(*a),
    "poll":        lambda a: API.poll(),
    "delete_tokens": lambda a: _delete_tokens(a[0] if a else ""),
    # ... 其余同理
}
```

**第三招 —— 数据路径改环境变量：**

```python
def token_path():
    d = os.environ.get("LV_DATA_DIR") or app_dir()
    return os.path.join(d, TOKEN_FILE)
```

桌面版存 exe 同目录，Docker 版存挂载盘 `/data`，一份代码两处通用。

---

## 目录结构

```
.
├── Dockerfile              # 镜像定义（node:22-slim + python3 venv）
├── docker-compose.yml      # 编排（端口 / 数据盘 / 健康检查）
├── install.sh              # ★ 一行命令安装入口（从 GitHub 拉代码并调用 deploy.sh）
├── deploy.sh               # ★ 一键部署脚本（含端口/密码交互设置）
├── .env.example            # 环境变量模板（复制成 .env 用）
├── requirements.txt        # Python 依赖
│
├── webapp.py               # Web 服务（FastAPI，复用 lv_gui_core 的 Job/Api）
├── lv_gui.html             # 前端页面（登录页 + fetch 通信 + 删除凭证）
├── lv_gui_core.py          # 核心逻辑（账号解析 / 登录 / 抢单 / 建 Bot / 部署）
│
├── lightvela-purecode.js   # Node 引擎（登录 + 抢单 + 部署全流程）
├── lv-proxy.js             # 引擎依赖（代理支持，含 socks5h）
├── lv-ptystart-fn.js       # 引擎依赖（远端沙箱命令构造）
└── _deploy_msg.example.txt # 发给机器人的部署指令模板（把 __PROBE_WS__ / __PROBE_TOKEN__ 换成自己的）
```

> `data/` 目录是运行时生成的，存凭证文件 `lv-tokens.json`，**不在仓库里**。

---

## 一键部署

### 方式 A：一行命令（推荐，连代码都不用先传）

在**新服务器**上直接执行这一行，**全自动**：装 Docker → 从 GitHub 拉代码 → 问你端口和密码 → 构建启动 → 打印访问地址。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/shenping1200/lightvela-docker/main/install.sh)
```

运行时会交互询问（直接回车即用默认值）：

```
请输入对外端口（直接回车用默认 18080）：
请设置面板登录密码（直接回车用默认密码 QQqq120656387.）：
```

> 默认密码 `QQqq120656387.` 是公开的，正式用建议自己设一个。

### 方式 B：已经把项目放到服务器上了

```bash
cd lightvela-docker
bash deploy.sh
```

`deploy.sh` 会自动：

1. 检查 / 安装 Docker 与 docker compose（Debian/Ubuntu 没装会尝试自动装）
2. 拉取 / 更新项目代码（如果是 git 仓库则 `pull`，否则从 GitHub 克隆）
3. 交互询问端口与面板登录密码（也可环境变量免交互指定）
4. 生成 `.env`（写入登录密码 + 随机签名密钥，权限 600）
5. 放行防火墙端口（ufw / firewalld / iptables 都支持）
6. 构建镜像并启动容器
7. 自检并打印访问地址和密码

**免交互指定密码 / 端口：**

```bash
LV_WEB_PASSWORD='你的密码' bash deploy.sh
LV_PORT=8080 LV_WEB_PASSWORD='你的密码' bash deploy.sh
```

**只更新代码不重新部署：**

```bash
PULL_ONLY=1 bash deploy.sh
```

**换仓库 / 安装目录：**

```bash
REPO_URL=https://github.com/you/repo.git TARGET_DIR=/opt/xxx bash deploy.sh
```

> `.env` 里的 `LV_SECRET` 是登录 cookie 的签名密钥，**改了会让所有已登录的设备掉线**，脚本会保留原值不覆盖。

---

## 手动部署（不用脚本）

```bash
# 1. 准备环境变量
cp .env.example .env
vi .env          # 改 LV_WEB_PASSWORD，LV_SECRET 随便填一串长随机字符串

# 2. 构建并启动
docker compose up -d --build

# 3. 打开浏览器
#    http://<服务器IP>:18080
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LV_WEB_PASSWORD` | `lightvela`（**务必改**） | 网页登录密码 |
| `LV_SECRET` | 每次启动随机 | 登录 cookie 的签名密钥。**不设的话容器重启就全部掉线** |
| `LV_DATA_DIR` | 程序目录 | 凭证文件存放目录。Docker 版固定 `/data` |
| `LV_PORT` | `8000` | 容器内监听端口 |
| `LV_HOST` | `0.0.0.0` | 监听地址 |
| `LV_COOKIE_SECURE` | 空 | 设 `1` 则 cookie 只在 https 下发送。**走 http 时不要设** |
| `LV_SESSION_TTL` | `604800`（7 天） | 登录有效期（秒） |

---

## 功能说明

界面与桌面版一致，差异在于：

1. **密码登录** —— 所有操作需先登录；同一 IP 10 分钟内连错 8 次锁定 10 分钟
2. **导入 txt** —— 点按钮从本机选文件（不再弹系统对话框）
3. **导出结果 / 导出凭证** —— 直接下载到浏览器"下载"目录
4. **导入凭证** —— 选本机 `.json` 上传，与服务器上已有的**合并**（同账号时间新的赢）
5. **删除全部凭证** —— 跑完一键清空，省磁盘 + 账号安全，**不可恢复**，有二次确认
6. **删指定账号** —— 只删某一个账号的凭证

---

## 关于凭证（Bearer 令牌）

- 格式：**64 位十六进制**，不是 JWT，**本身不带过期时间**
- 实测：**至少能活 6 小时**；同账号重复登录**不会**踢掉旧令牌
- 存在 `data/lv-tokens.json`，键是账号名，值是令牌
- 页面上可以直接导出/导入/删除

---

## 运维

```bash
docker compose ps                    # 看状态
docker logs -f lightvela-web         # 看日志
docker compose restart               # 重启
docker compose up -d --build         # 改完代码重建
docker compose down                  # 停止
cat data/lv-tokens.json              # 看凭证
```

健康检查接口：`GET /healthz`

---

## 并发建议

按 2 核小机器估的，配置好的机器可以往上调：

| 环节 | 建议并发 |
|---|---|
| 预登录 | ≤ 4 |
| 抢单 | ≤ 6 |
| 全流程 | ≤ 2 |

---

## 注意

- **`socks5h://` 必须带 `h`** —— 否则 DNS 在本地解析，会泄露真实来源
- **HTTP 客户端必须 `trust_env=False`** —— 否则环境变量里的代理会盖掉代码里指定的 `session.proxies`
- 引擎里 `new_session()`（GitHub 登录用，**不带令牌**）和 `api_session(token)`（调平台 API，**带 Bearer**）是两个函数，**用错会得到满屏假的 401**
- 本项目仅供学习 HTTP 协议与容器化改造思路，请遵守目标平台的服务条款

---

## License

MIT
