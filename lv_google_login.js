// LightVela 谷歌授权登录（无头浏览器版）
// 用法：node lv_google_login.js --email=... --password=... [--recovery=...]
// 输出（仅 stdout，单行 JSON）：{"ok":true,"token":"..."} 或 {"ok":false,"error":"..."}
// 日志全部走 stderr，避免污染 stdout 的 JSON。
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
const net = require('net');
const crypto = require('crypto');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      if (m[2] !== undefined) a[m[1]] = m[2];
      else { a[m[1]] = argv[i + 1] || ''; i++; }
    }
  }
  return a;
}

const A = parseArgs(process.argv.slice(2));
const EMAIL = (A.email || '').trim();
const PASS = (A.password || '').trim();
const RECOVERY = (A.recovery || '').trim();
const TOTP_SECRET = (A.totp || '').trim();   // 2FA 验证字符串（base32），登录时现算 6 位码

const log = (...x) => console.error('[glogin]', ...x);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONFIRM_WORDS = ['我了解', '了解', 'i understand', 'continue', '继续', '确认', 'i agree', 'agree', 'accept', 'allow', 'approve'];
const CANCEL_WORDS = ['cancel', '取消', 'deny'];

async function stable(page) {
  // 等页面导航/加载稳定，避免「Execution context was destroyed」
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(600);
}

async function clickConfirm(page) {
  let btns = [];
  try {
    await stable(page);
    btns = await page.$$eval('button, a, input[type=submit]', els => els.map(e => ({
      t: (e.textContent || e.value || '').trim(),
      vis: e.offsetParent !== null || e.type === 'submit'
    })));
  } catch (e) {
    log('clickConfirm 读取按钮失败（可能在跳转中），跳过本轮:', (e.message || '').slice(0, 80));
    return null;
  }
  for (const w of CONFIRM_WORDS) {
    for (const b of btns) {
      const lt = b.t.toLowerCase();
      if (lt && lt.includes(w) && !CANCEL_WORDS.some(c => lt.includes(c))) {
        try { await page.click(`text=${b.t}`); log('点确认按钮:', b.t); return b.t; } catch (e) {}
      }
    }
  }
  return null;
}

async function tryFill(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el || !(await el.isVisible())) continue;
      const cur = await el.inputValue().catch(() => '');
      if (!cur) { await el.fill(value); log('填', sel); }
      return sel;
    } catch (e) {
      log('tryFill 选择器失败，试下一个:', sel, '->', (e.message || '').slice(0, 60));
    }
  }
  return null;
}

// ============ TOTP（谷歌两步验证码：base32 + 30s + HMAC-SHA1 + 6 位，与 lv_gui_core.totp 同算法）============
function base32Decode(s) {
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    const idx = map.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret, offset) {
  offset = offset || 0;
  const key = base32Decode(secret);
  if (!key.length) return '';
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

// 谷歌两步验证页的输入框 / 下一步按钮候选选择器（多套兜底，防改版）
const TOTP_INPUT_SELS = [
  'input[name="totpPin"]',
  '#totpPin',
  'input[aria-label="Enter code"]',
  'input[aria-label="输入验证码"]',
  'input[type="tel"]',
  'input[placeholder="Enter code"]',
];
const TOTP_NEXT_SELS = ['#totpNext', 'button:has-text("Next")', 'button:has-text("下一步")'];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    } catch (e) {}
  }
  return null;
}

