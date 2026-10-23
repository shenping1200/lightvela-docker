'use strict';
/**
 * lv-proxy.js —— 让纯代码的出站连接"走环境代理"（HTTP / HTTPS / SOCKS5），零依赖。
 * ------------------------------------------------------------------
 * 背景：HubStudio 每个环境都配了各自的代理 IP（出口）。纯代码若直连，
 *       出口就是本机 IP，跟登录时的环境 IP 不一致 → 做不到账号隔离。
 *       本模块把环境的代理"挂"到纯代码的两条出站连接上：
 *         · 连 LightVela 官网（HTTPS）→ 用 makeHttpsAgent() 挂到 https.request
 *         · 连腾讯云 TAT 中继（WSS）  → 用 connectTunnel() 先钻隧道，再升级 TLS
 *
 * 支持的代理类型（对应 HubStudio 的 proxyTypeName）：
 *   http    → CONNECT 明文
 *   https   → 连代理本身走 TLS，再 CONNECT
 *   socks5  → SOCKS5 握手（支持 无认证 / 用户名密码）
 *   direct / 空 → 返回 null（不走代理，行为等同原来）
 *
 * 对外接口：
 *   normalizeProxy(p)                        把 Hub 环境的代理字段规整成内部结构
 *   connectTunnel({proxy,targetHost,targetPort})  → Promise<net.Socket>（已钻到目标，未做目标 TLS）
 *   makeHttpsAgent(proxy)                    → https.Agent | undefined（给 https.request 用）
 */

const net = require('net');
const tls = require('tls');
const https = require('https');

// ---------- 规整 Hub 环境里的代理字段 ----------
function normalizeProxy(p) {
  if (!p) return null;
  const rawType = String(p.type || p.proxyTypeName || '').trim();
  const type = rawType.toLowerCase();
  const host = String(p.host || p.proxyHost || p.proxyServer || '').trim();
  const port = parseInt(p.port || p.proxyPort || 0, 10);
  if (!host || !port) return null;
  // 直连 / 无代理 → 返回 null（调用方走原来的直连逻辑）
  if (/direct|no.?proxy|none|直连/.test(type)) return null;

  let kind = 'http';
  if (/socks/.test(type)) kind = 'socks5';
  else if (/https/.test(type)) kind = 'https';
  else if (/http/.test(type)) kind = 'http';
  else kind = 'http'; // 未知类型按 http 代理兜底

  return {
    kind,
    host,
    port,
    username: String(p.username || p.proxyAccount || p.proxyUserName || ''),
    password: String(p.password || p.proxyPassword || ''),
  };
}

