#!/usr/bin/env node
/**
 * 【国内版】LightVela 纯代码全自动：取号登录 → 实名 → 抢套餐 → 建机器人 → 发部署消息 → 抓回复
 * ------------------------------------------------------------------
 * 不碰浏览器，直接按抓包还原的三层协议打：
 *   ① 官网 REST 拿 Bearer + 实例/bot + tat/session
 *   ② 腾讯云 TAT 中继 WS（wss）建隧道，PtyProxy 把 127.0.0.1:9119(Hermes) 映射出来
 *   ③ 在隧道里手写 Hermes WebSocket 客户端，发 prompt.submit 聊天
 *
 * 零依赖：只用 Node 内置 tls / https / crypto。
 *
 * 配置（环境变量，全部可选，有合理默认/联调时填）：
 *   LIGHTVELA_BEARER      官网 Bearer token（没有就靠 LIGHTVELA_COOKIE 去 /auth/session 换）
 *   LIGHTVELA_COOKIE      lightvela.ai 的会话 cookie（可选）
 *   LIGHTVELA_INSTANCE_ID 实例 id（不填则从 /v1/instances 取第一个）
 *   LIGHTVELA_BOT_ID      bot id（不填则从 /v1/instances/{id}/bots 取第一个）
 *   LIGHTVELA_REGION      TAT 中继区域，默认 ap-johorbahru
 *   LIGHTVELA_PROXY_HOST  隧道目标，默认 127.0.0.1
 *   LIGHTVELA_PROXY_PORT  隧道目标端口，默认 9119
 *   LIGHTVELA_HERMES_TOKEN Hermes token（联调兜底；正常由 PtyStart 输出 __LV_DASHBOARD_READY__ 解析）
 *   LIGHTVELA_SESSION_ID  TAT SessionId（不填由 tat/session 下发）
 *
 * 与骨架 domestic_lightvela_auto.js 的区别：
 *   骨架走 debug/exec（直接执行命令，拿原始输出）；本文件走"发给机器人"，能拿到机器人写的报告。
 *
 * 实测依据（capture-1752250042 / capture-deploy-1752250042 抓包逐字段核对）：
 *   apiBase = api.lightvela.com、region = ap-shanghai、模型网关 = token.lightvela.com/v1、
 *   PtyStart 启动函数与国际版同为 ensure_opencraft_hermes_backend（国内版直接复用）。
 *
 * 用法：
 *   node domestic_lightvela_bot.js
 */

'use strict';
// ★ 修复面板日志看不到（Windows 专属）：stdout 被重定向到管道（非 TTY）时，Node 在 Windows(libuv) 上会
//   按块缓冲、攒到进程退出/缓冲满才一次性刷出；Python 父进程 `for line in proc.stdout` 读不到实时日志，
//   表现为「面板只有[已启动]、run_domestic_*.log 长时间 0 字节、但后台机器其实在上线」。
//   对照：同代码同 Node22 在 Linux(VPS, glibc) 行缓冲，日志正常——已上 VPS 比对确认是 OS 差异。
//   根治：用 fs.writeSync(fd=1) 绕过 Node 异步缓冲，每条 console.log 同步落到 OS 管道；setBlocking 作补充保险。
//   任何一步失败都回退原生 console.log，绝不伤业务。
const _fs = require('fs');
const _util = require('util');
// ★ 日志双写 + EPIPE 防护（修复「webapp 重启后 bot 在取码前崩、run_domestic_*.log 0 字节、面板没反应」）
//   根因：国内版 bot 由 webapp(Python) 用管道拉起；Windows 上父进程(webapp)被重启会导致 stdout 管道(fd=1)断裂，
//   旧代码用 fs.writeSync(1,…) 同步写管道，管道一断就同步抛 EPIPE 直接崩进程——飞狐取号/发码已完成、取码前崩。
//   修复：① setBlocking 解除 Windows 块缓冲（日志实时）；② 若设了 LIGHTVELA_LOG_FILE，额外同步写日志文件
//        （不依赖管道，父进程死了也不丢、bot 还能继续跑完）；③ 所有写 fd=1 的操作吞掉 EPIPE/其它错误，管道断了不崩。
const _outFd = (process.stdout && typeof process.stdout.fd === 'number') ? process.stdout.fd : 1;
try { if (process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') process.stdout._handle.setBlocking(true); } catch (e) {}
(() => {
  let _fileFd = null;
  const _logPath = process.env.LIGHTVELA_LOG_FILE;
  if (_logPath) { try { _fileFd = _fs.openSync(_logPath, 'a'); } catch (e) { _fileFd = null; } }
  // 写管道：吞掉 EPIPE（管道断裂时静默丢弃，绝不崩进程）
  const _writeOut = (s) => { try { _fs.writeSync(_outFd, s); } catch (e) { /* 管道断裂(EPIPE)等：吞掉 */ } };
  // 写文件：父进程死了也不丢，bot 还能继续跑完
  const _writeFile = (s) => { if (_fileFd != null) { try { _fs.writeSync(_fileFd, s); } catch (e) {} } };
  const _emit = (...a) => { const s = _util.format(...a) + '\n'; _writeOut(s); _writeFile(s); };
  // ★ 无换行的直写出口（流式回复增量等）：同样"管道+文件"双写——
  //   之前这些地方直接 process.stdout.write()，只进管道不进文件，部署回复在 run_domestic_*.log 里看不到，排障抓瞎；
  //   而且绕过 EPIPE 防护。统一走这里。
  global.__safeOut = (s) => { const t = String(s); _writeOut(t); _writeFile(t); };
  console.log = _emit;
  console.warn = _emit;
  console.error = _emit;
  // 兜底：即便别处直接 process.stdout/stderr.write，也别因 EPIPE 崩
  try { process.stdout.on('error', () => {}); process.stderr.on('error', () => {}); } catch (e) {}
  // ★ 未捕获异常/拒绝也写文件（父进程(webapp)已死时 stderr 无处去，0 字节日志会让人以为“没反应”）写完即退出，由看门狗兜底
  process.on('uncaughtException', (e) => { _writeFile('[致命] 未捕获异常: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
  process.on('unhandledRejection', (e) => { _writeFile('[致命] 未处理 Promise 拒绝: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
})();
const tls = require('tls');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeProxy, connectTunnel, makeHttpsAgent, resetHttpsAgent } = require('./lv-proxy');

// ===================== 设主模型脚本(hermes 官方模型配置, gzip+base64, 通用) =====================
// 前端【设定主模型】实际 = 向实例 POST /v1/instances/<id>/debug/exec，命令里解压执行此脚本，
// 并传 payload(JSON base64) 决定动作。脚本为官方通用版，纯代码只换 payload(sys.argv[1])。
const HERMES_MODEL_CFG_SCRIPT_B64 = "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";


// ===================== 配置 =====================
const CFG = {
  bearer:        process.env.LIGHTVELA_BEARER || '',
  cookie:        process.env.LIGHTVELA_COOKIE || '',
  instanceId:    process.env.LIGHTVELA_INSTANCE_ID || '',
  botId:         process.env.LIGHTVELA_BOT_ID || '',
  region:        process.env.LIGHTVELA_REGION || 'ap-shanghai',
  proxyHost:     process.env.LIGHTVELA_PROXY_HOST || '127.0.0.1',
  proxyPort:     parseInt(process.env.LIGHTVELA_PROXY_PORT || '9119', 10),
  hermesToken:   process.env.LIGHTVELA_HERMES_TOKEN || '',
  sessionId:     process.env.LIGHTVELA_SESSION_ID || '',
  env:           process.env.LIGHTVELA_ENV || '',
  apiBase:       process.env.LIGHTVELA_API_BASE || 'https://api.lightvela.com',
  // ★ 国内版模型网关（实抓确认：设主模型返回 baseUrl = https://token.lightvela.com/v1）
  modelBaseUrl:  process.env.LIGHTVELA_MODEL_BASE_URL || 'https://token.lightvela.com/v1',
  shellCmd:      '',        // --shell 模式：直接往沙箱 PTY 敲 shell 命令，拿【原始输出】(不经过机器人)
  shellWaitMs:   25000,     // --shell 模式收集输出的时长
  // ★ 出口代理：让纯代码走"环境代理"，做到账号隔离（出口 IP = 环境 IP）
  egressProxy:   null,      // 由 LIGHTVELA_EGRESS_PROXY(JSON) 解析而来
  noAutoclose:   process.env.LIGHTVELA_NO_AUTOCLOSE === '1',  // 1=跑完不自动关环境（由外层编排统一关）
  fp:            null,   // ★ 设备指纹（按账号种子化生成，见 setFingerprint）
};

// ★ 出口代理（2026-10-16 起支持代理池）：所有 LightVela API 请求走这里。
//   支持两种格式：单个代理对象 或 数组（代理池）；数组时每次请求随机挑一个 → 实现"每请求换 IP"。
//   环境变量 LIGHTVELA_EGRESS_PROXY(JSON) 可覆盖；未设置则用内置默认 a.rr2.kdns.fr:10800。
const DEFAULT_EGRESS_PROXY = {
  type: 'socks5', host: 'a.rr2.kdns.fr', port: 10800, username: '6582443', password: '6582443',
};
let EGRESS_AGENTS = [];   // 代理池对应的 https.Agent 列表（池>1 时每次请求随机挑一个）
function pickEgressAgent() {
  if (!EGRESS_AGENTS.length) return undefined;
  if (EGRESS_AGENTS.length === 1) return EGRESS_AGENTS[0];
  return EGRESS_AGENTS[Math.floor(Math.random() * EGRESS_AGENTS.length)];
}
{
  let src = DEFAULT_EGRESS_PROXY;
  if (process.env.LIGHTVELA_EGRESS_PROXY) {
    try { src = JSON.parse(process.env.LIGHTVELA_EGRESS_PROXY); }
    catch (e) { console.log('[代理] LIGHTVELA_EGRESS_PROXY 解析失败，改用内置默认代理:', e.message); }
  }
  // src 可能是单个代理对象，也可能是代理池（数组）
  const pool = (Array.isArray(src) ? src : [src]).map(normalizeProxy).filter(Boolean);
  EGRESS_AGENTS = pool.map(makeHttpsAgent).filter(Boolean);
  if (EGRESS_AGENTS.length) {
    CFG.egressProxy = pool[0];  // 保留一个用于 WS 隧道等单代理场景
    const list = pool.map(p => p.kind + '://' + p.host + ':' + p.port + (p.username ? ' (带认证)' : '')).join(' | ');
    console.log('[代理] 出口代理池(' + EGRESS_AGENTS.length + '): ' + list);
  } else {
    console.log('[代理] 未配置代理（直连）');
  }
}

// ===================== 通用小工具 =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// LightVela 后端统一返回 {code:"OK", data:{...}}；这里把 data 拆出来（data 缺失时原样返回）
function unwrapData(j) {
  if (j && typeof j === 'object' && j.data !== undefined) return j.data;
  return j;
}
// 从若干候选键里挑出第一个数组（兼容 items / passes / bundles 等不同字段名）
function pickArray(d, keys) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') for (const k of keys) if (Array.isArray(d[k])) return d[k];
  return null;
}
// 一个 pass 是否"有效"（未删除且未过期）
function passAlive(p) {
  if (!p || p.deleted_time) return false;
  if (!p.expired_time) return true;
  const t = new Date(p.expired_time).getTime();
  return !isNaN(t) ? t > Date.now() : true;
}

// Hermes 后端启动脚本（ensure_opencraft_hermes_backend），从 companion 前端 PtyStart 抓包提取。
// 前端原样：openPty({program:'/bin/sh', args:['-c', Vi() + ' exec /bin/sh -i']})
let PTY_START_FN = process.env.LIGHTVELA_PTY_FN || '';
if (!PTY_START_FN) {
  try { PTY_START_FN = require('./lv-ptystart-fn.js').ptyStartFn || ''; } catch (e) {
    console.log('[警告] 未找到 lv-ptystart-fn.js，PtyStart 将无法启动 Hermes 后端');
  }
}

// ===================== HubStudio 本地 API（仅用于成功后关环境） =====================
const HS_BASE = 'http://127.0.0.1:6873';
const HS_H = { 'Authorization': 'NULL', 'Accept-Language': 'zh-CN', 'Content-Type': 'application/json' };
async function stopBrowser(containerCode) {
  try {
    const r = await fetch(HS_BASE + '/api/v1/browser/stop', { method: 'POST', headers: HS_H, body: JSON.stringify({ containerCode }) });
    const j = await r.json();
    console.log('[HS] browser/stop', containerCode, '=>', JSON.stringify(j).slice(0, 120));
  } catch (e) { console.log('[HS] browser/stop 失败:', e.message); }
}

// ===================== BSON 编解码 =====================
// ★★ 2026-10-10 关键实证（推翻旧「自造 TLV」假设）★★
//   TAT 中继帧根本不是自造 TLV，而是【标准 BSON】（前端 a-DOq8azvI.js 里 sendBson() 调 bson 包的 serialize）。
//   已用实抓帧逐字节比对：用标准 BSON 重建的 PtyProxyNew 与抓包 225 字节 100% 一致。
//   帧结构：
//     { Type: "PtyProxyNew",
//       Data: { SessionId, ChannelId, CustomData: "",
//               Data: { ProxyId, Ip: "127.0.0.1", Port: "9119" } } }        ← PtyProxyNew（内层是 doc）
//     { Type: "PtyProxyData",
//       Data: { SessionId, ChannelId, CustomData: "",
//               Data: { ProxyId, Data: <BSON Binary, subtype 0 = 隧道原始字节> } } }
//   注意：Seq 字段只在【服务端→客户端】方向出现；客户端方向不带 Seq。
//   WebSocket 帧类型：BSON 帧 = 二进制(opcode 2)；SessionAuth/PtyStart/PtyStop 等 = 文本 JSON(opcode 1)。
function bsonI32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; }
function bsonCStr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0x00])]); }
// 0x02 字符串：len 含结尾 \0
function bsonStr(name, v) {
  const u = Buffer.from(String(v), 'utf8');
  return Buffer.concat([Buffer.from([0x02]), bsonCStr(name), bsonI32(u.length + 1), u, Buffer.from([0x00])]);
}
// 0x03 嵌套文档：直接把【整段文档字节(自带长度+结尾\0)】拼进去
function bsonDocEl(name, docBuf) { return Buffer.concat([Buffer.from([0x03]), bsonCStr(name), docBuf]); }
// 0x05 二进制：int32 长度 + 1 字节 subtype + 裸字节
function bsonBin(name, buf, sub = 0) { return Buffer.concat([Buffer.from([0x05]), bsonCStr(name), bsonI32(buf.length), Buffer.from([sub]), buf]); }
// 拼一个完整 BSON 文档：int32 总长(含自身与结尾\0) + 各元素 + 0x00
function bsonDoc(elements) {
  const body = Buffer.concat(elements);
  return Buffer.concat([bsonI32(body.length + 5), body, Buffer.from([0x00])]);
}
// 解码一个 BSON 文档 → {字段名: 值}（doc 递归、bin 保留 Buffer）
function bsonDecode(buf, start = 0) {
  const total = buf.readInt32LE(start);
  const end = start + total - 1;               // 去掉结尾 0x00
  const out = {};
  let i = start + 4;
  while (i < end) {
    const type = buf[i]; i += 1;
    const nul = buf.indexOf(0x00, i);
    if (nul === -1) break;
    const name = buf.slice(i, nul).toString('utf8'); i = nul + 1;
    if (type === 0x02) { const len = buf.readInt32LE(i); i += 4; out[name] = buf.slice(i, i + len - 1).toString('utf8'); i += len; }
    else if (type === 0x03) { const dl = buf.readInt32LE(i); out[name] = bsonDecode(buf, i); i += dl; }
    else if (type === 0x05) { const len = buf.readInt32LE(i); i += 4; const sub = buf[i]; i += 1; out[name] = buf.slice(i, i + len); out[name + '__sub'] = sub; i += len; }
    else if (type === 0x12) { out[name] = Number(buf.readBigInt64LE(i)); i += 8; }
    else if (type === 0x10) { out[name] = buf.readInt32LE(i); i += 4; }
    else if (type === 0x01) { out[name] = buf.readDoubleLE(i); i += 8; }
    else if (type === 0x08) { out[name] = buf[i] !== 0; i += 1; }
    else if (type === 0x0A) { out[name] = null; }
    else { out['__unknown'] = '0x' + type.toString(16) + '@' + (i - 1); break; }
  }
  return out;
}

// 从 PtyProxyData 帧里抽隧道 TCP 字节
// ★ 实测结构（服务端→客户端，BSON 解码确认）：
//   { Type, Seq, Data: { SessionId, ChannelId, CustomData, Data: { ProxyId, Data: <BSON Binary> } } }
//   即隧道字节在【三层】：fields.Data.Data.Data —— 少一层就会取到内层文档对象而非 Buffer。
function extractTunnelBytes(fields) {
  try {
    const inner = fields.Data && fields.Data.Data;          // 内层文档 {ProxyId, Data:<bin>}
    if (inner && Buffer.isBuffer(inner.Data)) return inner.Data;
    if (Buffer.isBuffer(fields.Data && fields.Data.Data)) return fields.Data.Data; // 兼容二层结构
    return null;
  } catch (e) { return null; }
}