let totpTries = 0;
// 若当前是谷歌 2FA 页则填码并点 Next，返回 true；否则返回 false（交给原循环处理）
async function handleTotpPage(page) {
  if (!TOTP_SECRET) return false;
  let input = await firstVisible(page, TOTP_INPUT_SELS);
  if (!input) {
    // 没有直接输入框：可能是"选择验证方式"页，尝试点"验证器/获取验证码"选项
    const u = page.url();
    let body = '';
    try { body = (await page.textContent('body')) || ''; } catch (e) {}
    const looksTotp = /challenge\/totp/i.test(u) ||
                      /Google Authenticator|Get a verification code|验证器|输入验证码/i.test(body);
    if (!looksTotp) return false;
    const opt = await firstVisible(page, [
      'div[role="link"]:has-text("Authenticator")',
      'li:has-text("Authenticator")',
      'div[role="button"]:has-text("Authenticator")',
      'div[role="link"]:has-text("验证器")',
      'li:has-text("验证器")',
    ]);
    if (opt) { try { await opt.click(); } catch (e) {} await page.waitForTimeout(2000); }
    input = await firstVisible(page, TOTP_INPUT_SELS);
    if (!input) return false;
  }
  const offset = Math.min(totpTries, 2);   // 首次用当前 30s 窗口；被拒则顺延下个窗口
  totpTries++;
  const code = totpCode(TOTP_SECRET, offset);
  if (!code) { log('2FA 验证字符串无效（base32 解析为空）'); return false; }
  try {
    await input.click();
    await input.fill(code);
  } catch (e) {
    try { await input.type(code, { delay: 30 }); } catch (e2) {}
  }
  log('填入 2FA 验证码:', code, '(offset=' + offset + ')');
  let clicked = false;
  for (const sel of TOTP_NEXT_SELS) {
    try {
      const b = await page.$(sel);
      if (b && await b.isVisible()) { await b.click(); log('点 Next:', sel); clicked = true; break; }
    } catch (e) {}
  }
  if (!clicked) {   // 兜底：按回车提交
    try { await input.press('Enter'); log('未找到 Next，按回车提交'); } catch (e) {}
  }
  await page.waitForTimeout(3000);
  return true;
}