// ---------- HTTP / HTTPS 代理：CONNECT 隧道 ----------
function httpConnect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = proxy.kind === 'https'
      ? tls.connect(proxy.port, proxy.host, { rejectUnauthorized: false })
      : net.connect(proxy.port, proxy.host);

    let settled = false;
    let buf = Buffer.alloc(0);
    const fail = (e) => { if (!settled) { settled = true; try { sock.destroy(); } catch (_) {} reject(e); } };

    const onConn = () => {
      let req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n`;
      if (proxy.username) {
        const auth = Buffer.from(proxy.username + ':' + proxy.password, 'utf8').toString('base64');
        req += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      req += '\r\n';
      sock.write(req);
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString('utf8');
      const status = parseInt((head.split('\r\n')[0].split(' ')[1] || '0'), 10);
      if (status !== 200) return fail(new Error('代理 CONNECT 失败: ' + head.split('\r\n')[0]));
      if (settled) return;
      settled = true;
      sock.removeListener('data', onData);
      const rest = buf.slice(idx + 4);
      if (rest.length) { try { sock.unshift(rest); } catch (_) {} }
      resolve(sock);
    };

    sock.on('data', onData);
    sock.on('error', fail);
    if (proxy.kind === 'https') sock.on('secureConnect', onConn);
    else sock.on('connect', onConn);
  });
}

// ---------- SOCKS5：握手 + 认证 + 连接请求 ----------
function socks5Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let stage = 0;                 // 0=问候 1=认证 2=连接
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { sock.destroy(); } catch (_) {} reject(e); } };
    const methods = proxy.username ? [0x00, 0x02] : [0x00];

    const sendGreeting = () => sock.write(Buffer.from([0x05, methods.length, ...methods]));

    const sendConnect = () => {
      const host = targetHost;
      const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(host);
      let addr;
      if (isIP) addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
      else { const hb = Buffer.from(host, 'utf8'); addr = Buffer.concat([Buffer.from([0x03, hb.length]), hb]); }
      const port = Buffer.alloc(2); port.writeUInt16BE(targetPort, 0);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, port]));
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const ver = buf[0], method = buf[1];
        if (ver !== 0x05) return fail(new Error('SOCKS5 版本不符: ' + ver));
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 1;
          const u = Buffer.from(proxy.username, 'utf8');
          const p = Buffer.from(proxy.password, 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        } else if (method === 0x00) { stage = 2; sendConnect(); }
        else return fail(new Error('SOCKS5 需要认证但代理拒绝(方法=' + method + ')'));
      } else if (stage === 1) {
        if (buf.length < 2) return;
        const st = buf[1]; buf = buf.slice(2);
        if (st !== 0x00) return fail(new Error('SOCKS5 用户名/密码认证失败'));
        stage = 2; sendConnect();
      } else if (stage === 2) {
        if (buf.length < 4) return;
        const rep = buf[1], atyp = buf[3];
        let need = 4;
        if (atyp === 0x01) need = 4 + 4 + 2;
        else if (atyp === 0x03) { if (buf.length < 5) return; need = 4 + 1 + buf[4] + 2; }
        else if (atyp === 0x04) need = 4 + 16 + 2;
        if (buf.length < need) return;
        if (rep !== 0x00) return fail(new Error('SOCKS5 连接被拒(rep=' + rep + ')'));
        if (settled) return;
        settled = true;
        sock.removeListener('data', onData);
        const rest = buf.slice(need);
        if (rest.length) { try { sock.unshift(rest); } catch (_) {} }
        resolve(sock);
      }
    };

    sock.on('connect', sendGreeting);
    sock.on('data', onData);
    sock.on('error', fail);
  });
}

/**
 * 建立到 targetHost:targetPort 的隧道，返回"已连通"的裸 socket（未做目标侧 TLS）。
 * 调用方拿到后可：① 直接当明文 socket 用；② tls.connect({socket}) 升级成到目标的 TLS。
 */
function connectTunnel({ proxy, targetHost, targetPort }) {
  if (!proxy) return Promise.reject(new Error('无代理配置'));
  if (proxy.kind === 'socks5') return socks5Connect(proxy, targetHost, targetPort);
  return httpConnect(proxy, targetHost, targetPort);
}

/**
 * 给 https.request 用的 agent。
 * 关键点（2026-10-22 修复）：
 *   1) Node v22 不认 `new https.Agent({ createConnection })` 构造选项里的 createConnection，
 *      必须手动赋值 agent.createConnection，否则 agent 仍走内置直连 → 代理形同虚设、出口是本机 IP。
 *   2) keepAlive + 单账号复用同一条隧道 → 出口 IP 全程固定不变（满足"单账号固定 IP"）。
 *   3) 代理池"按连接轮换"时，每个账号用独立子进程/独立 agent → 账号间出口 IP 互不相同；
 *      单进程批量模式用 resetHttpsAgent() 在换账号时强制换隧道，保证账号间 IP 不同。
 * 返回 undefined 表示"不走代理"（调用方按原样直连）。
 */
function makeHttpsAgent(proxy) {
  if (!proxy) return undefined;
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 1,                 // 单账号只允许一条隧道 → 全程同一出口 IP，且避免并发请求抢同一 socket
    freeSocketTimeout: 1800000,   // 空闲 30 分钟内不销毁，保证长时间流程（如等验证码）也复用同一条隧道
  });
  // 缓存"已钻通、已对目标做 TLS"的 socket：实现单账号全程同 IP，且空闲后仍能复用
  agent.__lv = { raw: null, tls: null };
  agent.createConnection = function (options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const cache = agent.__lv;
    // 已有活着的隧道 → 直接复用（即便中间有较长空闲，也保持同一出口 IP）
    if (cache.tls && !cache.tls.destroyed && cache.raw && !cache.raw.destroyed) {
      callback(null, cache.tls);
      return;
    }
    connectTunnel({ proxy, targetHost, targetPort })
      .then((raw) => {
        cache.raw = raw;
        const tlsSock = tls.connect({ socket: raw, servername: targetHost, rejectUnauthorized: false });
        cache.tls = tlsSock;
        const clear = () => { if (cache.tls === tlsSock) { cache.tls = null; cache.raw = null; } };
        tlsSock.once('close', clear);
        tlsSock.once('error', (e) => { clear(); callback(e); });
        tlsSock.once('secureConnect', () => callback(null, tlsSock));
      })
      .catch((e) => callback(e));
  };
  return agent;
}

/**
 * 强制让某个 agent 在下一次请求时重新钻隧道（换出口 IP）。
 * 用于：单进程批量模式下，每换一个账号就调一次，保证"账号之间 IP 不同"。
 * 子进程模式（每账号一个进程）下无需调用，因为每个进程本就独立建隧道。
 */
function resetHttpsAgent(agent) {
  if (!agent || !agent.__lv) return;
  const cache = agent.__lv;
  try { if (cache.tls && !cache.tls.destroyed) cache.tls.destroy(); } catch (_) {}
  try { if (cache.raw && !cache.raw.destroyed) cache.raw.destroy(); } catch (_) {}
  cache.tls = null;
  cache.raw = null;
}

module.exports = { normalizeProxy, connectTunnel, makeHttpsAgent, resetHttpsAgent };
