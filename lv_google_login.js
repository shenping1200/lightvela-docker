// LightVela 谷歌授权登录（无头浏览器版）
// 用法：node lv_google_login.js --email=... --password=... [--recovery=...]
// 输出（仅 stdout，单行 JSON）：{"ok":true,"token":"..."} 或 {"ok":false,"error":"..."}
// 日志全部走 stderr，避免污染 stdout 的 JSON。
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');

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
const OS_POOL = [
  { brand: 'Windows', platform: 'Win32', uaSuffix: 'Windows NT 10.0; Win64; x64', screen: [[1920, 1080], [1536, 864], [1366, 768], [2560, 1440]] },
  { brand: 'macOS', platform: 'MacIntel', uaSuffix: 'Macintosh; Intel Mac OS X 10_15_7', screen: [[1440, 900], [1680, 1050], [2560, 1440], [1280, 800]] },
  { brand: 'Linux', platform: 'Linux x86_64', uaSuffix: 'X11; Linux x86_64', screen: [[1920, 1080], [1536, 864], [1366, 768], [1600, 900]] }
];
const TZ_POOL = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver', 'Europe/London', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo'];
const LANG_POOL = ['en-US', 'en-US', 'en-US', 'en-GB', 'en-CA'];
const GPU_POOL = [
  { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon(TM) RX 5600 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { webglVendor: 'Google Inc.', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];
const HW_CONCURRENCY = [4, 8, 8, 12, 16];
const DEVICE_MEMORY = [4, 8, 8, 16];

function buildFingerprint(email) {
  const randomMode = process.env.LV_FP_RANDOM === '1';
  const seedStr = randomMode ? ('fp|' + email + '|' + Date.now() + '|' + Math.random()) : ('fp:' + email);
  const seedNum = xmur3(seedStr)();
  const rand = mulberry32(seedNum);
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  const ver = pick(CHROME_VERSIONS);
  const os = pick(OS_POOL);
  const scr = pick(os.screen);
  const tz = pick(TZ_POOL);
  const lang = pick(LANG_POOL);
  const gpu = pick(GPU_POOL);
  const hw = pick(HW_CONCURRENCY);
  const dm = pick(DEVICE_MEMORY);
  const ua = 'Mozilla/5.0 (' + os.uaSuffix + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
  const appVersion = '5.0 (' + os.uaSuffix + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';

  return {
    ua, appVersion, platform: os.platform, brand: os.brand,
    screenW: scr[0], screenH: scr[1],
    tz, lang, langs: [lang, 'en'],
    gpu, hw, dm, seed: seedNum, randomMode
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
})();
`;
}

(async () => {
  const result = { ok: false, token: null, error: null };
  let browser = null;
  try {
    if (!EMAIL || !PASS) throw new Error('邮箱或密码为空');

    const fp = buildFingerprint(EMAIL);
    const verMatch = fp.ua.match(/Chrome\/([\d.]+)/);
    log('指纹画像:', fp.brand, fp.platform, '| Chrome', verMatch ? verMatch[1] : '?', '| tz', fp.tz, '| lang', fp.lang, '| 屏幕', fp.screenW + 'x' + fp.screenH, '| GPU', fp.gpu.webglVendor, '| random=' + fp.randomMode);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });
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
    await page.goto('https://api.lightvela.ai/auth/oauth/google/start', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // 邮箱
    // 超时放宽到 60s：小内存机器上元素已进 DOM 但 CSS 未渲染完（尺寸为 0），
    // Playwright 的 visible 判定会一直不通过，原 25s 常被误判超时。
    await page.waitForSelector('#identifierId, input[type=email], input[name=identifier]', { timeout: 60000 });
    await tryFill(page, ['#identifierId', 'input[type=email]', 'input[name=identifier]'], EMAIL);
    await page.click('#identifierNext, button[type=submit], input[type=submit]').catch(() => {});
    await page.waitForTimeout(3000);
    log('邮箱后:', page.url().slice(0, 60));

    // 密码（先等密码框稳定，避免 #password 匹配到外层 div）
    await page.waitForSelector('input[type=password], input[name=Passwd]', { timeout: 45000 }).catch(() => {});
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
  }

  process.stdout.write(JSON.stringify(result));
})();