function extractToken(page) {
  const u = page.url();
  let m = u.match(/[#?&]session_token=([0-9a-fA-F]{32,})/);
  if (m) return m[1];
  return null;
}

// ============ 指纹随机化（账号隔离先决条件）============
// 设计：默认按「邮箱」做种子 → 每个账号拿到一个独立且稳定的指纹
//   · 不同账号各异 = 真隔离（谷歌不会把整批号认成同一台设备）
//   · 同一账号重试同脸 = 不会被谷歌当成「一账号多设备」触发风控
// 设环境变量 LV_FP_RANDOM=1 则逐次全随机（牺牲同脸稳定性换取每次都变）。
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 真实 Chromium 在 2026 年的版本区间（避开 147 这种过新/异常值）
const CHROME_VERSIONS = ['128.0.0.0', '129.0.0.0', '130.0.0.0', '131.0.0.0', '132.0.0.0', '133.0.0.0', '134.0.0.0'];

// ============================================================================
// 指纹档案（2026-10-30 重做）
//
// 原来各维度是「各自独立 pick」的，必然产生矛盾组合：
//   · macOS / Linux + Direct3D11 显卡（Direct3D 是 Windows 独有的，2/3 概率矛盾）
//   · Asia/Shanghai + en-US、Europe/Berlin + en-GB（时区配错语言）
//   · Linux 桌面占 1/3（真实用户里不到 3%）
//
// 现在改成「一条链推到底」，每一层只能从上一层给的候选里挑：
//   ① 身份国家（按哈希+权重）→ ② 时区从该国池里挑、语言固定跟国家走
//   → ③ 系统（Windows 72% / macOS 28%，不放 Linux）→ ④ 显卡/屏幕/硬件全部从系统档案里取
// 这样「国家↔时区↔语言」「系统↔显卡↔屏幕↔硬件」必然自洽。
// ============================================================================

// 身份国家：账号是美国的 GitHub 号，所以 US 占 80%，其余英语国家做多样性
const COUNTRY_PROFILES = [
  { code: 'US', weight: 80, tz: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'], lang: 'en-US' },
  { code: 'GB', weight: 8,  tz: ['Europe/London'], lang: 'en-GB' },
  { code: 'CA', weight: 7,  tz: ['America/Toronto', 'America/Vancouver'], lang: 'en-CA' },
  { code: 'AU', weight: 5,  tz: ['Australia/Sydney', 'Australia/Melbourne'], lang: 'en-AU' },
];

// 系统档案：显卡、屏幕、硬件全绑在系统里，不再单独挑
// Windows ~72% / macOS ~28% 是真实桌面占比；Linux 桌面不到 3%，直接不放（它是最典型的爬虫特征）
const OS_PROFILES = [
  {
    brand: 'Windows', platform: 'Win32', weight: 72,
    uaSuffix: 'Windows NT 10.0; Win64; x64',
    screen: [[1920, 1080], [1536, 864], [1366, 768], [2560, 1440], [1600, 900]],
    gpus: [
      { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon(TM) RX 5600 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    ],
    hw: [4, 8, 8, 12, 16],
    dm: [8, 8, 16, 16, 32],
  },
  {
    brand: 'macOS', platform: 'MacIntel', weight: 28,
    uaSuffix: 'Macintosh; Intel Mac OS X 10_15_7',
    screen: [[1440, 900], [1680, 1050], [2560, 1440], [1280, 800], [1512, 982]],
    // ★ Mac 只有 Apple 自研 GPU（Metal），绝不能出现 Direct3D
    gpus: [
      { webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      { webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
      { webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' },
    ],
    // Apple Silicon 是统一内存，常见 8/16/18GB
    hw: [8, 8, 10, 12],
    dm: [8, 16, 16, 18],
  },
];

// 按权重挑一个（r 取 0~1）
function pickByWeight(list, r) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  const target = r * total;
  let acc = 0;
  for (const x of list) {
    acc += x.weight;
    if (target < acc) return x;
  }
  return list[list.length - 1];
}

function buildFingerprint(email) {
  const randomMode = process.env.LV_FP_RANDOM === '1';
  // ★ randomMode 保留（调试用），但改成「每小时换一次种子」而不是真随机：
  //   真随机会让同一个号每次都换机器，等于自毁稳定性。现在最多一小时一轮，且仍按邮箱区分。
  const seedStr = randomMode
    ? ('fp|' + email + '|' + Math.floor(Date.now() / 3600000))
    : ('fp:' + email);
  const seedNum = xmur3(seedStr)();
  const rand = mulberry32(seedNum);
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  // ① 先定身份国家 → ② 时区从该国池里挑，语言固定跟国家走（三者必然自洽）
  const country = pickByWeight(COUNTRY_PROFILES, rand());
  const tz = pick(country.tz);
  const lang = country.lang;

  // ③ 再定系统 → ④ 显卡/屏幕/硬件全部从系统档案里取（四者必然自洽）
  const os = pickByWeight(OS_PROFILES, rand());
  const gpu = pick(os.gpus);
  const scr = pick(os.screen);
  const hw = pick(os.hw);
  const dm = pick(os.dm);

  // ⑤ 浏览器版本独立（Chrome 各系统版本同步，跟系统无关）
  const ver = pick(CHROME_VERSIONS);

  const ua = 'Mozilla/5.0 (' + os.uaSuffix + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
  const appVersion = '5.0 (' + os.uaSuffix + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';

  return {
    ua, appVersion, platform: os.platform, brand: os.brand,
    screenW: scr[0], screenH: scr[1],
    tz, lang, langs: [lang, 'en'],
    gpu, hw, dm, seed: seedNum, randomMode,
    country: country.code,   // 便于日志排查：这个号被分配的是哪国身份
  };
}

// 注入到每个页面的初始化脚本：抹掉 webdriver 标记 + 伪造 navigator / WebGL / 屏幕 / canvas
function fpInitScript(fp) {
  return `
(function(){
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined }); } catch(e){}
  try {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => ${JSON.stringify(fp.platform)} });
    Object.defineProperty(Navigator.prototype, 'vendor', { get: () => 'Google Inc.' });
    Object.defineProperty(Navigator.prototype, 'appVersion', { get: () => ${JSON.stringify(fp.appVersion)} });
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => ${JSON.stringify(fp.ua)} });
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => ${fp.hw} });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => ${fp.dm} });
    Object.defineProperty(Navigator.prototype, 'language', { get: () => ${JSON.stringify(fp.lang)} });
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ${JSON.stringify(fp.langs)} });
  } catch(e){}
  try {
    const WV = ${JSON.stringify(fp.gpu.webglVendor)};
    const WR = ${JSON.stringify(fp.gpu.webglRenderer)};
    const hook = function(orig){ return function(p){ if(p===37445) return WV; if(p===37446) return WR; return orig.call(this,p); }; };
    WebGLRenderingContext.prototype.getParameter = hook(WebGLRenderingContext.prototype.getParameter);
    if (window.WebGL2RenderingContext) WebGL2RenderingContext.prototype.getParameter = hook(WebGL2RenderingContext.prototype.getParameter);
  } catch(e){}
  try {
    const SW=${fp.screenW}, SH=${fp.screenH};
    Object.defineProperty(screen, 'width', { get: () => SW });
    Object.defineProperty(screen, 'height', { get: () => SH });
    Object.defineProperty(screen, 'availWidth', { get: () => SW });
    Object.defineProperty(screen, 'availHeight', { get: () => SH });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  } catch(e){}
  try {
    const SEED = ${fp.seed};
    const orig = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(){
      try {
        const w = this.width, h = this.height;
        if (w < 2 || h < 2) return orig.apply(this, arguments);
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const octx = off.getContext('2d');
        octx.drawImage(this, 0, 0);
        const img = octx.getImageData(0, 0, w, h);
        const d = img.data;
        let s = SEED;
        for (let i = 0; i < d.length; i += 4 * 97) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          const n = (s % 3) - 1;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
        }
        octx.putImageData(img, 0, 0);
        return off.toDataURL.apply(off, arguments);
      } catch (e) { return orig.apply(this, arguments); }
    };
  } catch(e){}
  // ★ 2026-10-30：WebRTC 会绕过代理直接报出本机/机房真实 IP（Google 登录页会探测），
  //   强制只收集「中继」候选，host/srflx 一律不产生 → 不泄露真实出口。
  try {
    const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (PC) {
      const Wrapped = function(cfg){
        const c = Object.assign({}, cfg || {});
        c.iceTransportPolicy = 'relay';
        const args = [c].concat(Array.prototype.slice.call(arguments, 1));
        return new (Function.prototype.bind.apply(PC, [null].concat(args)))();
      };
      Wrapped.prototype = PC.prototype;
      try { Object.setPrototypeOf(Wrapped, PC); } catch(e){}
      window.RTCPeerConnection = Wrapped;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
    }
  } catch(e){}
})();
`;
}

// ============ 出口代理（每账号独立出口 IP）============
// 读取顺序：CLI --proxy > 环境变量 LIGHTVELA_EGRESS_PROXY（与 domestic 同格式 JSON 对象或数组）
// 若给的是代理池（数组 / 多个），按账号邮箱做种子挑一个 → 同账号稳定、不同账号各异（真隔离）
// 单个旋转代理（如 a.rr2.kdns.fr）每次新建连接即换 IP，同样做到每账号独立出口。
function readProxyConfig() {
  let raw = (A.proxy || process.env.LIGHTVELA_EGRESS_PROXY || '');
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s[0] === '[' || s[0] === '{') {
      try { const j = JSON.parse(s); return Array.isArray(j) ? j : [j]; } catch (e) {}
    }
    // 允许用 | 分隔多个 URL
    return s.split('|').map(x => x.trim()).filter(Boolean);
  }
  return [raw];
}

function normalizeProxyForChromium(p) {
  // p: 字符串 URL（socks5h://user:pass@host:port / http://...）或 {type,host,port,username,password}
  // ★ 2026-10-30：用户名/密码里的裸 % 会让 decodeURIComponent 直接抛错，这里兜住
  const dec = s => { try { return decodeURIComponent(s || ''); } catch (e) { return s || ''; } };
  let server, username = '', password = '';
  if (typeof p === 'string') {
    let u;
    try { u = new URL(p); } catch (e) { return null; }
    const kind = (u.protocol || 'socks5:').replace(/:$/, '').replace(/^socks5h$/, 'socks5'); // Chromium 用 socks5 即远端解析 DNS
    if (!u.hostname || !u.port) return null;
    server = kind + '://' + u.hostname + ':' + u.port; // 凭据不放进 server，单独给 username/password（Playwright 规范）
    username = dec(u.username);
    password = dec(u.password);
  } else if (p && typeof p === 'object') {
    if (!p.host || !p.port) return null;   // ★ 原来的 /:\/$/ 校验永远不命中，等于没校验
    const kind = (p.type || 'socks5').replace(/^socks5h$/, 'socks5');
    server = (kind + '://' + p.host + ':' + p.port);
    username = p.username || '';
    password = p.password || '';
  } else {
    return null;
  }
  if (!server) return null;
  const out = { server };
  if (username) out.username = username;
  if (password) out.password = password;
  return out;
}

function pickProxy() {
  const list = readProxyConfig();
  if (!list.length) return null;
  const seed = xmur3('px|' + (EMAIL || 'x'))();
  const item = list[seed % list.length];
  return normalizeProxyForChromium(item);
}

// ============ 本地 SOCKS5 中继 ============
// 为什么必须中转：Chromium 的 SOCKS5 实现只做匿名握手，不支持用户名/密码认证，
//   带凭据直接配给 Playwright 会报 `Browser does not support socks5 proxy authentication`，
//   浏览器根本起不来（2026-10-30 实测：206 上 5 次登录全挂在这）。
// 链路：Chromium --无认证 socks5--> 127.0.0.1:随机端口（本中继）--带认证 socks5--> 上游旋转代理
// 域名按 ATYP=0x03 原样透传给上游解析 → 等于 socks5h 语义，本机不做 DNS，不泄露本机解析行为。
const RELAY_SOCKS = new Set();

// 一个「够用」的缓冲读：SOCKS5 握手是按字节段读的，普通 data 事件不一定按段到达
class SockBuf {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.err = null;
    this.ended = false;
    this.onData = d => { this.buf = Buffer.concat([this.buf, d]); this.flush(); };
    sock.on('data', this.onData);
    sock.on('error', e => { this.err = e; this.flush(); });
    sock.on('close', () => { this.ended = true; this.flush(); });
  }
  flush() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        this.waiters.shift();
        w.resolve(out);
        continue;
      }
      if (this.err) { this.waiters.shift(); w.reject(this.err); continue; }
      if (this.ended) { this.waiters.shift(); w.reject(new Error('连接提前关闭')); continue; }
      break;
    }
  }
  read(n) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this.flush();
    });
  }
  // 握手完成后把「已缓存但还没被读走的字节」交出来，并摘掉监听，后面直接走管道
  take() {
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    try { this.sock.removeListener('data', this.onData); } catch (e) {}
    try { this.sock.pause(); } catch (e) {}
    return rest;
  }
}