// ===================== 最小 WebSocket 客户端（外层 TAT 中继用） =====================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
/**
 * 在裸 socket(tls/net) 上跑一个最小 WS 客户端。
 * 自动处理握手、掩码发送、解帧。返回 {send, close} 并回调 onOpen/onMessage/onClose/onError。
 */
function createWSConn({ host, port, path, useTls, proxy }, handlers) {
  let sock = null;
  let destroyed = false;
  const key = crypto.randomBytes(16).toString('base64');
  let hsDone = false;
  let buf = Buffer.alloc(0);
  let frags = [];          // 接收侧分片拼接（文本/二进制）
  let fragOp = 0;

  function parseFrames() {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
      let mask = null;
      if (masked) { if (buf.length < p + 4) break; mask = buf.slice(p, p + 4); p += 4; }
      if (buf.length < p + len) break;
      let payload = buf.slice(p, p + len);
      if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i % 4]; payload = o; }
      buf = buf.slice(p + len);
      if (opcode === 0x8) { handlers.onClose && handlers.onClose(); sock.end(); return; }
      if (opcode === 0x9) { sock.write(Buffer.from([0x8a, len])); continue; } // ping -> pong
      if (opcode === 0xa) continue;                                            // pong
      if (opcode === 0x0) { frags.push(payload); if (b0 & 0x80) { const full = Buffer.concat(frags); frags = []; handlers.onMessage && handlers.onMessage(full, fragOp); } }
      else { if (b0 & 0x80) { handlers.onMessage && handlers.onMessage(payload, opcode); } else { frags.push(payload); fragOp = opcode; } }
    }
  }

  // ★ 2026-10-10 修复(实测卡死根因)：TLS 连接必须在 secureConnect 后才能发 WS 升级请求；
  //   若在 'connect'(仅 TCP 建立、TLS 尚未握手完) 时 write，请求会丢失 → 中继不回 101 → onOpen 永不触发。
  //   非 TLS 仍用 'connect'。
  const writeHandshake = () => {
    console.log('[WS] ' + (useTls ? 'TLS 就绪' : 'TCP 已连接') + ' → 发 WS 升级请求 ' + host + ':' + port + path);
    const req =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    sock.write(req);
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!hsDone) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = buf.slice(0, idx).toString();
      if (!/101/.test(header)) { handlers.onError && handlers.onError(new Error('WS 握手失败: ' + header.split('\r\n')[0])); sock.end(); return; }
      buf = buf.slice(idx + 4);
      hsDone = true;
      handlers.onOpen && handlers.onOpen();
    }
    parseFrames();
  };
  const attach = (s, readyEvent) => {
    sock = s;
    s.on('data', onData);
    s.on('error', (e) => handlers.onError && handlers.onError(e));
    s.on('close', () => handlers.onClose && handlers.onClose());
    if (readyEvent) s.on(readyEvent, writeHandshake);
  };

  // ★ 出口代理：经环境代理钻隧道后再握手，做到出口 IP = 环境 IP（账号隔离）
  if (proxy) {
    console.log('[WS] 经出口代理连接 ' + host + ':' + port + '  ←  ' + proxy.kind + '://' + proxy.host + ':' + proxy.port);
    connectTunnel({ proxy, targetHost: host, targetPort: port }).then((raw) => {
      if (destroyed) { try { raw.destroy(); } catch (_) {} return; }
      if (useTls) {
        const t = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false });
        attach(t, 'secureConnect');
      } else {
        attach(raw, null);
        writeHandshake();     // 裸 socket 经代理后已连通，直接发 WS 握手
      }
    }).catch((e) => handlers.onError && handlers.onError(e));
  } else {
    const s = useTls ? tls.connect(port, host, { rejectUnauthorized: false }) : net.connect(port, host);
    attach(s, useTls ? 'secureConnect' : 'connect');
  }

  return {
    send(data, opcode = 0x2) {
      if (!sock) { console.log('[WS] 连接尚未就绪，丢弃一帧'); return; }
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const len = b.length;
      const mask = crypto.randomBytes(4);
      let header;
      if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = b[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    },
    close() { destroyed = true; try { if (sock) sock.write(Buffer.from([0x88, 0x00])); } catch (e) {} try { if (sock) sock.end(); } catch (e) {} },
  };
}

// 内层 Hermes 不需要单独 socket——它走隧道字节流。下面两个函数直接操作"隧道收包缓冲"。
function wsEncodeClientFrame(text) {
  // 生成一条【带掩码】的文本帧（客户端→服务端必须掩码）
  const b = Buffer.from(text, 'utf8');
  const len = b.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = b[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
// 从隧道 TCP 缓冲里解【服务端发来、不掩码】的 WS 帧，返回 {msgs, rest}
function wsParseServerFrames(buf) {
  const msgs = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 2) break;
    const b0 = buf[i], b1 = buf[i + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = i + 2;
    if (len === 126) { if (buf.length - i < 4) break; len = buf.readUInt16BE(i + 2); p = i + 4; }
    else if (len === 127) { if (buf.length - i < 10) break; len = Number(buf.readBigUInt64BE(i + 2)); p = i + 10; }
    if (masked) p += 4; // 理论上服务端不掩码，但兜底跳过
    if (buf.length - i < p + len) break;
    const payload = buf.slice(p, p + len);
    i = p + len;
    if (opcode === 0x1 || opcode === 0x2) msgs.push(payload.toString('utf8'));
    // 忽略 ping/pong/close/continuation（内层简单场景够用）
  }
  return { msgs, rest: buf.slice(i) };
}

// ===================== 国内版：豪猪接码 + 手机号登录 + 实名 =====================
// 豪猪接码平台（ShowDoc 全部接口 = GET + 查询参数）。
// 配置来源：环境变量（由 domestic_core 注入，UI 里改了立即生效，无需改代码）。
//   LIGHTVELA_SMS_API_BASE     例：https://api.haozhuma.com（备用 api.haozhuyun.com）
//   LIGHTVELA_SMS_USER         API 账号（h5.haozhuma.com「API-配置」里复制）
//   LIGHTVELA_SMS_PASS         API 密码
//   LIGHTVELA_SMS_PROJECT_ID   项目编号（默认 21986 = 腾讯云 / 腾讯云短信）
const SMS_HAOZHUMA = {
  apiBase:   process.env.LIGHTVELA_SMS_API_BASE || 'https://api.haozhuma.com',
  apiUser:   process.env.LIGHTVELA_SMS_USER     || 'f632fc95683bd65352623febb154ffcae6550a33178a18c65921060810d0571c',
  apiPass:   process.env.LIGHTVELA_SMS_PASS     || '284d033beb03583ba15948792383e03683e36a6c90cf0c63a1ca767a2d70c2f6',
  projectId: parseInt(process.env.LIGHTVELA_SMS_PROJECT_ID || '21986', 10),
  _token: null,
  async login() {
    if (this._token) return this._token;
    const url = `${this.apiBase}/sms/?api=login&user=${encodeURIComponent(this.apiUser)}&pass=${encodeURIComponent(this.apiPass)}`;
    const j = await (await fetch(url)).json();
    if (Number(j.code) !== 0 && j.code !== '0' && j.code !== 200) throw new Error('豪猪登录失败: ' + JSON.stringify(j));
    this._token = j.token;
    return this._token;
  },
  async rentNumber() {
    const token = await this.login();
    const j = await (await fetch(`${this.apiBase}/sms/?api=getPhone&token=${token}&sid=${this.projectId}`)).json();
    if (Number(j.code) !== 0 && j.code !== '0') throw new Error('豪猪取号失败: ' + JSON.stringify(j));
    return j.phone;
  },
  async getCode(phone, { timeoutMs = 180000, intervalMs = 15000 } = {}) {
    const token = await this.login();
    const url = `${this.apiBase}/sms/?api=getMessage&token=${token}&sid=${this.projectId}&phone=${phone}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const j = await (await fetch(url)).json();
      // ★ 只在拿到合法验证码（4~8 位纯数字）时才返回；0 / 空 / 非数字一律视为「还没收到」，继续轮询。
      //   修复：豪猪返回 code=0/yzm=0 这类「未收到」信号曾被误当成验证码（徐彦如案例拿到「验证码: 0」，
      //        拿 0 去 verify 白跑、且把号拉黑废掉）；现改为只认真码，收不到就超时走换号重试。
      const yzm = (j.yzm != null && String(j.yzm)) ||
                  (j.sms && (j.sms.match(/(\d{4,8})/) || [])[1]) || '';
      if (/^\d{4,8}$/.test(yzm)) return yzm;
      await sleep(intervalMs);
    }
    throw new Error('豪猪取码超时（' + (timeoutMs / 1000) + 's 内无验证码）');
  },
  async release(phone) { const t = await this.login(); await fetch(`${this.apiBase}/sms/?api=cancelRecv&token=${t}&sid=${this.projectId}&phone=${phone}`); },
  async blacklist(phone) { const t = await this.login(); await fetch(`${this.apiBase}/sms/?api=addBlacklist&token=${t}&sid=${this.projectId}&phone=${phone}`); },
  async balance() { const t = await this.login(); const j = await (await fetch(`${this.apiBase}/sms/?api=getSummary&token=${t}`)).json(); return j.money; },
};

// ===================== 国内版：飞狐接码（与豪猪并存，按 LIGHTVELA_SMS_PROVIDER 切换）=====================
// 飞狐 API 文档：https://my.feihu2026.com/document
//   基础地址：http://api.feihu2026.com/api/sms（备用 se/by/vx/dx/lt/yd/hk 等子域，连不上自动换下一个）
//   认证：/login?user=<api_key>&pass=<API密钥> -> data.token（长期有效，缓存即可）
//   取号：/getPhone?token=&pid=<项目ID>&... -> phone + order_id
//   轮询：/getMessage?token=&order_id= -> data.status: 1等待 / 3已收到(data.code) / 4失败 / 5已释放 / 6超时；间隔>=10s
//   释放：/cancelRecv?token=&order_id=      加黑：/addBlackList?token=&order_id=
//   余额：/userInfo?token= -> data.money
//   通用返回：{code:200, msg:"OK", data:{...}}
const SMS_FEIHU = {
  // 备用域名数组：主域连不上自动换下一个（只换一次，避免对"已发出未超时"的请求重复取号）
  apiBases: (process.env.LIGHTVELA_FEIHU_API_BASE || 'http://api.feihu2026.com/api/sms')
              .split(',').map(s => s.trim()).filter(Boolean),
  apiKey:    process.env.LIGHTVELA_FEIHU_API_KEY     || '',
  apiSecret: process.env.LIGHTVELA_FEIHU_API_SECRET  || '',
  projectId: process.env.LIGHTVELA_FEIHU_PROJECT_ID  || '',
  _token: null,
  _orderByPhone: {},   // phone -> order_id：飞狐按订单释放/拉黑，不是按手机号
  _baseIdx: 0,
  _base() { return this.apiBases[this._baseIdx % this.apiBases.length]; },
  async _get(path) {
    const tryOnce = async (base) => {
      const url = base + path;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LightVela' } });
      const t = await r.text();
      try { return JSON.parse(t); } catch (e) { return {}; }
    };
    try {
      return await tryOnce(this._base());
    } catch (e) {
      // 网络层失败（ENOTFOUND/ETIMEDOUT/ECONNREFUSED）：换下一个备用域名重试一次
      this._baseIdx++;
      console.log('  [飞狐] 域名 ' + this._base() + ' 连接失败，切换备用域名重试…');
      try { return await tryOnce(this._base()); }
      catch (e2) { throw new Error('飞狐请求失败: ' + e2.message); }
    }
  },
  async login() {
    if (this._token) return this._token;
    if (!this.apiKey || !this.apiSecret) throw new Error('飞狐未配置（缺少 apiKey / API密钥）');
    const j = await this._get('/login?user=' + encodeURIComponent(this.apiKey) + '&pass=' + encodeURIComponent(this.apiSecret));
    if (Number(j.code) !== 200) throw new Error('飞狐登录失败: ' + JSON.stringify(j));
    this._token = j.data && j.data.token;
    if (!this._token) throw new Error('飞狐登录返回无 token: ' + JSON.stringify(j));
    return this._token;
  },
  async rentNumber() {
    const token = await this.login();
    if (!this.projectId) throw new Error('飞狐未配置项目 ID（pid）');
    const j = await this._get('/getPhone?token=' + encodeURIComponent(token) + '&pid=' + encodeURIComponent(this.projectId));
    if (Number(j.code) !== 200) throw new Error('飞狐取号失败: ' + JSON.stringify(j));
    const phone = j.data && j.data.phone;
    const order = j.data && j.data.order_id;
    if (!phone) throw new Error('飞狐取号返回无手机号: ' + JSON.stringify(j));
    this._orderByPhone[phone] = order;   // 记下订单号，释放/拉黑要用
    return phone;
  },
  async getCode(phone, { timeoutMs = 180000, intervalMs = 15000 } = {}) {
    const token = await this.login();
    const order = this._orderByPhone[phone];
    if (!order) throw new Error('飞狐取码缺少 order_id（该号非本次取号所得）: ' + phone);
    if (intervalMs < 10000) intervalMs = 10000;   // 飞狐硬性要求轮询间隔 >=10s
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const j = await this._get('/getMessage?token=' + encodeURIComponent(token) + '&order_id=' + encodeURIComponent(order));
      if (Number(j.code) !== 200) throw new Error('飞狐取码接口错误: ' + JSON.stringify(j));
      const st = Number(j.data && j.data.status);
      if (st === 3) {
        // 已收到：优先取 data.code，取不到再从短信正文里抠 4~8 位数字
        const code = (j.data && (j.data.code != null ? String(j.data.code) : '')) ||
                     (j.data && j.data.message ? (j.data.message.match(/(\d{4,8})/) || [])[1] : '') || '';
        if (/^\d{4,8}$/.test(code)) return code;
      } else if (st === 4 || st === 6) {
        throw new Error('飞狐短信获取失败(状态' + st + '): ' + JSON.stringify(j.data || j));
      } else if (st === 5) {
        throw new Error('飞狐号码已被释放(状态5): ' + JSON.stringify(j.data || j));
      }
      await sleep(intervalMs);   // 状态 1（等待中）继续轮询
    }
    throw new Error('飞狐取码超时（' + (timeoutMs / 1000) + 's 内无验证码）');
  },
  async release(phone) {
    const token = await this.login();
    const order = this._orderByPhone[phone];
    if (!order) return;
    await this._get('/cancelRecv?token=' + encodeURIComponent(token) + '&order_id=' + encodeURIComponent(order));
  },
  async blacklist(phone) {
    const token = await this.login();
    const order = this._orderByPhone[phone];
    if (!order) return;
    await this._get('/addBlackList?token=' + encodeURIComponent(token) + '&order_id=' + encodeURIComponent(order));
  },
  async balance() {
    const token = await this.login();
    const j = await this._get('/userInfo?token=' + encodeURIComponent(token));
    if (Number(j.code) !== 200) throw new Error('飞狐查余额失败: ' + JSON.stringify(j));
    const m = j.data && j.data.money;
    return (m != null ? m : '未知');
  },
};

// ===================== 国内版：鲁班接码（与豪猪/飞狐并存，按 LIGHTVELA_SMS_PROVIDER 切换）=====================
// 鲁班 API 文档：https://lubansms.com/api_docs/
//   基础地址：https://lubansms.com/v2/api（所有请求 GET + apikey 参数，免登录）
//   取号：/getNumber?apikey=&service_id=<服务编号> -> number + request_id（service_id 指定国家+应用，+86 中国编号在面板填）
//   轮询：/getSms?apikey=&request_id= -> {code:0,msg:"wait"} 等待 / {code:0,msg:"success",sms_code:"..."} 收到 / {code:400} 超时或 apikey 错
//   释放：/setStatus?apikey=&request_id=&status=reject（鲁班无独立拉黑，释放即弃号）
//   余额：/getBalance?apikey= -> {code:0,balance:"96.72"}
// ★ 从短信内容里抠验证码（2026-10-26 新增）
//   兼容两种返回：① 纯码（官方文档格式）"380682"
//                 ② 整条短信原文（cn7 通道实际返回）"【腾讯云】871226 腾讯云注册短信验证码，5分钟内有效！"
function pickLubanSmsCode(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^\d{4,8}$/.test(s)) return s;                        // ① 本身就是纯码
  // 候选：所有 4~8 位数字，先排除「5分钟 / 60秒」这类时效数字
  const cands = (s.match(/\d{4,8}/g) || []).filter((d) =>
    !new RegExp(d + '\\s*(?:分钟|分|秒|小时|min|sec|hour)', 'i').test(s));
  if (!cands.length) return '';
  if (cands.length === 1) return cands[0];
  // 多个候选：先看「验证码」字样后面紧跟的数字，再看它前面最近的数字
  const KW = /(?:验证码|校验码|动态码|确认码|verification\s*code|code)/gi;
  let m;
  while ((m = KW.exec(s)) !== null) {                      // ① 关键词后面的（「验证码 654321」「验证码是 123456」）
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const nums = tail.match(/\d{4,8}/g);
    if (nums && cands.indexOf(nums[0]) >= 0) return nums[0];
  }
  KW.lastIndex = 0;
  while ((m = KW.exec(s)) !== null) {                      // ② 关键词前面的（「871226 腾讯云注册短信验证码」）
    const head = s.slice(Math.max(0, m.index - 24), m.index);
    const nums = head.match(/\d{4,8}/g);
    if (nums && cands.indexOf(nums[nums.length - 1]) >= 0) return nums[nums.length - 1];
  }
  // 再退一步：国内验证码基本都是 6 位
  const six = cands.filter((d) => d.length === 6)[0];
  return six || cands[0];
}

const SMS_LUBAN = {
  apiBase: process.env.LIGHTVELA_LUBAN_API_BASE || 'https://lubansms.com/v2/api',
  apiKey:  process.env.LIGHTVELA_LUBAN_API_KEY     || '',
  serviceId: process.env.LIGHTVELA_LUBAN_SERVICE_ID  || '',
  _reqIdByPhone: {},   // phone -> request_id：鲁班按 request_id 取码/释放，不是按手机号
  async login() {
    if (!this.apiKey) throw new Error('鲁班未配置（缺少 apiKey）');
    return null;   // 鲁班免登录，每个请求直接带 apikey，无需 token
  },
  async _get(path) {
    if (!this.apiKey) throw new Error('鲁班未配置（缺少 apiKey）');
    const sep = path.includes('?') ? '&' : '?';
    const url = this.apiBase.replace(/\/+$/, '') + path + sep + 'apikey=' + encodeURIComponent(this.apiKey);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LightVela' } });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return {}; }
  },
  async rentNumber() {
    await this.login();
    if (!this.serviceId) throw new Error('鲁班未配置服务 ID（service_id，+86 中国编号在面板填）');
    const j = await this._get('/getNumber?service_id=' + encodeURIComponent(this.serviceId));
    if (Number(j.code) !== 0) throw new Error('鲁班取号失败: ' + JSON.stringify(j));
    const rawPhone = j.number;
    const rid = j.request_id;
    if (!rawPhone) throw new Error('鲁班取号返回无手机号: ' + JSON.stringify(j));
    // ★ 鲁班把 +86 国家前缀一并返回（如 +8617155647680），剥掉前缀只留 11 位裸大陆号，
    //   与豪猪/飞狐（返回裸号）保持一致——既不会被「非大陆号码」过滤器误杀，发码/验证也用裸号。
    const phone = normalizeMainlandPhone(rawPhone);
    this._reqIdByPhone[phone] = rid;   // 记下 request_id（按裸号存），取码/释放要用
    return phone;
  },
  async getCode(phone, { timeoutMs = 180000, intervalMs = 15000 } = {}) {
    await this.login();
    const rid = this._reqIdByPhone[phone];
    if (!rid) throw new Error('鲁班取码缺少 request_id（该号非本次取号所得）: ' + phone);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const j = await this._get('/getSms?request_id=' + encodeURIComponent(rid));
      if (Number(j.code) !== 0) throw new Error('鲁班取码接口错误: ' + JSON.stringify(j));
      const msg = j.msg;
      if (msg === 'success') {
        // ★ 2026-10-26 修复：鲁班 cn7 通道把「整条短信原文」塞进 sms_code
        //   （如「【腾讯云】871226 腾讯云注册短信验证码，5分钟内有效！」），不是纯数字。
        //   旧代码只认 /^\d{4,8}$/ 纯数字 → 码早到了却一直当「没收到」，空转 180s 后误判超时。
        const code = pickLubanSmsCode(j.sms_code);
        if (code) return code;
        throw new Error('鲁班已收到短信但抠不出验证码: ' + JSON.stringify(j));
      } else if (msg === 'wait') {
        // 等待中，继续轮询
      } else {
        throw new Error('鲁班短信获取失败: ' + JSON.stringify(j));
      }
      await sleep(intervalMs);
    }
    throw new Error('鲁班取码超时（' + (timeoutMs / 1000) + 's 内无验证码）');
  },
  async release(phone) {
    const rid = this._reqIdByPhone[phone];
    if (!rid) return;
    await this._get('/setStatus?request_id=' + encodeURIComponent(rid) + '&status=reject');
  },
  async blacklist(phone) {
    // 鲁班无独立拉黑接口，释放即弃号（setStatus?status=reject）
    await this.release(phone);
  },
  async balance() {
    const j = await this._get('/getBalance');
    if (Number(j.code) !== 0) throw new Error('鲁班查余额失败: ' + JSON.stringify(j));
    return (j.balance != null ? j.balance : '未知');
  },
};

// ★ 平台选择器：LIGHTVELA_SMS_PROVIDER=haozhuma(默认) | feihu | lubansms，选哪套哪套生效；三套实现并存、互不干扰
const SMS_PROVIDER = (process.env.LIGHTVELA_SMS_PROVIDER || 'haozhuma').toLowerCase();
const SMS = SMS_PROVIDER === 'feihu' ? SMS_FEIHU
          : SMS_PROVIDER === 'lubansms' ? SMS_LUBAN
          : SMS_HAOZHUMA;

// 账号清单从独立文件加载（单一数据源，批量调度器也 require 它）
// 支持环境变量 LIGHTVELA_ACCOUNTS_FILE 覆盖（UI 传入临时账号列表时用，避免改默认 accounts.js 干扰后台批量）
let ACCOUNTS = [];
try { ACCOUNTS = require(process.env.LIGHTVELA_ACCOUNTS_FILE || './accounts.js'); }
catch (e) { ACCOUNTS = []; }   // ★ 活跃探测模式不需要账号名单，缺文件不报错

// 要抢的套餐（2026-10-22 实勘：网站当前只放行 bundle_free_trial_01，故默认改它）
const BUNDLE_ID = process.env.LIGHTVELA_BUNDLE_ID || 'bundle_launch_ai_01'; // 死代码：实际取用见 restSubscribe 里 process.env.LIGHTVELA_BUNDLE_ID；默认改为真实存在的 0 元包
const INSTANCE_NAME = process.env.LIGHTVELA_INSTANCE_NAME || '我的 AI 伙伴';

// 部署：命令/话术整段从文件读（老大自己编辑该文件，程序只负责"发出去 + 等回复"）
const DEPLOY_MSG_FILE = process.env.LIGHTVELA_DEPLOY_FILE || 'deploy_cmd.txt';
const DEPLOY_OK_PHRASE = '部署完成，探针服务运行正常';
const DEPLOY_WAIT_MS = parseInt(process.env.LIGHTVELA_DEPLOY_WAIT_MS || String(40 * 60 * 1000), 10);

// F 主动验证：部署判定未命中时，让机器人自己查探针进程/服务状态，最后一行给机器可读答案
//   （判成败不看措辞，看实际进程/服务状态 —— 比"听机器人自述部署成功"可靠得多）
const DEFAULT_VERIFY_MSG = '请检查探针服务的运行状态：先运行 systemctl list-units --type=service --all | grep -i probe，再运行 ps aux | grep -i probe。看完输出后，在回复的最后一行只输出一行：PROBE_STATUS=RUNNING （表示探针服务正在运行）或 PROBE_STATUS=NOT_RUNNING （表示探针服务没有运行）。';

function readDeployMsg() {
  if (!fs.existsSync(DEPLOY_MSG_FILE)) throw new Error('部署消息文件不存在: ' + DEPLOY_MSG_FILE + '（把整段部署命令+话术贴进去）');
  const t = fs.readFileSync(DEPLOY_MSG_FILE, 'utf8').trim();
  if (!t) throw new Error('部署消息文件为空: ' + DEPLOY_MSG_FILE);
  return t;
}

// ★ 判定"部署成功"：先把回复里的格式符号全剥掉再比对 —— 规避机器人加粗、变色、换行、
//   全角字符、数学花体/粗体字母、表情符号、零宽字符等造成的漏判。
//   NFKC 归一化负责 全角→半角、𝐀/𝔸→A、①→1；最后只留中文+字母数字，其余（含 emoji/标点）全删。
function stripFormat(s) {
  return String(s || '')
    .normalize('NFKC')                             // 全角→半角、数学花体/粗体字母→常规字符
    .replace(/<[^>]*>/g, '')                       // HTML 标签
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')   // 零宽字符
    .replace(/[*_`#~>|]/g, '')                     // Markdown 标记
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbf0-9A-Za-z]/g, ''); // 表情/标点/符号全剥掉，只留中文+字母数字
}
// 判成功两条路：① 原句（剥干净后）命中最保险；② 关键词组合——机器人措辞不固定
//   （"部署成功"/"探针服务正常"/字里插表情/花体字都可能），四组关键词各命中其一即算成功。
//   状态组刻意用"运行正常/正常运行"等复合词（不用单字"运行"），避免"未运行"被误判成成功。
const DEPLOY_OK_PHRASE_CLEAN = stripFormat(DEPLOY_OK_PHRASE);
const DEPLOY_OK_KEYWORDS = [
  /部署|安装|配置|跑通|上线|deploy|install/i,               // ① 动作
  /完成|成功|已就绪|搞定/,                                  // ② 结果（正面词，不含"失败"）
  /探针|probe/i,                                          // ③ 对象
  /运行正常|正常运行|服务正常|活跃|online|running/i,        // ④ 状态（复合词防"未运行"误判）
];
function isDeployOk(replyText) {
  const t = stripFormat(replyText);
  if (!t) return false;
  if (t.includes(DEPLOY_OK_PHRASE_CLEAN)) return true;
  return DEPLOY_OK_KEYWORDS.every((g) => g.test(t));
}

