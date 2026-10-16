# LightVela 放货监控 · 部署与用法说明

> 对应需求：把"监控放货→自动批量注册抢 0 元订阅"嵌进 docker-web 控制面板。
> 改了 3 个文件：`lv_gui_core.py`、`webapp.py`、`lv_gui.html`。

---

## 一、改了什么

### `lv_gui_core.py`
- 新增 `Monitor` 类（后台线程）：**启动首号检测** → **轮询 `GET /v1/bundles`** → **放货触发并发批次**。
  - 阶段 1（detect）：拿导入列表**第一个账号**做 GitHub 授权登录 + 凭证检测，确认流程可用；失败则告警并不进入轮询。
  - 阶段 2（polling）：按自定义秒数轮询目标包 `bundle_launch_ai_01` 的 `bundle_sales_state`，等从 `SOLD_OUT` 翻 `AVAILABLE`。
  - 阶段 3（rushing）：一放货，按**并发数**对**全部导入账号（含第一个）**并发跑 注册→存凭证→买 0 元。
- `Job` 新增售罄中止：`abort_if_soldout` 开关 + `soldout_flag` + `_mark_soldout_skip()`；`_rush` 在开抢前与下单失败处检测售罄，一旦售罄立即停剩余账号并标「售罄跳过」。
- `Api` 新增 `monitor_start` / `monitor_stop` / `monitor_status`；`poll()` 增加监控视图（合并 monitor 日志 + 批次日志，返回 `monitor` 状态段）。

### `webapp.py`
- `HANDLERS` 增加 `monitor_start` / `monitor_stop` / `monitor_status` 三个路由（`/api/{name}` 复用现有分发）。

### `lv_gui.html`
- 新增「放货监控」卡片：轮询间隔（秒）、并发、启动/停止按钮、状态条（阶段 / 目标包状态 / 最近检测时间）。
- `poll()` 渲染监控状态；轮询阶段显示"等待放货"占位；触发后显示账号表格。
- `stageTag` 支持「售罄跳过」标签。

---

## 二、运行

### 本地起
```bash
pip install fastapi uvicorn requests
python webapp.py
# 默认 0.0.0.0:8000，访问 http://<机器IP>:8000
# 登录密码默认 lightvela（环境变量 LV_WEB_PASSWORD 可改）
```

### Docker（沿用原 Dockerfile，无需改）
环境变量（与原版一致）：
- `LV_WEB_PASSWORD` 登录密码
- `LV_SECRET` 会话签名密钥（建议设）
- `LV_DATA_DIR` 凭证文件目录（挂数据盘，默认 `lv-tokens.json` 在此）
- `LV_PORT` 端口（默认 8000）

---

## 三、界面用法

1. 「账号」框粘贴：`邮箱----密码----用户名----2FA`（每行一个）。
2. 「放货监控」卡填：
   - **轮询**：间隔秒数（如 5 = 每 5 秒查一次 bundles）。
   - **并发**：同时跑几个账号（也可沿用「参数」卡的并发输入）。
3. 点 **▶ 启动监控**：
   - 先用第一个账号登录 + 检测凭证（失败会红字告警，不轮询）。
   - 通过后按间隔轮询套餐状态。
   - `bundle_launch_ai_01` 一旦变 `AVAILABLE`，立即按并发对所有账号（含第一个）抢 0 元。
4. 批量中若再售罄 → 自动停剩余账号并标「售罄跳过」。
5. **■ 停止** 可随时停（首号检测阶段会等联网登录返回后收尾，最多几十秒）。

---

## 四、关键字段 / 接口

- 监控目标包：`bundle_launch_ai_01`（Launch AI，0 元首月免费）。
- 状态字段：`bundle_sales_state`（`SOLD_OUT` / `AVAILABLE`）。
- 后端接口：`/api/monitor_start`、`/api/monitor_stop`、`/api/monitor_status`、`/api/poll`（返回体含 `monitor` 段）。

---

## 五、注意事项

- 监控线程是 daemon，随进程退出；VPS 上用 `nohup` / `systemd` / 容器保活。
- 凭证存 `LV_DATA_DIR/lv-tokens.json`（Docker 里挂数据盘），跑完可点「删除全部凭证」清空。
- 首号检测与批量都走 GitHub 登录，确保账号 / 代理可用。
- 售罄判定依赖 `bundle_sales_state` 字段（已由 `_probe_bundles.js` 实测确认存在）；下单失败且回售罄时也会触发中止，双保险。