// 上游（带认证的 SOCKS5）握手：只提供「用户名密码」一种方法
function upstreamHandshake(up) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: up.host, port: up.port });
    RELAY_SOCKS.add(s);
    s.on('close', () => RELAY_SOCKS.delete(s));
    s.setTimeout(15000, () => { try { s.destroy(new Error('上游代理连接超时')); } catch (e) {} });
    s.once('error', reject);
    s.once('connect', async () => {
      try {
        s.setTimeout(0);
        const r = new SockBuf(s);
        const useAuth = !!(up.username || up.password);
        s.write(Buffer.from(useAuth ? [0x05, 0x01, 0x02] : [0x05, 0x01, 0x00]));
        const m = await r.read(2);
        if (m[0] !== 0x05) throw new Error('上游不是 SOCKS5 服务');
        if (m[1] === 0xff) throw new Error('上游不接受我方提供的认证方式');
        if (m[1] === 0x02) {
          if (!useAuth) throw new Error('上游要求认证，但没配账号密码');
          const u = Buffer.from(up.username || '', 'utf8');
          const p = Buffer.from(up.password || '', 'utf8');
          if (u.length > 255 || p.length > 255) throw new Error('代理账号或密码过长');
          s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const st = await r.read(2);
          if (st[1] !== 0x00) throw new Error('上游认证失败（账号或密码不对）');
        } else if (m[1] !== 0x00) {
          throw new Error('上游要求不支持的认证方式: ' + m[1]);
        }
        s.__reader = r;
        resolve(s);
      } catch (e) {
        try { s.destroy(); } catch (_) {}
        reject(e);
      }
    });
  });
}