// F 主动验证：从验证回复里解析机器可读结论（true=探针在运行 / false=未运行 / null=无法判定）
function parseVerifyResult(text) {
  const t = stripFormat(text);
  if (!t) return null;
  if (/PROBESTATUSNOTRUNNING/i.test(t)) return false;   // 先判否定（NOT_RUNNING 里含 RUNNING）
  if (/PROBESTATUSRUNNING/i.test(t)) return true;
  if (/未运行|没有运行|不存在|没有.{0,4}(找到|发现|看到)|未.{0,2}找到|未启动|未安装|未部署|inactive|dead/i.test(t)) return false;
  if (/正在运行|运行中|正常运行|已运行|已启动|active|running/i.test(t)) return true;
  return null;
}

// 国内版登录全流程：取号 → 发码 → 取码 → 验码 → 实名 → Bearer 写进 CFG
// 号源重试（最多 MAX_RENT 次）：① 取到号但等满 timeout 仍收不到验证码 → 拉黑该号 → 重新取号；
//   ② 取号本身失败（豪猪「没有取到号码」= 项目临时无号源/限流，纯瞬时）→ 退避后重新取号。
//   只有验码/实名/网络等非号源错误才直接抛出（换号没用）。

// ★ 并发发码错峰门控：多账号同时跑时，两次发短信请求之间至少间隔 SEND_GAP_MS（默认 30s），
//   避免一起打平台触发「发送过于频繁」。基于 /data 下的原子锁 + 时间戳文件（各账号子进程跨进程共享）。
const SMS_GATE_DIR = process.env.LIGHTVELA_SMS_GATE_DIR || '/data';
const SMS_GATE_LOCK = SMS_GATE_DIR + '/.domestic_sms_gate.lock';
const SMS_GATE_TS = SMS_GATE_DIR + '/.domestic_sms_gate.ts';
function _smsGateCleanStale() {
  try {
    const st = fs.statSync(SMS_GATE_LOCK);
    if (Date.now() - st.mtimeMs > 180000) { try { fs.rmdirSync(SMS_GATE_LOCK); } catch (e) {} }  // 清理残留锁（>3min）
  } catch (e) {}
}
async function smsSendGate(gapMs) {
  try { fs.mkdirSync(SMS_GATE_DIR, { recursive: true }); } catch (e) {}  // 确保门控目录存在
  for (let i = 0; i < 1500; i++) {          // 最多等 1500*0.2s = 300s
    try {
      _smsGateCleanStale();
      fs.mkdirSync(SMS_GATE_LOCK);          // 原子拿锁
      let last = 0;
      try { last = JSON.parse(fs.readFileSync(SMS_GATE_TS, 'utf8')).t || 0; } catch (e) {}
      const wait = last + gapMs - Date.now();
      if (wait > 0) {
        console.log(`  ⏳ 发码错峰等待 ${Math.ceil(wait / 1000)}s（距上次发码不足间隔，避免被官方限频）…`);
        await sleep(wait);      // 距上次发码不足 gap 则补齐间隔
      }
      return;
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error('发码错峰门控获取超时');
}
function smsSendGateRelease() { try { fs.rmdirSync(SMS_GATE_LOCK); } catch (e) {} }
function smsSendGateTouch() { try { fs.writeFileSync(SMS_GATE_TS, JSON.stringify({ t: Date.now() })); } catch (e) {} }
// 返回限流类型代码（字符串），非限流返回 null。
//   'verification_provider_rate_limited' —— 出口IP被官方（腾讯云短信）限频（脏IP），重发换IP可解
//   其他（发送过于频繁 / rate_limit / too many 等）—— 非IP类限流，等满手机号冷却后通常可恢复
function getSendRateLimitType(json) {
  if (!json) return null;
  const s = JSON.stringify(json);
  if (/verification_provider_rate_limited/i.test(s)) return 'verification_provider_rate_limited';
  if (/发送过于频繁|rate_limit|too many/i.test(s)) return 'other';
  return null;
}
function isSendRateLimited(json) { return getSendRateLimitType(json) !== null; }

// ===================== 实名补救·跨进程身份占用标记 =====================
// 背景：接码登录成功后，原身份的 姓名/身份证 不匹配（realname_mismatch）时，要从「号码库」里再取一条
//       「排队中、还没被注册」的身份补做实名的。多个账号是并发的子进程，必须保证：
//       ① 被补救占用的身份，不能再被它「自己的」注册子进程拿去注册（否则同一身份证绑两个账号）；
//       ② 一条脏数据（本身姓名/身份证就不匹配）不会反复被不同账号当补救候选浪费次数。
// 实现：一个共享的 domestic-claims.json（按账号序号索引），配 .lock 文件锁做互斥；谁先抢到标记谁用。
const CLAIMS_FILE = process.env.LIGHTVELA_DOMESTIC_CLAIMS
  || path.join(path.dirname(process.env.LIGHTVELA_ACCOUNTS_FILE || __filename), 'domestic-claims.json');
const CLAIMS_LOCK = CLAIMS_FILE + '.lock';

function _loadClaims() {
  try { return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); } catch (e) { return {}; }
}
function _saveClaims(obj) {
  // 原子写：先写临时文件再 rename，避免并发半写导致 JSON 损坏
  const tmp = CLAIMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE);
}
async function _withClaimsLock(fn) {
  // 简单文件锁：wx 独占创建，拿不到就短 sleep 重试；Linux/Windows 都支持
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const fd = fs.openSync(CLAIMS_LOCK, 'wx'); fs.closeSync(fd); break; }
    catch (e) {
      if (Date.now() > deadline) throw new Error('获取实名补救锁超时');
      await sleep(20);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(CLAIMS_LOCK); } catch (e) {} }
}

// 子进程启动时调用：把自己这条身份标记为「本进程自行注册中」；若已被别的账号补救占用 → 返回 'skipped' 直接跳过
async function markSelfRunning(idx) {
  return _withClaimsLock(() => {
    const claims = _loadClaims();
    if (claims[idx] && claims[idx].status === 'consumed') return 'skipped';
    claims[idx] = { status: 'self_registering', at: Date.now() };
    _saveClaims(claims);
    return 'ok';
  });
}
// 标记某条身份为「已作废」（脏数据：本身姓名/身份证不匹配，任何人都不该再拿它注册或补救）
async function markIdentityBad(idx) {
  return _withClaimsLock(() => {
    const claims = _loadClaims();
    claims[idx] = { status: 'bad', at: Date.now(), reason: 'realname_mismatch' };
    _saveClaims(claims);
  });
}
// 释放某条被补救占用的身份（仅在「请求异常、不等于脏数据」时调用，让其可被其他账号继续尝试）
async function releaseIdentity(idx) {
  return _withClaimsLock(() => {
    const claims = _loadClaims();
    if (claims[idx] && claims[idx].status === 'consumed' && claims[idx].reason === 'realname_recovery') {
      delete claims[idx];
      _saveClaims(claims);
    }
  });
}
async function markIdentityDone(idx) {
  return _withClaimsLock(() => {
    const claims = _loadClaims();
    claims[idx] = { status: 'done', at: Date.now() };
    _saveClaims(claims);
  });
}
// 补救时扫描号码库：取一条「完全空闲（无任何标记）」的身份占用之；优先取靠后的序号（更可能还在排队未启动）
// 返回 {idx,name,idCard} 或 null（没有可用排队身份）
async function claimNextQueuedIdentity(selfIdx) {
  return _withClaimsLock(() => {
    const claims = _loadClaims();
    const free = [];
    for (let k = 0; k < ACCOUNTS.length; k++) {
      if (k === selfIdx) continue;
      if (claims[k]) continue;          // 任何已标记（占用/注册中/作废/完成）都跳过
      free.push(k);
    }
    if (!free.length) return null;
    free.sort((a, b) => b - a);         // 靠后的优先：前面的批次大概率已在跑，留给它们自己注册更稳
    const k = free[0];
    claims[k] = { status: 'consumed', by: selfIdx, at: Date.now(), reason: 'realname_recovery' };
    _saveClaims(claims);
    return { idx: k, name: ACCOUNTS[k].name, idCard: ACCOUNTS[k].idCard };
  });
}

// 实名补救：原身份不匹配时，循环从号码库取排队身份补做实名，直到成功或耗尽
// 返回 {name,idCard,attemptId,claimedIdx}；无可用身份或多次仍不匹配则抛错（终止本次注册）
async function recoverRealname(selfIdx) {
  // 先把「原身份」标记为作废，避免它沦为别人的补救候选（它是脏数据）
  await markIdentityBad(selfIdx);
  const MAX_RECOVERY = Number(process.env.LIGHTVELA_REALNAME_RECOVERY_MAX || 5);
  for (let n = 1; n <= MAX_RECOVERY; n++) {
    const claim = await claimNextQueuedIdentity(selfIdx);
    if (!claim) {
      throw new Error('实名补救失败：号码库已无可用的排队身份（其余均已占用/已注册/已作废），终止本次注册');
    }
    console.log(`  🔁 实名补救#${n}：原身份不匹配，改用排队身份 ${claim.name}(${claim.idCard}) 重试实名…`);
    try {
      const rn = await httpsReq('POST', '/auth/realname/faceid/attempts', {
        body: { name: claim.name, idCard: claim.idCard, consent: true },
      });
      if (rn.json && rn.json.state === 'succeeded') {
        console.log('  ✅ 实名补救成功 | attemptId=', rn.json.attemptId, ' 实际身份=', claim.name);
        return { name: claim.name, idCard: claim.idCard, attemptId: rn.json.attemptId, claimedIdx: claim.idx };
      }
      // 该候选也不匹配 → 标记作废，继续下一个排队身份
      await markIdentityBad(claim.idx);
      console.log('  ⚠️ 补救候选', claim.name, '也不匹配，继续下一个排队身份…');
    } catch (e) {
      // 请求异常（网络等）≠ 脏数据，释放占用让其可被其他账号继续尝试
      await releaseIdentity(claim.idx);
      console.log('  ⚠️ 补救候选', claim.name, '实名请求异常：', e.message, '，释放后继续下一个…');
    }
  }
  throw new Error('实名补救失败：已尝试 ' + MAX_RECOVERY + ' 个排队身份仍无法完成实名，终止本次注册');
}

// ★ 接码平台（实测飞狐）偶尔混入香港/澳门号码（852/853 本地号，非 11 位，如 8 位的 44244437）。
//   大陆号判定规则（老大定）：1 开头、共 11 位即放行，不挑号段（165/170/162 等虚拟运营商号段照常用，
//   香港 852/澳门 853 的短号自然被挡）。同时兼容带 +86 国家前缀的写法（鲁班等平台会把前缀一并返回）。
function isMainlandPhone(phone) {
  return /^(\+?86)?1\d{10}$/.test(String(phone == null ? '' : phone).trim());
}

// ★ 把带国家前缀的号码规整成 11 位裸大陆号：剥掉前导 + 与 +86 前缀（鲁班返回的 +86171… 之类）。
//   香港 +852 / 澳门 +853 等其它国家码不会被误剥（只认「86 前缀 + 后面恰为 11 位大陆号」）。
function normalizeMainlandPhone(phone) {
  let p = String(phone == null ? '' : phone).trim();
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('86') && /^86\d{11}$/.test(p)) p = p.slice(2);
  return p;
}

async function domesticLogin(acc, idx) {
  console.log(`\n===== 账号: ${acc.name} (${acc.idCard}) =====`);
  const MAX_RENT = Number(process.env.LIGHTVELA_SMS_MAX_RENT || 3);          // 最多换几个号
  const MAX_REGION_RETRY = Number(process.env.LIGHTVELA_SMS_MAX_REGION_RETRY || 5); // 连续取到非大陆号的重取上限（平台号源异常时放弃本账号）
  const CODE_TIMEOUT_MS = Number(process.env.LIGHTVELA_SMS_CODE_TIMEOUT_MS || 180000); // 官方：超三分钟未收到验证码即拉黑重取
  const RESEND_WAIT_MS = Number(process.env.LIGHTVELA_SMS_RESEND_WAIT_MS || 60000);  // 发码限频后等 60s 同号重发
  const RESEND_MAX = Number(process.env.LIGHTVELA_SMS_RESEND_MAX || 5);             // 同号重发上限
  const SEND_GAP_MS = Number(process.env.LIGHTVELA_SMS_SEND_GAP_MS || 30000);       // 并发账号发码间隔 30s
  // 仅当并发>1 时才需要错峰；单账号（并发=1）无需等待，否则首账号会莫名其妙等最多30s
  const _domConc = Number(process.env.LIGHTVELA_DOMESTIC_CONCURRENCY || 1);
  const EFF_GAP_MS = _domConc > 1 ? SEND_GAP_MS : 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RENT; attempt++) {
    let phone = null;
    try {
      // ★ 2026-10-23：取到非大陆号（香港/澳门）→ 拉黑并重取，直到拿到 11 位大陆号为止。
      //   独立计数（MAX_REGION_RETRY）不占用 MAX_RENT 换号配额——取错地区是平台缺陷，不是号源质量问题。
      //   飞狐拉黑按订单走（addBlackList 同时释放进行中的订单），豪猪按手机号走，SMS.blacklist 已各自封装。
      for (let rr = 0; rr < MAX_REGION_RETRY; rr++) {
        phone = await SMS.rentNumber();
        console.log(`  手机号(取号#${attempt}${rr > 0 ? '-重取' + rr : ''}):`, phone);
        if (isMainlandPhone(phone)) break;
        try { await SMS.blacklist(phone); } catch (_) {}
        console.log(`  ⛔ 已拉黑非大陆号码（${String(phone).length} 位）：${phone}，重新取号…`);
        phone = null;
      }
      if (!phone) throw new Error('连续 ' + MAX_REGION_RETRY + ' 次取到非大陆号码（平台号源异常），放弃本账号');
      // —— 发码错峰门控 + 限频同号重发 ——
      // 门控：并发账号之间发短信请求至少间隔 SEND_GAP_MS（默认30s），避免被官方限频
      // 限频：若返回“发送过于频繁”，等 RESEND_WAIT_MS（默认60s）后用同一号码重发，最多 RESEND_MAX 次
      let sentOk = false;
      let lastRateJson = null;
      for (let resend = 0; resend <= RESEND_MAX; resend++) {
        if (resend > 0) {
          console.log(`  ⏳ 限频重发等待 ${RESEND_WAIT_MS / 1000}s（同一号码 ${phone}）…`);
          await sleep(RESEND_WAIT_MS);
        }
        await smsSendGate(EFF_GAP_MS);          // 拿锁并等够错峰间隔（仅并发>1 时生效）
        try {
          const sr = await httpsReq('POST', '/auth/sms/send', { body: { phone } });
          smsSendGateTouch();                     // 记录本次发码时间（成功/限频都记），供并发账号错峰
          const rlType = getSendRateLimitType(sr.json);
          if (rlType) {
            lastRateJson = sr.json;
            if (rlType === 'verification_provider_rate_limited') {
              // ★ 2026-10-26 老大定：出口IP被官方限频（脏IP）→ 直接判定本账号失败，不重试、不换号。
              //   实测代理 a.rr2.kdns.fr 是“每次新建连接换一个出口IP”，但本进程全程复用同一条隧道
              //   （lv-proxy.js: keepAlive + maxSockets:1 + 缓存 TLS socket），重发多少次都是同一个脏IP，
              //   硬重试只会白等 60s×N、白烧号码。下次重跑 = 新进程 = 新连接 = 新出口IP，自然就好了。
              console.log(`  ⛔ 限流类型=IP脏(${rlType})：出口IP被官方限频，直接判定失败（不重试/不换号），稍后重跑会自动换新出口IP`);
              if (phone) { try { await SMS.blacklist(phone); console.log('  ⛔ 已拉黑号码（IP脏放弃，号源一次性）:', phone); } catch (_) {} }
              throw new Error('IP脏限频：出口IP被官方限频，已放弃本次尝试（不重试/不换号）。稍后重跑会自动换新出口IP');
            } else {
              // 其他限流：非IP问题，保持原等待后重发即可
              console.log(`  ⚠️ 限流类型=其他(${rlType})：非IP类限流，保持 ${RESEND_WAIT_MS / 1000}s 等待后重发`);
            }
            continue;                             // 下一轮 resend（带 60s 等待）用同一号码重发
          }
          console.log('  已发验证码:', JSON.stringify(sr.json).slice(0, 120));
          sentOk = true;
          break;
        } finally {
          smsSendGateRelease();                   // 无论成功/失败都释放门控，避免死锁
        }
      }
      if (!sentOk) {
        // ★ 限频拉黑：同一号码重试上限仍被限频 → 拉黑该号（不再分配，防止二手号回收复用），换号重试
        lastErr = new Error('验证码发送过于频繁，已用同一号码重试 ' + RESEND_MAX + ' 次仍被限频: ' + JSON.stringify(lastRateJson).slice(0, 200));
        if (phone) { try { await SMS.blacklist(phone); console.log('  ⛔ 已拉黑号码（限频重试耗尽）:', phone); } catch (_) {} }
        console.log('  ⚠️ 该号限频重试耗尽，换号重试…');
        continue;   // 走 attempt++ 换号（至多 MAX_RENT 个号）
      }
      const code = await SMS.getCode(phone, { timeoutMs: CODE_TIMEOUT_MS });
      console.log('  验证码:', code);
      // ★ 取码成功也拉黑：号源即用即弃，防止被平台回收后再分给我们（二手号复用 = 风控）
      try { await SMS.blacklist(phone); console.log('  ⛔ 已拉黑号码（已成功取码，号源即用即弃）:', phone); } catch (_) {}
      const v = await httpsReq('POST', '/auth/sms/verify', { body: { phone, code } });
      const token = v.json && v.json.session && v.json.session.sessionToken;
      if (!token) {
        // ★ 诊断增强：把 HTTP 状态码与原始响应体也打出来，下次一眼看出是 502/403/还是正常 JSON 但缺 session
        const raw = (v.json && typeof v.json === 'object')
          ? JSON.stringify(v.json).slice(0, 240)
          : (typeof v.text === 'string' ? v.text.slice(0, 240) : '(无响应体)');
        throw new Error('登录失败（拿不到 sessionToken）: HTTP ' + v.status + ' | ' + raw);
      }
      CFG.bearer = token;
      const uid = (v.json.session.user || {}).id;
      console.log('  ✅ 登录成功 | uid=', uid);
      const rn = await httpsReq('POST', '/auth/realname/faceid/attempts', {
        body: { name: acc.name, idCard: acc.idCard, consent: true },
      });
      if (rn.json && rn.json.state === 'succeeded') {
        console.log('  ✅ 实名成功 | attemptId=', rn.json.attemptId);
        return { token, uid, phone, realname: { name: acc.name, idCard: acc.idCard } };
      }
      // ★ 实名没过：区分「身份不匹配」和「其他错误」
      if (rn.json && rn.json.code === 'realname_mismatch') {
        // 原身份 姓名/身份证 不匹配（已接码登录成功，仅实名信息错）→ 从号码库取排队身份补救
        console.log('  ⚠️ 原身份实名不匹配（', (rn.json.message || ''), '），进入补救流程…');
        const recovered = await recoverRealname(idx);   // 内部无可用身份会抛错终止本次注册
        return { token, uid, phone, realname: recovered };
      }
      // 其他实名错误（网络/风控/未知）→ 维持原行为抛出
      throw new Error('实名失败: ' + JSON.stringify(rn.json).slice(0, 240));
    } catch (e) {
      lastErr = e;
      // ★ 可重试的「号源类」失败（不归实名/验码/网络错误）：
      //   ① 取到号但超时收不到验证码 → 拉黑该号，换号重试
      //   ② 取号本身失败（豪猪「没有取到号码」= 项目临时无号源/限流，纯瞬时）→ 退避后重试
      const isCodeTimeout = /取码超时|无验证码/.test(e.message || '');
      const isRentFail    = /豪猪取号失败|没有取到号码/.test(e.message || '');
      if (isCodeTimeout && phone) {
        // 取到号但没收到验证码 → 拉黑这个号（避免下次再分到它），然后换号重试
        try { await SMS.blacklist(phone); console.log('  ⛔ 已拉黑号码（超时未收到验证码）:', phone); } catch (_) {}
      }
      if (!isCodeTimeout && !isRentFail) {
        // 验码/实名/网络等非号源问题，换号没用，直接抛出
        throw e;
      }
      if (attempt < MAX_RENT) {
        // 取号失败（无号源）走退避重试，让平台库存恢复；收码超时则立即换号
        const backoff = isRentFail ? Number(process.env.LIGHTVELA_SMS_RENT_BACKOFF_MS || 8000) : 0;
        const why = isRentFail
          ? '取号失败（项目临时无号源/限流）'
          : `取号#${attempt} 等满 ${CODE_TIMEOUT_MS / 1000}s 仍无验证码`;
        if (backoff) { console.log(`  ⚠️ ${why}，退避 ${backoff / 1000}s 后重试…`); await sleep(backoff); }
        else { console.log(`  ⚠️ ${why}，重新取号重试…`); }
        continue;
      }
    }
  }
  throw new Error('登录失败（已换 ' + MAX_RENT + ' 个号仍收不到验证码/取不到号）: ' + (lastErr && lastErr.message));
}

// ===================== REST 引导 =====================
function httpsReq(method, path, { bearer = CFG.bearer, cookie = CFG.cookie, body = null, headers = {}, timeoutMs = 20000, retries = 2, retryBaseMs = 800 } = {}) {
  // ★ 2026-10-23 修复：req.setTimeout 是【socket 空闲超时】，对"挂起但 socket 仍有零星活动"
  //   （代理 keepalive / 对端 dribble）的请求会被无限重置 → 永远不触发 → 进程无限卡死
  //   （实测：出口代理抽风时 /bots 挂起 6 分钟无任何超时日志）。
  //   改成【绝对超时】：到点无条件 req.destroy()，与 socket 有没有活动无关。
  const attempt = () => new Promise((resolve, reject) => {
    const u = new URL(CFG.apiBase + path);
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({
      'User-Agent': (CFG.fp && CFG.fp['User-Agent']) || 'Mozilla/5.0 LightVelaPureCode',
      'Accept': 'application/json',
    }, (CFG.fp || {}), headers);   // ★ 指纹优先，调用方显式 headers 最高优先
    if (bearer) h['Authorization'] = 'Bearer ' + bearer;
    if (cookie) h['Cookie'] = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, agent: pickEgressAgent() }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; try { fn(arg); } catch (e) {} };
    req.on('error', (err) => done(reject, err));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('REST 空闲超时(' + Math.round(timeoutMs / 1000) + 's): ' + method + ' ' + path)); });
    const hardTimer = setTimeout(() => {
      req.destroy(new Error('REST 绝对超时(' + Math.round(timeoutMs / 1000) + 's): ' + method + ' ' + path));
      done(reject, new Error('REST 绝对超时(' + Math.round(timeoutMs / 1000) + 's): ' + method + ' ' + path));
    }, timeoutMs + 2000);
    req.on('close', () => clearTimeout(hardTimer));
    if (data) req.write(data);
    req.end();
  });
  // 仅在“尚未拿到任何 HTTP 响应”的网络层错误（超时/连接重置/代理抖动/域名解析失败）才重试；
  // 一旦收到响应（哪怕 4xx/5xx）就不再重发，避免对下单等写操作造成重复副作用。
  return (async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await attempt();
      } catch (e) {
        lastErr = e;
        const net = /REST 超时|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|getaddrinfo|ENOTFOUND|EHOSTUNREACH|网络|代理|proxy/i.test(e.message || '');
        if (i < retries && net) {
          const wait = retryBaseMs * Math.pow(2, i);
          console.log('[REST] 网络层瞬时失败，' + (wait / 1000) + 's 后重试 (' + (i + 1) + '/' + retries + '): ' + method + ' ' + path + ' | ' + e.message);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  })();
}

// 校验 bearer 是否仍有效：仅当明确鉴权失败(401/403)才判失效；
// 网络层瞬时错误一律保守视为“仍有效”，避免一次探针抖动就把好 token 清掉导致后续全 401。
async function probeBearerValid(token) {
  try {
    const r = await httpsReq('GET', '/auth/session', { bearer: token, retries: 1 });
    if (r.status === 401 || r.status === 403) return false;
    return true;
  } catch (e) {
    return true; // 探针本身网络出错 → 保守认为仍有效
  }
}

// 确保拿到 Bearer（治本：先校验现有 token 是否还有效，失效才刷新/重登；
// 避免“拿到旧 token 直接返回却已失效”导致后续订阅/建Bot 全 401）
async function ensureBearer() {
  if (CFG.bearer) {
    const ok = await probeBearerValid(CFG.bearer);
    if (ok) return CFG.bearer;
    console.log('[REST] 现有 Bearer 已失效，尝试用 Cookie 换发…');
    CFG.bearer = '';
  }
  if (CFG.cookie) {
    const r = await httpsReq('GET', '/auth/session');
    if (r.json && r.json.token) CFG.bearer = r.json.token;
    else if (r.json && r.json.data && r.json.data.token) CFG.bearer = r.json.data.token;
    else if (r.headers['authorization']) CFG.bearer = r.headers['authorization'].replace(/^Bearer /, '');
  }
  if (!CFG.bearer) throw new Error('拿不到 Bearer token，请手动设置 LIGHTVELA_BEARER 或 LIGHTVELA_COOKIE');
  console.log('[REST] 已获取/刷新 Bearer');
  return CFG.bearer;
}