async function handleRelayClient(sock, up) {
  const cr = new SockBuf(sock);
  // ① 客户端打招呼
  const g = await cr.read(2);
  if (g[0] !== 0x05) throw new Error('客户端不是 SOCKS5');
  const methods = await cr.read(g[1]);
  if (!methods.includes(0x00)) throw new Error('客户端不接受无认证方式');
  sock.write(Buffer.from([0x05, 0x00]));
  // ② 客户端请求
  const head = await cr.read(4);
  if (head[0] !== 0x05) throw new Error('请求版本不对');
  const cmd = head[1], atyp = head[3];
  if (cmd !== 0x01) { sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); throw new Error('只支持 CONNECT，收到命令 ' + cmd); }
  let addrBuf;
  if (atyp === 0x01) addrBuf = await cr.read(4);
  else if (atyp === 0x04) addrBuf = await cr.read(16);
  else if (atyp === 0x03) { const lb = await cr.read(1); addrBuf = Buffer.concat([lb, await cr.read(lb[0])]); }
  else { sock.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); throw new Error('不支持的地址类型 ' + atyp); }
  const portBuf = await cr.read(2);
  // ③ 连上游并转发请求（域名原样透传，让上游解析 DNS）
  const us = await upstreamHandshake(up);
  const ur = us.__reader;
  us.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addrBuf, portBuf]));
  const rp = await ur.read(4);
  if (rp[1] !== 0x00) {
    sock.write(Buffer.from([0x05, rp[1], 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    throw new Error('上游 CONNECT 失败，代码 ' + rp[1]);
  }
  if (rp[3] === 0x01) await ur.read(6);
  else if (rp[3] === 0x04) await ur.read(18);
  else { const lb = await ur.read(1); await ur.read(lb[0] + 2); }
  // ④ 告诉客户端成功，然后双向搬运
  sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  const restC = cr.take(), restU = ur.take();
  if (restC.length) us.write(restC);
  if (restU.length) sock.write(restU);
  sock.pipe(us);
  us.pipe(sock);
  us.on('close', () => { try { sock.destroy(); } catch (e) {} });
  sock.on('close', () => { try { us.destroy(); } catch (e) {} });
}

// 起中继：监听 127.0.0.1 的随机端口，返回 { port, close }
function startSocksRelay(up) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      RELAY_SOCKS.add(sock);
      sock.on('close', () => RELAY_SOCKS.delete(sock));
      sock.on('error', () => {});
      handleRelayClient(sock, up).catch(e => {
        log('中继: 一条连接失败 ->', (e && e.message) || e);
        try { sock.destroy(); } catch (_) {}
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(res => {
          for (const s of RELAY_SOCKS) { try { s.destroy(); } catch (e) {} }
          RELAY_SOCKS.clear();
          try { server.close(() => res()); } catch (e) { res(); }
          setTimeout(res, 800);
        })
      });
    });
  });
}