// ===================== 纯代码：订阅 / 创建机器人 =====================
/**
 * 纯代码订阅 1 个月免费套餐（等价浏览器里"点 Free Trial → Confirm activation"）。
 *
 * ★ 套餐随官方频繁变动，且「0 元订阅」的 API 表达法会变：
 *   - 早期：bundle 直接 real_total_cost=0（如 bundle_free_trial_01，现已 OFFLINE）；
 *   - 现在：real_total_cost=标价 + discount=100（百分百折扣=0元），4 个包目前全是 0 元。
 *   故不再硬编码套餐 ID，改为实时拉取 /v1/bundles，并用【折后价=real_total_cost*(100-discount)/100】判定 0 元包；
 *   无 0 元包时【不自动订阅付费包】，需订阅付费包请显式设 LIGHTVELA_BUNDLE_ID=<包ID>。
 *   下单端点（浏览器真实在用的那条）：POST /v1/passes/dianshi/order-and-pay，
 *   body {bundle_id, period:1, time_unit:"m"}；异步开通后 GET /v1/passes 轮询等到 pass 即成功。
 * 成功判据：开通后 GET /v1/passes 能查到"未过期且未删除"的 pass（轮询等待生效）。
 * 失败一律返回 SUBSCRIBE=RETRY，由外层编排重订。
 * 输出：SUBSCRIBE=OK|already|<bundle>  /  SUBSCRIBE=OK|activated|<bundle>  /  SUBSCRIBE=RETRY|<原因>
 */
async function restSubscribe() {
  await ensureBearer();

  const fetchLivePasses = async () => {
    const rp = await httpsReq('GET', '/v1/passes');
    const list = pickArray(unwrapData(rp.json), ['passes', 'items']) || [];
    return list.filter(passAlive);
  };
  const brief = (r) => {
    const code = String((r.json && (r.json.code || r.json.error_code || r.json.error)) || '');
    const msg = String((r.json && (r.json.message || r.json.msg)) || r.text || '').replace(/\s+/g, ' ').slice(0, 160);
    return { code, msg };
  };
  // 放宽成功判据：接受 '' / 'OK' / '0' / 'success'（不同接口返回格式不一），明确错误码才判失败
  const isOk = (r, code) => r.status >= 200 && r.status < 300 && (code === '' || code === 'OK' || code === '0' || /success/i.test(code));

  // 0) 已有有效订阅 → 直接成功（幂等）
  try {
    const live = await fetchLivePasses();
    if (live.length) {
      const b = live[0].bundle_id || '';
      console.log('[订阅] 已有有效订阅:', live.map((p) => p.bundle_id || '?').join(','), '（无需重复激活）');
      console.log('SUBSCRIBE=OK|already|' + b + '|' + (live[0].pass_id || ''));
      return true;
    }
  } catch (e) { console.log('[订阅] 查询现有订阅失败(忽略，继续尝试激活):', e.message); }

  // 1) 组装候选套餐（★ 套餐 ID/价格随官方随时调整，必须实时拉取，绝不能写死）
  //    优先级：显式覆盖(LIGHTVELA_BUNDLE_ID) → 在线 0 元包(首单免费活动在时)
  //    无 0 元包时【不自动订阅付费包】，避免误扣费；需订阅付费包请显式设 LIGHTVELA_BUNDLE_ID
  const candidates = [];
  const push = (id) => { if (id && candidates.indexOf(id) < 0) candidates.push(id); };
  push(process.env.LIGHTVELA_BUNDLE_ID);
  try {
    const rb = await httpsReq('GET', '/v1/bundles');
    const bs = pickArray(unwrapData(rb.json), ['bundles', 'items']) || [];
    const online = bs.filter((b) => !b.bundle_state || b.bundle_state === 'ONLINE');
    // ★ 「0 元订阅」必须用【折后价】判定：real_total_cost * (100 - discount) / 100
    //   官方表达法会变：早期直接 real_total_cost=0；现在改成 real_total_cost=标价 + discount=100（百分百折扣=0元）。
    //   两种写法折后都是 0 才算免费包，避免漏掉 discount=100 的 0 元包（曾因此误判"免费包已下线"→ 抢套餐失败）。
    const effCost = (b) => {
      const p = b.price || {};
      const rtc = Number(p.real_total_cost);
      if (isNaN(rtc)) return NaN;
      const disc = Number(p.discount) || 0;
      return rtc * (100 - disc) / 100;
    };
    const zero = online.filter((b) => { const e = effCost(b); return !isNaN(e) && Math.abs(e) < 0.01; });
    zero.sort((a, b) => (b.bundle_type === 'ai' ? 1 : 0) - (a.bundle_type === 'ai' ? 1 : 0));
    for (const b of zero) push(b.bundle_id);
    if (!zero.length) {
      console.log('[订阅] ⚠️ 当前无 0 元免费套餐（所有在线包折后均 >0，免费活动疑似已结束），在线包：' +
        online.map((b) => b.bundle_id + '(折后￥' + (effCost(b) / 100).toFixed(2) + ')').join(', ') +
        '；为避免过度扣费未自动订阅付费包，如需订阅请设 LIGHTVELA_BUNDLE_ID=<包ID>');
    }
  } catch (e) { console.log('[订阅] 拉取套餐列表失败:', e.message); }
  console.log('[订阅] 候选套餐:', candidates.join(', ') || '(空·需设 LIGHTVELA_BUNDLE_ID)');

  // 开通后轮询等 pass 生效（放宽到 ~25s，覆盖异步开通延迟，避免“刚下单就误判失败”）
  const waitPass = async (bundleId, tries) => {
    for (let i = 0; i < tries; i++) {
      await sleep(i === 0 ? 1500 : 2000);
      try {
        const live = await fetchLivePasses();
        if (live.length) {
          console.log('[订阅] ✅ 复核通过，有效订阅:', live[0].bundle_id || bundleId);
          console.log('SUBSCRIBE=OK|activated|' + (live[0].bundle_id || bundleId) + '|' + (live[0].pass_id || ''));
          return true;
        }
      } catch (e) { console.log('[订阅] 复核查询失败:', e.message); }
    }
    return false;
  };

  // 2) 外层重试（治本：瞬时网络抖动/代理断连不再直接判“抢套餐失败”；token 中途失效也会重验）
  const OUTER = Number(process.env.LIGHTVELA_SUB_RETRY || 3);
  let lastErr = '';
  for (let outer = 0; outer < OUTER; outer++) {
    if (outer > 0) {
      console.log('[订阅] 第 ' + (outer + 1) + '/' + OUTER + ' 次重试（间隔 5s，重验 Bearer）…');
      await sleep(5000);
      try { await ensureBearer(); } catch (e) { console.log('[订阅] 重验 Bearer 失败:', e.message); }
    }
    let orderedOk = false;
    for (const bundleId of candidates) {
      // 2a) 新版（网站真实在用的那条）
      try {
        const r = await httpsReq('POST', '/v1/passes/dianshi/order-and-pay', { body: { bundle_id: bundleId, period: 1, time_unit: 'm' } });
        const { code, msg } = brief(r);
        console.log('[订阅] dianshi/order-and-pay', bundleId, '→', r.status, 'code=' + (code || '-'), 'msg=' + msg);
        if (isOk(r, code)) {
          if (await waitPass(bundleId, 12)) return true;
          // 订单已建但 pass 仍未生效：多为异步开通延迟，记软成功并跳出内层，外层重试前再复核
          lastErr = '订单已建但 pass 未生效(' + bundleId + ')';
          orderedOk = true;
          try { const lv = await fetchLivePasses(); if (lv.length) { console.log('SUBSCRIBE=OK|activated|' + (lv[0].bundle_id || bundleId) + '|' + (lv[0].pass_id || '')); return true; } } catch (_) {}
        } else { lastErr = msg || ('HTTP ' + r.status); }
      } catch (e) { console.log('[订阅] dianshi 请求异常:', e.message); lastErr = e.message; }
      if (orderedOk) break;

      // 2b) 老接口（对遗留免费包仍可能有效）
      try {
        const r2 = await httpsReq('POST', '/v1/passes', { body: { bundle_id: bundleId } });
        const { code, msg } = brief(r2);
        console.log('[订阅] POST /v1/passes', bundleId, '→', r2.status, 'code=' + (code || '-'), 'msg=' + msg);
        if (isOk(r2, code)) {
          if (await waitPass(bundleId, 12)) return true;
        }
        if (/conflict|already|exist|duplicate|已订阅|已存在|重复/i.test(code + ' ' + msg)) {
          console.log('SUBSCRIBE=OK|already|' + bundleId + '|');
          return true;
        }
        lastErr = msg || ('HTTP ' + r2.status);
      } catch (e) { console.log('[订阅] 老接口请求异常:', e.message); lastErr = e.message; }
    }
    // 外层重试前，再查一次现有订阅（覆盖异步开通）
    try { const lv = await fetchLivePasses(); if (lv.length) { console.log('SUBSCRIBE=OK|activated|' + (lv[0].bundle_id || '') + '|' + (lv[0].pass_id || '')); return true; } } catch (_) {}
  }

  console.log('SUBSCRIBE=RETRY|' + (lastErr || '所有候选套餐均未开通'));
  return false;
}

/**
 * 纯代码创建机器人（等价浏览器里"填/不填表单 → 点 Create"）。
 * 有现成实例就直接复用；没有就 POST /v1/instances，再轮询到 active。
 * 输出：BOT=<instance_id>|status=<status>[|reused=1]  /  BOT=FAIL|<原因>
 */
async function restCreateBot(name) {
  await ensureBearer();

  // 0) 已有可用实例 → 复用（★ 2026-10-23 修复：复用前必须看剩余寿命）
  //    根因：实例只有 1 小时寿命（timeout_at）。曾复用一个只剩 ~10 分钟就到期的实例发部署命令，
  //    后端一条回复不吐（后端随实例半死不活），干等 10 分钟被父进程看门狗杀掉 → 面板一直「等待中」。
  //    规则：挑剩余时间最长的 Running 实例；剩余 < LIGHTVELA_REUSE_MIN_LEFT_SEC（默认 1200s=20 分钟）
  //    就不复用、新建实例（新建失败才兜底复用旧实例，好歹比没有强）。
  const reuseMinLeftMs = parseInt(process.env.LIGHTVELA_REUSE_MIN_LEFT_SEC || '1200', 10) * 1000;
  const _isoZ = (t) => (!t ? '' : (/Z$|[+-]\d\d:?\d\d$/.test(String(t)) ? String(t) : String(t) + 'Z'));
  const instLeftMs = (x) => {
    try {
      const t = _isoZ(x.timeout_at || x.expires_at);
      if (t) { const ms = Date.parse(t); if (!isNaN(ms)) return ms - Date.now(); }
      const c = _isoZ(x.created_at);
      if (c) { const ms = Date.parse(c); if (!isNaN(ms)) return ms + 3600 * 1000 - Date.now(); } // 创建时 timeout:3600s
    } catch (e) {}
    return null;   // 拿不到寿命信息 → 未知，按旧行为直接复用
  };
  let oldInst = null, oldLeft = null;
  try {
    const ri = await httpsReq('GET', '/v1/instances');
    const items = pickArray(unwrapData(ri.json), ['items', 'instances']) || [];
    for (const x of items) {
      if (!/active|running/i.test(String(x.status || ''))) continue;
      const left = instLeftMs(x);
      const score = (left === null) ? Infinity : left;
      const bestScore = (oldLeft === null) ? Infinity : oldLeft;
      if (!oldInst || score > bestScore) { oldInst = x; oldLeft = left; }
    }
  } catch (e) { console.log('[建Bot] 查询现有实例失败(忽略):', e.message); }
  // 新建失败时的兜底：拿寿命不足的旧实例顶上
  const fallbackReuse = () => {
    if (!oldInst) return false;
    const iid = oldInst.instance_id || oldInst.id;
    CFG.instanceId = iid;
    console.log('[建Bot] 新建失败，兜底复用旧实例:', iid, '状态=' + (oldInst.status || ''));
    console.log('BOT=' + iid + '|status=' + (oldInst.status || 'active') + '|reused=1');
    return true;
  };
  if (oldInst) {
    const leftTxt = (oldLeft === null) ? '寿命未知' : ('剩余约 ' + Math.max(0, Math.round(oldLeft / 60000)) + ' 分钟');
    if (oldLeft !== null && oldLeft < reuseMinLeftMs) {
      console.log('[建Bot] 现有实例 ' + (oldInst.instance_id || oldInst.id) + ' ' + leftTxt + '（< ' + Math.round(reuseMinLeftMs / 60000) + ' 分钟），不复用、新建实例');
    } else {
      const iid = oldInst.instance_id || oldInst.id;
      CFG.instanceId = iid;
      console.log('[建Bot] 复用已有实例:', iid, '状态=' + (oldInst.status || '') + '（' + leftTxt + '）');
      console.log('BOT=' + iid + '|status=' + (oldInst.status || 'active') + '|reused=1');
      return true;
    }
  }

  // 1) 直接创建实例（注：后端【没有】 /v1/instances/create-prerequisites 这个接口，
  //    实测返回 NOT_FOUND，纯属多打一次请求 + 日志噪音，已于 2026-10-10 去掉）

  // 2) 创建实例
  const nm = String(name || '').trim() || ('agent-' + crypto.randomBytes(3).toString('hex'));
  let rc;
  try { rc = await httpsReq('POST', '/v1/instances', { body: { timeout: 3600, name: nm } }); }
  catch (e) {
    console.log('BOT=FAIL|请求异常:' + String(e.message).slice(0, 100));
    if (fallbackReuse()) return true;
    return false;
  }
  const d = unwrapData(rc.json) || {};
  console.log('[建Bot] POST /v1/instances →', rc.status, JSON.stringify(rc.json || {}).slice(0, 240));
  let iid = d.instance_id || d.id || '';
  let status = String(d.status || '');
  if (!iid) {
    const msg = String((rc.json && (rc.json.message || rc.json.msg || rc.json.code)) || rc.text || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log('BOT=FAIL|' + (msg || ('HTTP ' + rc.status)));
    if (fallbackReuse()) return true;
    return false;
  }

  // 3) 轮询等它变成 active/running（最多 ~60s）
  for (let i = 0; i < 20 && !/active|running/i.test(status); i++) {
    await sleep(3000);
    try {
      const r2 = await httpsReq('GET', '/v1/instances');
      const its = pickArray(unwrapData(r2.json), ['items', 'instances']) || [];
      const hit = its.find((x) => (x.instance_id || x.id) === iid);
      if (hit && hit.status) status = String(hit.status);
    } catch (e) { /* 忽略单次查询失败 */ }
  }
  CFG.instanceId = iid;   // 记下来：后面设主模型 / 发消息都用它
  console.log('[建Bot] 实例=' + iid + ' 最终状态=' + status + ' 名称=' + nm);
  console.log('BOT=' + iid + '|status=' + (status || 'unknown') + '|name=' + nm);
  return /active|running|creating|pending/i.test(status) || !!iid;
}

// ===================== 设主模型（纯代码复刻前端【Set as primary model】）=====================
// 失败即抛错（方案甲）：不设主模型机器人不会回话，部署无意义，按方案C保留环境等排查。
async function restSetPrimaryModel(instanceId) {
  if (process.env.LIGHTVELA_NO_SET_MODEL) {
    console.log('[模型] 跳过设主模型 (LIGHTVELA_NO_SET_MODEL=1)');
    return;
  }
  // payload：前端点【Set as primary model】时实际下发的动作（Auto 行）
  const payload = Buffer.from(JSON.stringify({
    type: 'assign',
    providerKey: 'custom',
    modelId: 'auto',
    baseUrl: CFG.modelBaseUrl,
    purpose: 'primary',
  })).toString('base64');

  // 引导 python：解压并执行 HERMES_MODEL_CFG_SCRIPT_B64，把 sys.argv[1] 设为 payload（与前端一致）
  const bootstrap = 'import base64,gzip,linecache,sys;path="<stdin>";source=gzip.decompress(base64.b64decode(sys.argv[2])).decode("utf-8");linecache.cache[path]=(len(source),None,source.splitlines(True),path);sys.argv=[sys.argv[0],sys.argv[1]];exec(compile(source,path,"exec"),{"__name__":"__main__"})';

  // 前端下发的 shell 命令外壳（设 HERMES_ROOT / HERMES_PYTHON，失败兜底 python3）
  const command =
    'set -e\n' +
    'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"\n' +
    'export HERMES_ROOT\n' +
    'HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}"\n' +
    'export HERMES_HOME="$HERMES_PROFILE_ROOT"\n' +
    'HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"\n' +
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi\n' +
    'printf \'%s\n\' \'' + bootstrap + "' | \"$HERMES_PYTHON\" - \"" + payload + "\" \"" + HERMES_MODEL_CFG_SCRIPT_B64 + "\"";

  // debug/exec 是「腾讯云 TAT 中继进实例里跑脚本」，链路比普通 REST 慢得多：
  // 实测 20s 会直接被打断，脚本其实还在实例里跑。所以放宽到 60s（可用 LIGHTVELA_EXEC_TIMEOUT_MS 调），
  // 并且把「超时/网络异常」也当成可重试（设主模型是写配置，重复执行不会写坏）。
  const execTimeoutMs = Number(process.env.LIGHTVELA_EXEC_TIMEOUT_MS || 60000);
  console.log('[模型] debug/exec 超时阈值: ' + Math.round(execTimeoutMs / 1000) + 's');

  let r = null;
  let lastCode = '';
  let lastErr = null;
  for (let i = 1; i <= 5; i++) {
    console.log('[模型] 设主模型: custom/auto (POST /v1/instances/' + instanceId + '/debug/exec) 第 ' + i + ' 次');
    try {
      r = await httpsReq('POST', '/v1/instances/' + instanceId + '/debug/exec', {
        body: { command: command, run_as_user: 'agentuser', execution_backend: 'tat' },
        timeoutMs: execTimeoutMs,
      });
    } catch (e) {
      // 超时/连接类异常会以 reject 抛出（不进上面的 r 判断），这里收住并退避重打
      lastErr = e;
      r = null;
      lastCode = String((e && e.message) || e || '');
      console.log('[模型] debug/exec 请求异常(' + lastCode + ')，5s 后重试');
      await sleep(5000);
      continue;
    }
    if (r.json && r.json.code === 'OK') break;
    lastCode = String((r.json && (r.json.code || r.json.message)) || '');
    // 实例尚未就绪(409) 才值得重试；其它错误照原样抛出（方案甲：不设主模型部署无意义）
    if (!/DEBUG_NOT_SUPPORTED|not.*ready|409/i.test(lastCode)) break;
    console.log('[模型] 实例尚未就绪，3s 后重试');
    await sleep(3000);
  }
  if (!r || !r.json || r.json.code !== 'OK') {
    const tail = (r && r.text) ? String(r.text) : (lastCode || '');
    throw new Error('debug/exec 失败(已重试5次' + (lastErr ? '，最后一次:' + String(lastErr.message || lastErr) : '') + '): ' + tail.slice(0, 240));
  }
  const data = r.json.data || {};
  const output = typeof data.output === 'string' ? data.output : '';
  const m = output.match(/__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_START__([\s\S]*?)__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_END__/);
  if (!m) {
    throw new Error('debug/exec 未返回模型配置结果(实例内脚本可能报错): ' + output.slice(0, 300));
  }
  let res;
  try { res = JSON.parse(m[1].trim()); } catch (e) { throw new Error('模型配置结果非 JSON: ' + m[1].slice(0, 200)); }
  if (!res.ok) {
    throw new Error('设主模型被实例拒绝: ' + JSON.stringify(res).slice(0, 240));
  }
  const snap = res.snapshot || {};
  const p = snap.primary || {};
  console.log('[模型] 主模型已设为: ' + (p.id || '?') + '@' + (p.providerKey || '?') + ' (' + (p.apiMode || '') + ')');
}

async function restTatSession() {
  const r = await httpsReq('POST', `/v1/instances/${CFG.instanceId}/tat/session`, { body: {} });
  if (!r.json) throw new Error('tat/session 响应非 JSON: ' + r.text.slice(0, 200));
  const t = r.json.data || r.json;
  const s = {
    appId:      t.appId,
    uin:        t.uin || t.ownerUin || t.loginUin,
    instanceId: t.instanceId || CFG.instanceId,
    sessionId:  t.sessionId || CFG.sessionId,
    wsUrl:      t.wsUrl || `wss://${CFG.region}.forward.tat-tc.tencent.cn/ws`,
    poolId:     t.poolId,
    username:   t.username,
    region:     t.region,
  };
  console.log('[TAT] 已领取会话门票 region=' + (s.region || '?') + ' sessionId=' + String(s.sessionId || '').slice(0, 8) + '…');
  return s;
}

async function restBootstrap() {
  // 1) 拿 Bearer
  await ensureBearer();
  // 2) 实例（真实响应：{"code":"OK","data":{"items":[{instance_id,...}]}} —— 取 data.items）
  if (!CFG.instanceId) {
    const r = await httpsReq('GET', '/v1/instances');
    const dj = (r.json || {}).data;
    const list = (dj && dj.items) || (Array.isArray(dj) ? dj : null) || (r.json || {}).instances || [];
    if (!list.length) throw new Error('实例列表为空: ' + (r.text || '').slice(0, 200));
    CFG.instanceId = list[0].instance_id || list[0].id || list[0];
    console.log('[REST] 实例:', CFG.instanceId);
  }
  // 3) bot（真实响应：{"code":"OK","data":{"items":[{bot_id,...}]}}）
  //    ⚠️ 2026-10-10 实测：/v1/instances/{id}/bots 从外部请求会挂起(无响应)，故加 try 兜底；
  //    拿不到时直接用 instanceId 当 botId（实测两者同值，且 Hermes 只认 instance）。
  if (!CFG.botId) {
    try {
      const r = await httpsReq('GET', `/v1/instances/${CFG.instanceId}/bots`);
      const dj = (r.json || {}).data;
      const list = (dj && dj.items) || (Array.isArray(dj) ? dj : null) || (r.json || {}).bots || [];
      if (list.length) { CFG.botId = list[0].bot_id || list[0].id || list[0]; console.log('[REST] bot:', CFG.botId); }
    } catch (e) {
      console.log('[REST] /bots 不可用(' + String(e.message).slice(0, 70) + ')，兜底用 instanceId 作 botId');
    }
    if (!CFG.botId) { CFG.botId = CFG.instanceId; console.log('[REST] bot(兜底=instance):', CFG.botId); }
  }
  // 4) tat/session —— 拿 TAT 中继连接参数
  const r = await httpsReq('POST', `/v1/instances/${CFG.instanceId}/tat/session`, { body: {} });
  if (!r.json) throw new Error('tat/session 响应非 JSON: ' + r.text.slice(0, 200));
  const t = r.json.data || r.json;
  return {
    appId:     t.appId,
    uin:       t.uin || t.ownerUin || t.loginUin,
    instanceId: t.instanceId || CFG.instanceId,
    sessionId: t.sessionId || CFG.sessionId,
    wsUrl:     t.wsUrl || `wss://${CFG.region}.forward.tat-tc.tencent.cn/ws`,
    poolId:    t.poolId,
    username:  t.username,
    region:    t.region,
  };
}

// ===================== 隧道 + Hermes 会话管理 =====================
let rpcId = 1;
const pending = new Map();          // id -> {resolve, reject}
const eventHandlers = [];           // 全局事件回调
function onEvent(cb) { eventHandlers.push(cb); return () => { const i = eventHandlers.indexOf(cb); if (i >= 0) eventHandlers.splice(i, 1); }; }

async function runChat(message) {
  // 整个聊天是回调驱动（WS 事件），函数体会立刻执行完 —— 用 Promise 把结果交回 main
  let finishResolve = () => {};
  const finished = new Promise((r) => { finishResolve = r; });
  // ★ 防"挂死当成功"（2026-10-17 批量实测踩坑：TAT 隧道断后通道没建起来，
  //   进程里没有任何活跃句柄 → Node 事件循环一空就自然退出、退出码 0 → 调度器误记"成功"，
  //   实际部署根本没跑）。两道保险：
  //   ① 整体硬超时定时器（默认 37 分钟 < 批量 40 分钟强杀）：到点强制判失败；
  //      且定时器本身让事件循环保持存活，杜绝"自然退出码 0"冒充成功；
  //   ② TAT onClose 且 Hermes 通道未建立 → 立即判失败（无重连逻辑，等下去没意义）。
  const HARD_MS = parseInt(process.env.LIGHTVELA_HARD_MS || String(37 * 60 * 1000), 10);
  let settled = false;                  // 结果是否已交付（成功/失败都算，防重复改判）
  let outer = null;                     // 外层 TAT WS 连接（声明提前，供定时器/关闭回调引用）
  let hardTimer = setTimeout(() => {
    console.error('[HARDTIMEOUT] 已运行 ' + (HARD_MS / 60000) + ' 分钟仍未出结果，强制判失败');
    forceFailRun('整体硬超时（' + (HARD_MS / 60000) + ' 分钟）');
  }, HARD_MS);
  const settle = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    finishResolve(result);
  };
  const forceFailRun = (why) => {
    if (settled) return;                // 已交付结果（哪怕是成功），不再改判
    console.error('[RUNFAIL] ' + why);
    try { if (outer) outer.close(); } catch (e) {}
    settle({ ok: false, replyText: '', replyLen: 0, error: why });
  };
  const tat = await restBootstrap();
  if (!CFG.sessionId && tat.sessionId) CFG.sessionId = tat.sessionId;

  // 建 Bot 后进聊天界面需手动做的【模型设置】，改为纯代码自动设主模型（--shell 验证模式跳过）
  if (!CFG.shellCmd && process.env.LIGHTVELA_SKIP_PRIMARY_MODEL !== '1') {
    try {
      // ★ 2026-10-12 修正：必须用 LightVela 的实例号(CFG.instanceId)，不能用 tat.instanceId！
      //   tat/session 返回的 instanceId 是【腾讯云 TAT 中继侧】的短号(如 ins-r7y4y9dh)，
      //   只用于 TAT WS 的 SessionAuth；拿它去打 /v1/instances/<id>/debug/exec 会 404 resource not found。
      await restSetPrimaryModel(CFG.instanceId || tat.instanceId);
    } catch (e) {
      throw new Error('设主模型失败（机器人将无回应，部署无意义）：' + e.message);
    }
  }

  // ★ 刷新 TAT 门票：上面设主模型走了 debug/exec（TAT 中继，慢机器上实测很慢），
  //   等它跑完，bootstrap 阶段领的那张票大概率已过期 → 连上中继会被回 "session not valid" 并掐断。
  //   所以正式连中继前重新领一张（与国际版 34.80 修复一致，根治 session not valid）。
  try {
    const fresh = await restTatSession();
    Object.assign(tat, fresh);
    if (fresh.sessionId) CFG.sessionId = fresh.sessionId;
    console.log('[TAT] 连中继前已刷新门票');
  } catch (e) {
    console.log('[TAT] 刷新门票失败，沿用旧票: ' + e.message);
  }

  // 解析 TAT wsUrl
  const u = new URL(tat.wsUrl);
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'wss:' ? 443 : 80);

  // ★ 门票失效重连相关（根治 session not valid，与国际版 34.80 一致）
  let reconnectTries = 0;           // 门票失效后的重连次数
  const MAX_RECONNECT = 3;
  let deadline = Date.now() + 90000; // 看门狗期限（每次重连会续命）
  let ptyStartTimer = null;          // PtyStart 延迟发送定时器
  let readyFallbackTimer = null;     // 12s 未见 ready 的兜底定时器
  let tunnelBuf = Buffer.alloc(0);  // 隧道收包缓冲（内层 Hermes TCP 流）
  let hermesOpen = false;
  let ptyReadySeen = false;
  let proxySent = false;            // PtyProxyNew 是否已发出（避免重复开通道）
  let ptyOutBuf = '';               // PTY 输出累积（找 __LV_DASHBOARD_READY__:<token>）
  let hermesToken = CFG.hermesToken;
  let shellActive = false;          // --shell 模式：是否已切到"原始命令行"
  let shellOut = '';                // --shell 模式：原始输出累积

  // 把一段 TCP 字节经 PtyProxyData 发到隧道（BSON 二进制帧）
  function sendTunnel(tcpBytes) {
    const frame = bsonDoc([
      bsonStr('Type', 'PtyProxyData'),
      bsonDocEl('Data', bsonDoc([
        bsonStr('SessionId', CFG.sessionId),
        bsonStr('ChannelId', CFG.proxyChannel),
        bsonStr('CustomData', ''),
        bsonDocEl('Data', bsonDoc([
          bsonStr('ProxyId', CFG.proxyChannel),
          bsonBin('Data', tcpBytes),
        ])),
      ])),
    ]);
    outer.send(frame);
  }
  // 对内层 Hermes 发一条 JSON-RPC（经隧道）
  function hermesSend(method, params) {
    const rpc = { jsonrpc: '2.0', id: rpcId++, method, params: params || {} };
    const p = new Promise((resolve, reject) => { pending.set(rpc.id, { resolve, reject }); setTimeout(() => { if (pending.has(rpc.id)) { pending.delete(rpc.id); reject(new Error('RPC 超时: ' + method)); } }, 20000); });
    sendTunnel(wsEncodeClientFrame(JSON.stringify(rpc)));
    return p;
  }

  // 处理内层 Hermes WS 收到的文本（JSON-RPC 事件/响应）
  let replyText = '';
  let curMsg = '';        // 当前这条消息已累计的增量（用于与 message.complete 的全文去重）
  let gotMessageStart = false;
  function handleHermesText(text) {
    let msg; try { msg = JSON.parse(text); } catch (e) { console.log('[Hermes] 非 JSON:', text.slice(0, 120)); return; }
    if (process.env.LIGHTVELA_DEBUG) console.log('[Hermes][帧]', JSON.stringify(msg).slice(0, 260));
    // —— JSON-RPC 响应（有 id + result/error）——
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
      return;
    }
    // —— 事件帧：{ method:'event', params:{ type, session_id, payload, seq } }（实抓确认）——
    //   文本字段对齐前端 Ft()：payload.text ?? reasoning ?? content ?? message
    const evType = (msg.params && msg.params.type) || msg.method || '';
    const pl = (msg.params && msg.params.payload) || {};
    const txt = (typeof pl.text === 'string' && pl.text) || (typeof pl.reasoning === 'string' && pl.reasoning)
              || (typeof pl.content === 'string' && pl.content) || (typeof pl.message === 'string' && pl.message) || '';
    if (evType === 'message.start') { gotMessageStart = true; curMsg = ''; }
    else if (evType === 'message.delta') { if (txt) { curMsg += txt; replyText += txt; process.stdout.write(txt); } }
    else if (evType === 'message.complete') {
      // complete 里的 text 是整条消息全文；补上增量没覆盖到的尾部（避免重复，也不丢字）
      if (txt && txt.length > curMsg.length) {
        const extra = txt.slice(curMsg.length);
        replyText += extra; process.stdout.write(extra);
      }
      curMsg = '';
    }
    eventHandlers.forEach((cb) => cb(msg));
  }

  // 外层 TAT WS —— 抽成 tatHandlers（与国际版 34.80 一致，支持门票失效重连）
  const tatHandlers = {
    onOpen() {
      console.log('[TAT] 中继已连接，发送 SessionAuth(文本 JSON 帧)');
      // ★ 实测抓包（2026-10-10 env A 现场，CDP 重载重连）：SessionAuth 是【文本帧 opcode=1 的 JSON】，
      //   不是二进制 TLV。真实帧：
      //   {"Type":"SessionAuth","Data":{"Uin":"100045199955","AppId":1388575217,
      //    "InstanceId":"ins-kfgu6elv","SessionId":"<uuid>","MaxIdleTime":3600}}
      //   注意：AppId / MaxIdleTime 是【数字】，Uin / InstanceId / SessionId 是【字符串】。
      const authJson = {
        Type: 'SessionAuth',
        Data: {
          Uin: String(tat.uin),
          AppId: Number(tat.appId),
          InstanceId: String(tat.instanceId),
          SessionId: String(CFG.sessionId),
          MaxIdleTime: 3600,
        },
      };
      outer.send(JSON.stringify(authJson), 0x1);   // 0x1 = 文本帧
      // 建代理通道到 Hermes 后端（通道号先定下来）
      CFG.proxyChannel = 'proxy_lvpure_' + crypto.randomBytes(4).toString('hex');
      // ★ 关键时序（对齐前端 a-LNlbm_te.js 的 Hi()）：必须【先 PtyStart 启动 Hermes 后端、拿到 session token】，
      //   再 PtyProxyNew 开隧道。后端启动后会在 PTY 输出里打印 `__LV_DASHBOARD_READY__:<token>`，
      //   该 token 就是 Hermes WS 的 ?token= 凭据。
      //   若不先启动后端：隧道能开(PtyProxyReady)但连 9119 会立刻被关闭(PtyProxyClose)——即上一轮的失败现象。
      ptyStartTimer = setTimeout(() => sendPtyStart(), 400);
    },
    onMessage(data, opcode) {
      // —— 诊断日志（仅 LIGHTVELA_DEBUG=1 时打印，避免刷屏）——
      if (process.env.LIGHTVELA_DEBUG) {
        if (opcode === 0x1) {
          let txt = ''; try { txt = data.toString('utf8'); } catch (e) {}
          console.log('[TAT][RECV text]', txt.slice(0, 240));
        } else {
          const f = bsonDecode(data);
          console.log('[TAT][RECV bin] type=', f.Type || '', 'keys=', Object.keys(f).join(','));
        }
      }
      // —— 正式处理 ——
      if (opcode === 0x1) {
        let j = null; try { j = JSON.parse(data.toString('utf8')); } catch (e) {}
        if (!j || !j.Type) return;
        // ★ 服务端错误帧：最常见就是门票过期 {"Type":"Error","Data":{"Message":"session not valid"}}，
        //   随后连接会被掐断。识别到就重新领门票重连，而不是傻等 60s 超时。
        if (j.Type === 'Error') {
          const msg = (j.Data && (j.Data.Message || j.Data.message)) || j.Message || j.message || '';
          console.log('[TAT] 服务端错误帧: ' + (msg || JSON.stringify(j).slice(0, 160)));
          if (/session not valid|invalid session|session expired|unauthorized|not authorized/i.test(msg)) {
            maybeReconnect('会话失效(' + msg + ')');
            return;
          }
          return;
        }
        if (j.Type === 'PtyReady') { console.log('[TAT] PTY 就绪'); return; }
        if (j.Type === 'PtyOutput') { handlePtyOutput(j); return; }
        if (j.Type === 'PtyError') { console.log('[TAT] PtyError:', JSON.stringify(j).slice(0, 300)); return; }
        if (j.Type === 'PtyProxyReady') {
          ptyReadySeen = true;
          console.log('[TAT] 代理通道就绪(text):', (j.Data && j.Data.ProxyId) || CFG.proxyChannel);
          setTimeout(() => { connectHermes(); }, 500);
          return;
        }
        if (j.Type === 'PtyProxyClose') { console.log('[TAT] 通道关闭(text)'); return; }
        return;
      }
      // 二进制帧 = BSON 文档（PtyProxyReady / PtyProxyData / PtyProxyClose）
      const fields = bsonDecode(data);
      const type = fields.Type || '';
      if (type === 'PtyProxyReady') {
        ptyReadySeen = true;
        console.log('[TAT] 代理通道就绪(bin):', (fields.Data && fields.Data.ProxyId) || CFG.proxyChannel);
        // 等 800ms 让后端先推送 token 横幅（__LV_DASHBOARD_READY__:<token>），再发 WS 握手
        setTimeout(() => { connectHermes(); }, 800);
      } else if (type === 'PtyProxyData') {
        const tcp = extractTunnelBytes(fields);
        if (!tcp) { console.log('[TAT][数据] PtyProxyData 结构:', JSON.stringify(fields, (k, v) => Buffer.isBuffer(v) ? ('<buf ' + v.length + '>') : v).slice(0, 600)); return; }
        if (!hermesOpen) console.log('[TAT][隧道] 收到 ' + tcp.length + ' 字节: ' + JSON.stringify(tcp.slice(0, 200).toString('utf8')));
        // token 可能出现在隧道 TCP 输出里（后端启动打印 __LV_DASHBOARD_READY__ 或 token: xxx）
        if (!hermesToken) {
          const s = tcp.toString('utf8');
          const m = s.match(/__LV_DASHBOARD_READY__[:=]\s*([A-Za-z0-9_\-]+)|token[:=]\s*["']?([A-Za-z0-9_\-]{6,})/i);
          if (m) { hermesToken = m[1] || m[2]; console.log('[Hermes] 从隧道输出解析到 token:', hermesToken); }
        }
        tunnelBuf = Buffer.concat([tunnelBuf, tcp]);
        // 握手未完成时，先尝试解析 HTTP 101
        if (!hermesOpen) {
          const idx = tunnelBuf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const head = tunnelBuf.slice(0, idx).toString();
            if (/101/.test(head)) {
              hermesOpen = true;
              tunnelBuf = tunnelBuf.slice(idx + 4);
              console.log('[Hermes] WS 握手成功(101)');
              afterHermesOpen();
            } else {
              const echo = tunnelBuf.slice(0, Math.min(tunnelBuf.length, 200)).toString('utf8').replace(/\r?\n/g, ' ').slice(0, 200);
              console.log('[Hermes] 隧道首包非 101，预览:', echo);
            }
          }
        }
        if (hermesOpen) {
          const { msgs, rest } = wsParseServerFrames(tunnelBuf);
          tunnelBuf = rest;
          msgs.forEach(handleHermesText);
        }
      } else if (type === 'PtyProxyClose') {
        console.log('[TAT] 通道关闭(bin)', JSON.stringify(fields).slice(0, 400));
      } else if (type === 'PtyReady') {
        console.log('[TAT] PTY 就绪');
      } else if (type === 'PtyOutput') {
        const txt = ptyOutputText(fields);
        if (txt) {
          ptyOutBuf = (ptyOutBuf + txt).slice(-4096);
          const m = ptyOutBuf.match(/__LV_DASHBOARD_READY__:([A-Za-z0-9_\-]+)/);
          if (m && !hermesToken) {
            hermesToken = m[1];
            console.log('[Hermes] 已从 PTY 输出拿到 session token:', hermesToken);
            if (!proxySent) { proxySent = true; sendPtyProxyNew(); }
          }
          const em = ptyOutBuf.match(/__LV_DASHBOARD_ERROR__:([a-z_]+)/);
          if (em) console.log('[TAT] 后端启动报错标记:', em[1]);
        }
      } else if (type === 'PtyError') {
        console.log('[TAT] PtyError:', JSON.stringify(fields).slice(0, 300));
      }
    },
    onClose() { console.log('[TAT] 连接关闭'); maybeReconnect('连接被关闭'); },
    onError(e) { console.error('[TAT] 错误:', e.message); },
  };

  function openTat() {
    const u = new URL(tat.wsUrl);
    const host = u.hostname;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'wss:' ? 443 : 80);
    outer = createWSConn({ host, port, path: u.pathname + u.search || '/ws', useTls: u.protocol === 'wss:', proxy: CFG.egressProxy }, tatHandlers);
  }

  // ★ 门票失效重连：服务端回 "session not valid"、或者通道还没建好就被断开时，
  //   重新领一张门票再连（最多 MAX_RECONNECT 次）。国内版设主模型同样很慢，容易撞上过期。
  async function maybeReconnect(why) {
    if (hermesOpen) return;
    if (CFG.shellCmd) return;               // --shell 模式本就不走 Hermes 通道，别瞎重连
    if (reconnectTries >= MAX_RECONNECT) { console.log('[TAT] 已重连 ' + reconnectTries + ' 次仍未建立通道，放弃'); return; }
    reconnectTries += 1;
    console.log('[TAT] ' + why + ' → 第 ' + reconnectTries + '/' + MAX_RECONNECT + ' 次重连（重新领门票）');
    if (ptyStartTimer) { clearTimeout(ptyStartTimer); ptyStartTimer = null; }
    if (readyFallbackTimer) { clearTimeout(readyFallbackTimer); readyFallbackTimer = null; }
    proxySent = false;
    ptyReadySeen = false;
    try {
      const fresh = await restTatSession();
      Object.assign(tat, fresh);
      if (fresh.sessionId) CFG.sessionId = fresh.sessionId;
    } catch (e) { console.log('[TAT] 重领门票失败: ' + e.message); return; }
    deadline = Date.now() + 90000;          // 每次重连都给看门狗续命
    setTimeout(() => openTat(), 800);
  }

  openTat();

  // 发一条文本 JSON 帧（等价前端 sendJson：SessionAuth / PtyStart / PtyStop / PtyInput 等）
  function sendTextJson(obj) { outer.send(JSON.stringify(obj), 0x1); }

  // 往 PTY 敲内容（前端 sendPtyInput：{Type:'PtyInput', Data:{SessionId, Input:<base64 文本>}}，文本帧）
  function sendPtyInput(text) {
    console.log('[Shell] → 发送 PtyInput');
    sendTextJson({
      Type: 'PtyInput',
      Data: { SessionId: CFG.sessionId, Input: Buffer.from(String(text), 'utf8').toString('base64') },
    });
  }

  // PtyOutput 文本提取（对齐前端 f()）：Data.Output / Data.Data 是 base64，解出来是终端文本
  function ptyOutputText(fields) {
    const d = fields && fields.Data; if (!d) return '';
    const cands = [d.Output, d.Data, d.Data && d.Data.Output, d.Data && d.Data.Data];
    for (const v of cands) {
      if (typeof v === 'string' && v) {
        if (/^[A-Za-z0-9+/=\s]+$/.test(v)) { try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) {} }
        return v;
      }
      if (Buffer.isBuffer(v) && v.length) return v.toString('utf8');
    }
    return '';
  }

  // ★ --shell 模式：完全绕开机器人，直接往沙箱 PTY 敲 shell 命令，拿【原始输出】
  //   触发有两条路：① 见到 __LV_DASHBOARD_READY__ 标记（后端刚启动）；② 超时兜底（后端已在跑时不会再打印标记）
  function startShellMode(why) {
    if (shellActive) return;
    shellActive = true;
    console.log('[Shell] 进入原始命令行(' + why + ')，1.5s 后发送：' + JSON.stringify(CFG.shellCmd));
    setTimeout(() => sendPtyInput(CFG.shellCmd + '\n'), 1500);
    setTimeout(() => {
      console.log('\n[Shell] ======== 原始输出结束（共 ' + shellOut.length + ' 字符）========');
      process.exit(0);
    }, CFG.shellWaitMs + 1500);
  }

  // 处理 PtyOutput（文本 JSON 帧）：Data.Output 是 base64 终端文本
  function handlePtyOutput(j) {
    const d = j && j.Data; if (!d) return;
    let txt = '';
    for (const v of [d.Output, d.Data]) {
      if (typeof v === 'string' && v) { try { txt = Buffer.from(v, 'base64').toString('utf8'); } catch (e) { txt = v; } break; }
    }
    if (!txt) return;
    ptyOutBuf = (ptyOutBuf + txt).slice(-4096);
    if (shellActive) { shellOut += txt; process.stdout.write(txt); }   // --shell 模式：原样打印
    const m = ptyOutBuf.match(/__LV_DASHBOARD_READY__:([A-Za-z0-9_\-]+)/);
    if (m && !hermesToken) {
      hermesToken = m[1];
      console.log('[Hermes] 已从 PTY 输出拿到 session token:', hermesToken);
      if (CFG.shellCmd) { startShellMode('后端已就绪'); }
      else if (!proxySent) { proxySent = true; sendPtyProxyNew(); }
    }
    const em = ptyOutBuf.match(/__LV_DASHBOARD_ERROR__:([a-z_]+)/);
    if (em) console.log('[TAT] 后端启动报错标记:', em[1]);
  }

  // 启动 Hermes 后端：PtyStart（文本 JSON，Program/Args 完全对齐前端）
  // 后端就绪后会在 PTY 输出里打印 `__LV_DASHBOARD_READY__:<token>`
  function sendPtyStart() {
    if (!PTY_START_FN) { console.log('[TAT] 无 PTY 启动函数，跳过 PtyStart，直接开代理通道'); proxySent = true; return sendPtyProxyNew(); }
    console.log('[TAT] 发送 PtyStart（启动 Hermes 后端，函数长度 ' + PTY_START_FN.length + '）');
    sendTextJson({
      Type: 'PtyStart',
      Data: {
        SessionId: CFG.sessionId,
        ChannelId: '',
        Cols: 120,
        Rows: 32,
        UserName: 'agentuser',
        Cwd: '/home/agentuser',
        Envs: {},
        Program: '/bin/sh',
        // ★ 注意：lv-ptystart-fn.js 抓下来的函数【结尾已带 `exec /bin/sh -i`】，不要再拼一次，
        //   否则 sh 会把多出来的 `exec` 当成脚本文件名 → `/bin/sh: 0: cannot open exec`。
        Args: ['-c', PTY_START_FN],
      },
    });
    // --shell 模式兜底：后端已在跑时不会再打印 ready 标记，8s 后照样敲命令
    if (CFG.shellCmd) setTimeout(() => startShellMode('8s 超时兜底'), 8000);
    // 兜底：12s 内既没拿到 token 也没开通道，就先用空 token 开通道试一把
    readyFallbackTimer = setTimeout(() => {
      if (CFG.shellCmd) return;
      if (!ptyReadySeen && !proxySent) { console.log('[TAT] 12s 未见 ready 标记，先开代理通道（空 token 试探）'); proxySent = true; sendPtyProxyNew(); }
    }, 12000);
  }

  // 发送 PtyProxyNew：标准 BSON 二进制帧（已与实抓 225 字节逐字节对齐，无需文本兜底）
  function sendPtyProxyNew() {
    const frame = bsonDoc([
      bsonStr('Type', 'PtyProxyNew'),
      bsonDocEl('Data', bsonDoc([
        bsonStr('SessionId', CFG.sessionId),
        bsonStr('ChannelId', CFG.proxyChannel),
        bsonStr('CustomData', ''),
        bsonDocEl('Data', bsonDoc([
          bsonStr('ProxyId', CFG.proxyChannel),
          bsonStr('Ip', CFG.proxyHost),
          bsonStr('Port', String(CFG.proxyPort)),
        ])),
      ])),
    ]);
    console.log('[TAT] 发送 PtyProxyNew(BSON 二进制帧, ' + frame.length + ' 字节)');
    outer.send(frame);
  }

  // 诊断看门狗：距上次(重)连超过 90s 仍未建立 Hermes 通道才放弃（后端启动可能耗时，且重连会续命）。
  // ★ 本地化适配：国际版是「每号一个 node 进程」，看门狗可直接 process.exit(2)；
  //   国内版是单进程批量跑多号（全量模式 for 循环），杀进程会连累整批 → 改为只判失败【当前这一号】，让批量继续下一号。
  const wdTimer = setInterval(() => {
    if (hermesOpen) { clearInterval(wdTimer); return; }
    if (Date.now() > deadline) {
      console.log('[WATCHDOG] 超时未建立 Hermes 通道，判失败当前号。ptyReadySeen=' + ptyReadySeen + ' hermesOpen=' + hermesOpen + ' token=' + (hermesToken ? '有' : '无') + ' 已重连=' + reconnectTries + ' 次');
      forceFailRun('看门狗超时：未建立 Hermes 通道（已达重连上限或重领门票失败）');
    }
  }, 1000);

  // 连接 Hermes：发 WS 握手（无论有无 token 都发，便于观察后端反应并捕获 token）
  function connectHermes() {
    const token = hermesToken || '';
    console.log('[Hermes] 发送 WS 握手 (token=' + (token ? '已就位' : '缺失, 试探') + ')');
    const handshake =
      `GET /api/ws?token=${token} HTTP/1.1\r\n` +
      `Host: ${CFG.proxyHost}:${CFG.proxyPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    sendTunnel(Buffer.from(handshake, 'utf8'));
  }

  async function afterHermesOpen() {
    // 镜像前端初始交互：先 ping
    try { await hermesSend('gateway.ping', {}); } catch (e) {}
    // 单轮回复结束判据（对齐前端 settle 逻辑）：
    //   ① session.info 且 running===false（出现 message.start 之后）→ 本轮真正结束（最可靠）
    //   ② 兜底：idleMs 静默 或 超过 maxMs 总时长（部署类任务 agent 跑工具时可能长时间无输出）
    const idleMs = parseInt(process.env.LIGHTVELA_IDLE_MS || '120000', 10);   // 静默 2 分钟算本轮结束
    const maxMs = parseInt(process.env.LIGHTVELA_MAX_MS || String(DEPLOY_WAIT_MS), 10);  // 单轮上限（默认 40 分钟，部署很慢）
    // D 免费重试：部署判定失败后，同一机器人重发命令（不花号、不花套餐——bot 实例/套餐都已就绪）
    const maxRetry = parseInt(process.env.LIGHTVELA_DEPLOY_RETRY || '2', 10);
    // F 主动验证：判失败后让机器人自己查探针状态，拿机器可读答案（比"听机器人自述"可靠）
    const doVerify = String(process.env.LIGHTVELA_VERIFY || '1') !== '0';
    const verifyMsg = process.env.LIGHTVELA_VERIFY_MSG || DEFAULT_VERIFY_MSG;
    // 整个部署流程的软上限：防多轮重试拖过批量的 40 分钟硬超时（硬超时下进程被杀，结果全丢）
    const totalCapMs = parseInt(process.env.LIGHTVELA_TOTAL_CAP_MS || String(35 * 60 * 1000), 10);

    const tStart = Date.now();
    let sessionId = null;

    // 等一轮回复结束（事件驱动 + 静默/总时长兜底），用完注销监听避免堆积
    // 单轮上限 = min(配置上限, 总软上限的剩余时间)，保证整个流程不会拖过批量硬超时
    const waitRoundEnd = () => new Promise((res) => {
      const t0 = Date.now();
      const cap = Math.min(maxMs, tStart + totalCapMs - t0);
      let last = Date.now();
      let sawStart = false;
      let done = false;
      let timer = null;
      const finish = (why) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        remove();
        console.log('[Hermes] 本轮结束(' + why + ')');
        res();
      };
      const remove = onEvent((m) => {
        const p = (m && m.params) || {};
        const ty = p.type || m.method || '';
        if (ty === 'message.start') sawStart = true;
        if (ty === 'session.info' && sawStart && p.payload && p.payload.running === false) return finish('running=false');
        last = Date.now();
      });
      timer = setInterval(() => {
        if (Date.now() - t0 > cap) return finish('总时长上限');
        if (Date.now() - last > idleMs) return finish('静默超时');
      }, 500);
    });

    // 发一条消息并等整轮回复结束（回复累积进 replyText）
    const sendAndWait = async (label, text) => {
      replyText = ''; curMsg = ''; gotMessageStart = false;   // 重置本轮回复缓冲
      const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
      console.log('\n[发送]（' + label + '）', preview);
      process.stdout.write('[回复] ');
      try {
        const sub = await hermesSend('prompt.submit', { session_id: String(sessionId), text, queued: true });
        console.log('\n[Hermes] prompt.submit →', JSON.stringify(sub.result || sub.error || {}).slice(0, 200));
      } catch (e) { console.log('\n[Hermes] prompt.submit 异常:', e.message); }
      await waitRoundEnd();
      return replyText;
    };

    let ok = false;
    let verified = false;
    let attempts = 0;
    let lastReply = '';

    // ★ prompt.submit 要的是【活的 live session_id】（用持久 id 会被回 4001 session not found）。
    //   每轮重开一个 session：干净上下文，沙箱不变（探针装完就在，重装命令是幂等的）。
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      if (Date.now() - tStart > totalCapMs) { console.log('[部署] 已达总时长软上限(' + (totalCapMs / 60000) + ' 分钟)，停止重试'); break; }
      try {
        const c = await hermesSend('session.create', { cwd: '/home/agentuser', source: 'desktop' });
        const r = c.result || {};
        console.log('[Hermes] session.create →', JSON.stringify(r).slice(0, 300));
        sessionId = r.session_id || null;
      } catch (e) { console.log('[Hermes] session.create 失败:', e.message); }
      if (!sessionId) { console.error('拿不到 live session_id，无法发送消息'); break; }
      console.log('[Hermes] live session_id =', sessionId);

      attempts = attempt + 1;
      lastReply = await sendAndWait('第 ' + attempts + ' 次部署尝试', message);
      ok = isDeployOk(lastReply);
      console.log('\n[回复全文长度]', (lastReply || '').length, '| [部署成功判定]', ok);
      if (ok) break;

      // F：判失败后主动验证——机器人自己查探针进程/服务状态，最后一行给机器可读答案
      if (doVerify) {
        const vReply = await sendAndWait('主动验证：查探针运行状态', verifyMsg);
        const vr = parseVerifyResult(vReply);
        console.log('\n[主动验证结果]', vr === null ? '无法判定（回复里没有机器可读答案）' : (vr ? '探针在运行 → 改判成功' : '探针未运行 → 准备重试'));
        if (vr === true) { ok = true; verified = true; break; }
      }

      if (attempt < maxRetry) {
        console.log('[部署] 第 ' + attempts + ' 次未成功，免费重试：同一机器人重发部署命令（不花号不花套餐）…');
      }
    }

    console.log('\n[回复全文长度]', (lastReply || '').length, '| [部署成功判定]', ok, '| 尝试 ' + attempts + ' 次 | 主动验证改判', verified);
    console.log('RESULT=' + (ok ? 'OK|deploy_success' + (verified ? '|verified' : '') : 'FAIL|no_success_phrase'));
    try { outer.close(); } catch (e) {}
    settle({ ok, replyText: lastReply, replyLen: (lastReply || '').length, attempts, verified });
  }

  return finished;
}

// ===================== 入口：国内版全流程 =====================
// 凭证落盘（与国际版 lv-tokens.json 隔离，独立文件 domestic-tokens.json）
function saveDomesticToken(cred) {
  const fs = require('fs');
  const base = process.env.LIGHTVELA_DOMESTIC_TOKENS || (__dirname + '/domestic-tokens');
  // 并发安全：每个账号独立追加一行 JSON（O_APPEND 原子写，多子进程互不覆盖），
  // 读取时按 idCard 合并（后写覆盖先写）。与国际版 lv-tokens.json 物理隔离。
  const nd = base.replace(/\.json$/, '') + '.ndjson';
  try { fs.appendFileSync(nd, JSON.stringify(cred) + '\n'); }
  catch (e) { console.warn('[凭证] 写失败:', e.message); }
  console.log('[凭证] 已追加 -> ' + nd + ' (' + (cred.idCard || cred.name) + ')');
}

// ★ 续跑：从凭证文件取回某账号最新一条记录（按姓名匹配，后写覆盖先写）
//   用于「已登录+已实名，只差订阅/部署」的场景：不再取号、不再发码、不再实名，
//   直接复用上次落盘的 bearer，省掉豪猪接码费也不会换号（换号 = 变成另一个全新账号）。
function readDomesticToken(name, idCard) {
  const fs = require('fs');
  const base = process.env.LIGHTVELA_DOMESTIC_TOKENS || (__dirname + '/domestic-tokens');
  const nd = base.replace(/\.json$/, '') + '.ndjson';
  let hit = null;
  try {
    const txt = fs.readFileSync(nd, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      // ★ 优先按身份证匹配（唯一，重名也不会串号）；没有身份证才退回按姓名
      const match = idCard ? (o && o.idCard === idCard) : (o && o.name === name);
      if (match) hit = o;   // 取最后一条（最新）
    }
  } catch (e) { return null; }
  return hit;
}

// 取号登录 → 实名 →（模式①仅到此拿凭证）→ 抢套餐 → 建机器人 → 把部署消息发给机器人 → 抓回复 → 判那句话

// ===================== 活跃探测模式（2026-10-26） =====================
// 目的：给账号制造一次 AI 积分消耗（平台活动「当天有积分消耗即算活跃一天」）。
// 用法：LIGHTVELA_ACTIVE_JSON=账号.json node domestic_lightvela_bot.js
// 账号.json: {name, bearer, instanceId, question, src}
// 流程：查积分 → runChat 发一句 → 轮询积分，看数字有没有降。
async function creditSnapshot() {
  try {
    const r = await httpsReq('GET', '/v1/passes', { timeoutMs: 20000, retries: 1 });
    const d = unwrapData(r.json) || {};
    const passes = d.passes || [];
    const p = passes.find((x) => x.status === 'active') || passes[0] || {};
    return {
      bundle: p.bundle_name || '',
      expired: p.expired_time || '',
      credit_total: p.credit_total,
      credit_available: p.credit_available,
      free_total: p.free_credit_total,
      free_available: p.free_credit_available,
    };
  } catch (e) {
    return { error: e.message };
  }
}


// ===================== 设备指纹（按账号种子化，2026-10-26） =====================
// 背景：原来所有请求都是同一个写死的 UA 'Mozilla/5.0 LightVelaPureCode'，
//   并发跑时平台看到"同一个客户端同时操作多个账号"→ 回话但积分不记账。
// 做法：按 uid 做种子，同一账号永远同一张脸，不同账号一定不同脸。
function _seedHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

const _UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', ch: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', ch: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="99"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', ch: '"Google Chrome";v="129", "Chromium";v="129", "Not_A Brand";v="24"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', ch: '"Google Chrome";v="128", "Chromium";v="128", "Not_A Brand";v="24"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36', ch: '"Google Chrome";v="132", "Chromium";v="132", "Not_A Brand";v="24"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', ch: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', plat: '"macOS"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', ch: '"Google Chrome";v="129", "Chromium";v="129", "Not_A Brand";v="24"', plat: '"macOS"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', ch: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="99"', plat: '"macOS"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', ch: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"', plat: '"Windows"', mob: '?0' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', ch: '"Microsoft Edge";v="130", "Chromium";v="130", "Not_A Brand";v="99"', plat: '"Windows"', mob: '?0' },
];

const _LANG_POOL = [
  'zh-CN,zh;q=0.9',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.8,en-US;q=0.7,en;q=0.6',
  'zh-CN,zh-Hans;q=0.9,zh;q=0.8',
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
];

const _REF_POOL = [
  'https://www.lightvela.com/',
  'https://www.lightvela.com/console',
  'https://www.lightvela.com/dashboard',
  'https://www.lightvela.com/chat',
];

function setFingerprint(seedStr) {
  const seed = _seedHash(String(seedStr || 'x'));
  const u = _UA_POOL[seed % _UA_POOL.length];
  const lang = _LANG_POOL[(seed >>> 3) % _LANG_POOL.length];
  const ref = _REF_POOL[(seed >>> 7) % _REF_POOL.length];
  CFG.fp = {
    'User-Agent': u.ua,
    'sec-ch-ua': u.ch,
    'sec-ch-ua-mobile': u.mob,
    'sec-ch-ua-platform': u.plat,
    'Accept-Language': lang,
    'Origin': 'https://www.lightvela.com',
    'Referer': ref,
  };
  return CFG.fp;
}

async function runActiveProbe(file) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  CFG.bearer = spec.bearer;
  if (spec.instanceId) CFG.instanceId = spec.instanceId;
  // ★ 按 uid 生成固定指纹（同账号重跑同一张脸）
  const _fp = setFingerprint(spec.uid || spec.name || spec.instanceId);
  console.log('[指纹] ' + _fp['User-Agent'].slice(0, 78) + ' | ' + _fp['sec-ch-ua-platform'] + ' | ' + _fp['Accept-Language']);
  console.log('[探测] ' + spec.name + ' | 实例=' + (spec.instanceId || '(无)') + ' | 来源=' + (spec.src || ''));
  console.log('[问题] ' + spec.question);

  const before = await creditSnapshot();
  console.log('[积分前] ' + JSON.stringify(before));

  let reply = '', ok = false, err = '';
  try {
    const r = await runChat(spec.question);
    ok = !!(r && r.ok);
    reply = (r && r.replyText) || '';
    err = (r && r.error) || '';
  } catch (e) {
    err = e.message;
  }
  console.log('[回复] ok=' + ok + ' 长度=' + reply.length + ' | ' + JSON.stringify(reply.slice(0, 200)));

  // 轮询积分（平台记账可能有延迟）：最多 12 次 × 5 秒 = 60 秒
  let after = before;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const snap = await creditSnapshot();
    if (!snap || snap.error) continue;
    after = snap;
    const dc = (before.credit_available != null && snap.credit_available != null) ? before.credit_available - snap.credit_available : 0;
    const df = (before.free_available != null && snap.free_available != null) ? before.free_available - snap.free_available : 0;
    if (dc > 0 || df > 0) { console.log('[积分] 第 ' + (i + 1) + ' 次轮询发现变化'); break; }
  }
  console.log('[积分后] ' + JSON.stringify(after));

  const b = (!before.error) ? before : null;
  const a = (!after.error) ? after : null;
  const creditDelta = (b && a && b.credit_available != null && a.credit_available != null) ? (b.credit_available - a.credit_available) : null;
  const freeDelta = (b && a && b.free_available != null && a.free_available != null) ? (b.free_available - a.free_available) : null;
  const consumed = (creditDelta != null && creditDelta > 0) || (freeDelta != null && freeDelta > 0);

  console.log('RESULT_JSON=' + JSON.stringify({
    name: spec.name, src: spec.src, instanceId: spec.instanceId,
    question: spec.question, replyOk: ok, reply: reply.slice(0, 400), error: err,
    before: b, after: a, creditDelta, freeDelta, consumed,
  }));
}

async function main() {
  // ★ 活跃探测模式：只发一句、查积分前后，不取号/不登录/不抢套餐/不建Bot
  const ACTIVE_JSON = process.env.LIGHTVELA_ACTIVE_JSON || '';
  if (ACTIVE_JSON) {
    try {
      await runActiveProbe(ACTIVE_JSON);
      process.exit(0);
    } catch (e) {
      console.error('PROBE_FAIL=' + e.message);
      process.exit(1);
    }
  }
  const args = process.argv.slice(2);
  const msgArg = (args.find((a) => a === '--message') && args[args.indexOf('--message') + 1]) || '';
  const loginOnly = args.includes('--login-only');   // 模式①：只登录拿凭证，不部署
  const resume = args.includes('--resume');           // 模式③：续跑（复用已登录凭证，跳过取号/登录/实名）

  // 批量并发：每个账号由独立子进程跑（--account-idx N），主进程只调度。
  const idxPos = args.indexOf('--account-idx');
  const singleIdx = idxPos >= 0 ? parseInt(args[idxPos + 1], 10) : -1;
  if (singleIdx >= 0 && (isNaN(singleIdx) || singleIdx < 0 || singleIdx >= ACCOUNTS.length)) {
    throw new Error('--account-idx 越界: ' + args[idxPos + 1] + ' (共 ' + ACCOUNTS.length + ' 个)');
  }
  const runPairs = singleIdx >= 0
    ? [{ acc: ACCOUNTS[singleIdx], idx: singleIdx }]
    : ACCOUNTS.map((a, i) => ({ acc: a, idx: i }));
  if (singleIdx >= 0) console.log('[单账号模式] idx=' + singleIdx + ' name=' + ACCOUNTS[singleIdx].name + (loginOnly ? ' [仅登录]' : ''));

  // ★ 单进程全量模式（未传 --account-idx）由本进程统一调度，启动时清空上轮残留的「身份占用标记」，避免误跳过；
  //   子进程模式（带 --account-idx）由 domestic_core.py 在每轮运行开头统一清空，这里不重复清，避免并发竞态。
  if (singleIdx < 0) {
    for (const f of [CLAIMS_FILE, CLAIMS_LOCK]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }

  try { console.log('[' + (SMS_PROVIDER === 'feihu' ? '飞狐' : SMS_PROVIDER === 'lubansms' ? '鲁班' : '豪猪') + '] 当前余额:', await SMS.balance(), '（余额不足会导致取号/接码失败，批量前请充值）'); }
  catch (e) { console.warn('[豪猪] 查余额失败:', e.message); }

  if (!ACCOUNTS.length) throw new Error('ACCOUNTS 为空：把每账号的 name+idCard 填进去');
  const deployMsg = msgArg || readDeployMsg();
  console.log('[部署] 待发消息 ' + deployMsg.length + ' 字符，来源=' + (msgArg ? '--message 参数' : DEPLOY_MSG_FILE));

  const results = [];
  for (const { acc, idx } of runPairs) {
    // ★ 换账号时强制换新隧道 → 该账号的出口 IP 与上一个账号不同（单进程批量模式必需；
    //   子进程模式本循环只跑一次、且 agent 是全新的，reset 为空操作，无副作用）
    if (EGRESS_AGENTS.length) EGRESS_AGENTS.forEach(resetHttpsAgent);
    // ★ 实名补救跨进程协调：本身份若已被别的账号补救占用（consumed），本子进程直接跳过，不再注册本身份
    const selfStatus = await markSelfRunning(idx);
    if (selfStatus === 'skipped') {
      console.log(`[跳过] idx=${idx} ${acc.name}：本身份已被其他账号实名占用（补救），不再注册本身份`);
      results.push({ idx, name: acc.name, idCard: acc.idCard, skipped: true });
      continue;
    }
    try {
      // 1) 取号 → 发码 → 取码 → 验码 → 实名（Bearer 写进 CFG）
      //    ★ 续跑模式：整段跳过，直接复用上次落盘的 bearer（不取号 / 不花钱 / 不换号）
      let uid, phone, realname = { name: acc.name, idCard: acc.idCard }, reused = false;
      if (resume) {
        const saved = readDomesticToken(acc.name, acc.idCard);
        if (saved && saved.bearer) {
          // 有凭证 → 直接复用，跳过取号/登录/实名（不花钱、不换号）
          CFG.bearer = saved.bearer;
          if (saved.instanceId) CFG.instanceId = saved.instanceId;
          uid = saved.uid; phone = saved.phone;
          if (saved.idCard) realname = { name: saved.name || acc.name, idCard: saved.idCard };
          reused = true;
          console.log('[复用] 复用已存凭证：' + acc.name + '（跳过取号/实名）');
        }
      }
      if (!reused) {
        // 无凭证（或没勾复用）→ 正常取号→实名登录；复用模式缺凭证则自动补全并保存（对齐国际版"有就用、没有就登录补全并保存"）
        const lg = await domesticLogin(acc, idx);
        uid = lg.uid; phone = lg.phone; realname = lg.realname;
      }
      // 凭证落盘（与国际版隔离），供 UI/后续复用
      // ★ 用「实际实名身份」realname 落盘：补救后可能是另一条排队身份，按它存才能保证续跑/去重正确
      const cred = { name: realname.name, idCard: realname.idCard, phone, uid, bearer: CFG.bearer };
      if (!reused) saveDomesticToken(cred);   // 复用且有凭证不重复追加；登录/补全都存盘
      console.log('DOMESTIC_CRED_JSON=' + JSON.stringify(cred));
      if (loginOnly) { results.push({ uid, phone, loginOk: true }); continue; }   // 模式①：只拿凭证
      // 2) 抢套餐（0 元包；2026-10-22 起实际可用 bundle_free_trial_01）
      const subOk = await restSubscribe();
      if (!subOk) throw new Error('抢套餐失败');
      // 3) 建机器人（有就复用，没有就建 + 轮询到 active/running）
      const botOk = await restCreateBot(INSTANCE_NAME);
      if (!botOk) throw new Error('建机器人失败');
      // 4) 把部署消息发给机器人 + 抓回复（runChat 内部会自动设主模型，否则机器人不回话；
      //    判失败会自动 F 主动验证 + D 免费重试，最多 LIGHTVELA_DEPLOY_RETRY 次）
      const r = await runChat(deployMsg);
      const ok = !!(r && r.ok);
      const extra = {};
      if (r && r.attempts) extra.deployAttempts = r.attempts;   // 部署尝试次数（>1 说明走了重试）
      if (r && r.verified) extra.verified = true;               // F 主动验证改判成功（机器人自述没命中，但探针确实在跑）
      saveDomesticToken(Object.assign({}, cred, { instanceId: CFG.instanceId, deployOk: ok }, extra));
      results.push(Object.assign({ uid, phone, instanceId: CFG.instanceId, deployOk: ok, replyLen: r && r.replyLen }, extra));
      await markIdentityDone(idx);
    } catch (e) {
      console.error('  ❌ 账号失败:', acc.name, e.message);
    }
  }

  if (singleIdx >= 0) {
    // 子进程模式：用退出码告诉调度器成功/失败（0=成功，1=失败）
    const r = results[0];
    const okFlag = loginOnly ? (r && r.loginOk) : (r && r.deployOk);
    process.exit(okFlag ? 0 : 1);
  }
  console.log('\n全部完成:', JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