// 上游通不通，先探一下（TCP 层就够，认证错会在握手时报出来）
function tcpPing(host, port, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const fin = ok => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(ok); };
    const s = net.connect({ host, port });
    s.setTimeout(timeoutMs || 6000, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

// 浏览器启动参数（登录与自检共用，保证两边跑的是同一套）
const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  // ★ WebRTC 不许绕过代理走本机 UDP，否则真实 IP 照样漏出去
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--enforce-webrtc-ip-permission-check',
  // ★ 中继不支持 UDP，关掉 QUIC 免得一堆连接卡在 UDP 上超时
  '--disable-quic'
];

// 把「代理配置」翻译成「Playwright 能用的东西」：
//   带凭据的 socks5 → 起本地中继；无认证 socks5 / http → 直接给；上游不通 → 退回直连
async function resolveLaunchProxy() {
  const px = pickProxy();
  if (!px) {
    log('出口代理: 未配置（直连 VPS 公网 IP，可能被 Google 风控）');
    return { proxy: null, relay: null };
  }
  const kind = (px.server.split('://')[0] || '').toLowerCase();
  const hp = px.server.replace(/^[a-z0-9]+:\/\//i, '');
  const cut = hp.lastIndexOf(':');
  const upHost = hp.slice(0, cut), upPort = parseInt(hp.slice(cut + 1), 10);
  const needRelay = (kind === 'socks5' || kind === 'socks5h') && (px.username || px.password);
  if (!needRelay) {
    log('出口代理:', px.server, px.username ? '(带认证)' : '(无认证)');
    return { proxy: px, relay: null };
  }
  if (!(await tcpPing(upHost, upPort, 8000))) {
    log('⚠️ 上游代理连不上（' + upHost + ':' + upPort + '），本次退回直连（出口=机房 IP，可能被风控，但比直接失败强）');
    return { proxy: null, relay: null };
  }
  try {
    const relay = await startSocksRelay({ host: upHost, port: upPort, username: px.username, password: px.password });
    log('出口代理: 本地中继 127.0.0.1:' + relay.port + ' -> ' + upHost + ':' + upPort + '（上游带认证，Chromium 不支持 socks5 认证故中转）');
    return { proxy: { server: 'socks5://127.0.0.1:' + relay.port }, relay };
  } catch (e) {
    log('⚠️ 本地中继启动失败:', (e && e.message) || e, '→ 退回直连');
    return { proxy: null, relay: null };
  }
}

// ============ 自检：真起一次浏览器，验证代理链路 ============
// 用法：node lv_google_login.js --selftest=ip      打 ipify 看出口 IP
//       node lv_google_login.js --selftest=google  打开 Google 登录页，看能否拿到邮箱输入框
// 通过标准：① 浏览器成功启动（不再报 socks5 认证错）② ip 模式打印的 IP ≠ 本机公网 IP
//           ③ google 模式能看到 #identifierId（之前的两类失败就是「打不开」和「找不到输入框」）
if (String(A.selftest || '') !== '') {
  (async () => {
    const mode = String(A.selftest);
    const ST_TO = parseInt(A['st-timeout'] || '0', 10) || 90000;   // 自检超时，小内存机器可调大
    const out = { ok: false, mode, ip: null, proxy: 'direct', url: null, hasInput: null, error: null };
    let browser = null, relay = null;
    try {
      const plan = await resolveLaunchProxy();
      relay = plan.relay;
      const launchOpts = { headless: true, args: BROWSER_ARGS.slice() };
      if (plan.proxy) { launchOpts.proxy = plan.proxy; out.proxy = plan.proxy.server; }
      browser = await chromium.launch(launchOpts);
      const page = await browser.newPage();
      if (mode === 'google') {
        await page.goto('https://api.lightvela.ai/auth/oauth/google/start', { timeout: ST_TO, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
        out.url = page.url().slice(0, 160);
        out.hasInput = !!(await page.$('#identifierId, input[type=email], input[name=identifier]').catch(() => null));
        out.ok = out.hasInput;
        if (!out.ok) out.error = '打开成功但没找到邮箱输入框，最终 URL: ' + out.url;
      } else {
        await page.goto('https://api.ipify.org?format=json', { timeout: ST_TO, waitUntil: "domcontentloaded" });
        const t = (await page.textContent('body')) || '';
        try { out.ip = JSON.parse(t).ip; } catch (e) { out.ip = t.trim().slice(0, 60); }
        out.ok = !!out.ip;
      }
    } catch (e) {
      out.error = ((e && e.message) || String(e)).slice(0, 300);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (relay) { try { await relay.close(); } catch (e) {} }
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(out.ok ? 0 : 1);
  })();
}


if (!A.selftest) (async () => {
  const result = { ok: false, token: null, error: null };
  let browser = null;
  let relay = null;
  try {
    if (!EMAIL || !PASS) throw new Error('邮箱或密码为空');

    const fp = buildFingerprint(EMAIL);
    const verMatch = fp.ua.match(/Chrome\/([\d.]+)/);
    log('指纹画像:', fp.brand, fp.platform, '| Chrome', verMatch ? verMatch[1] : '?', '| tz', fp.tz, '| lang', fp.lang, '| 屏幕', fp.screenW + 'x' + fp.screenH, '| GPU', fp.gpu.webglVendor, '| random=' + fp.randomMode);
    const plan = await resolveLaunchProxy();
    relay = plan.relay;
    const launchOpts = { headless: true, args: BROWSER_ARGS.slice() };
    if (plan.proxy) launchOpts.proxy = plan.proxy;
    browser = await chromium.launch(launchOpts);
    const ctx = await browser.newContext({
      userAgent: fp.ua,
      viewport: { width: fp.screenW, height: fp.screenH },
      deviceScaleFactor: 1,
      locale: fp.lang,
      timezoneId: fp.tz,
      colorScheme: 'light',
      reducedMotion: 'no-preference'
    });
    await ctx.addInitScript(fpInitScript(fp));
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') log('CONSOLE-ERR:', m.text().slice(0, 140)); });

    log('打开 google/start 入口');
    // ★ 2026-10-30：206 这类 2 核小内存机实测单页要 200 秒上下，原 60 秒必然误判超时
    await page.goto('https://api.lightvela.ai/auth/oauth/google/start', { timeout: 240000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // 邮箱
    // 超时放宽到 60s：小内存机器上元素已进 DOM 但 CSS 未渲染完（尺寸为 0），
    // Playwright 的 visible 判定会一直不通过，原 25s 常被误判超时。
    await page.waitForSelector('#identifierId, input[type=email], input[name=identifier]', { timeout: 150000 });
    await tryFill(page, ['#identifierId', 'input[type=email]', 'input[name=identifier]'], EMAIL);
    await page.click('#identifierNext, button[type=submit], input[type=submit]').catch(() => {});
    await page.waitForTimeout(3000);
    log('邮箱后:', page.url().slice(0, 60));

    // 密码（先等密码框稳定，避免 #password 匹配到外层 div）
    await page.waitForSelector('input[type=password], input[name=Passwd]', { timeout: 120000 }).catch(() => {});
    await tryFill(page, ['input[type=password]', 'input[name=Passwd]', '#password input', '#password'], PASS);
    await page.click('#passwordNext, button[type=submit], input[type=submit]').catch(() => {});
    await page.waitForTimeout(4000);
    log('密码后:', page.url().slice(0, 60));

    // 中间页循环：谷歌域内（服务条款/辅助邮箱等）+ LightVela 授权确认页
    let landed = false;
    for (let i = 0; i < 30; i++) {
      let m = extractToken(page);
      if (m) { result.ok = true; result.token = m; log('✅ 命中 session_token(URL)'); break; }

      const u = page.url();
      if (u.includes('lightvela.ai') && !u.includes('accounts.google.com') && !u.includes('signin/oauth') && !u.includes('oauth/consent')) {
        // 也许 token 在 cookie（lc_session）
        const cookies = await ctx.cookies();
        const lc = cookies.find(c => c.name === 'lc_session' && c.value);
        if (lc) { result.ok = true; result.token = lc.value; log('✅ 命中 lc_session cookie'); break; }
        landed = true; log('已落地（无token）:', u.slice(0, 60)); break;
      }
      // ★ 2026-10-31 新增：命中谷歌两步验证（TOTP）页 → 现算 6 位码填进去并点 Next
      if (await handleTotpPage(page)) {
        await page.waitForTimeout(1500);
        continue;
      }
      if (u.includes('accounts.google.com')) {
        await tryFill(page, ['input[name=recoveryIdentifier]', '#identifierId', 'input[type=email]', 'input[name=identifier]'], RECOVERY);
        await clickConfirm(page);
      } else if (u.includes('signin/oauth') || u.includes('oauth/id') || u.includes('oauth/consent')) {
        await clickConfirm(page);
      } else {
        await clickConfirm(page);
      }
      await page.waitForTimeout(2500);
    }

    if (!result.ok && !landed) {
      // 兜底再查一次 cookie / URL
      let m = extractToken(page);
      if (m) { result.ok = true; result.token = m; }
      else {
        const cookies = await ctx.cookies();
        const lc = cookies.find(c => c.name === 'lc_session' && c.value);
        if (lc) { result.ok = true; result.token = lc.value; }
      }
      if (!result.ok) result.error = '登录未完成，最终 URL: ' + page.url().slice(0, 140);
    }
  } catch (e) {
    result.error = (e && e.message ? e.message : String(e)).slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (relay) { try { await relay.close(); } catch (e) {} }
  }

  process.stdout.write(JSON.stringify(result));
})();
