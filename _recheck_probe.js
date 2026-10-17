'use strict';
// 复查：于泓洋/杨硕/陈哲莹 三台"系统服务没注册但疑似有进程"的实例。
// 关键修正：查询命令本身含 "yufu" 字样时，执行命令的 sh 进程会出现在 ps 里造成误报，
// 用 'yu''fu' 引号拼接技巧让 shell 进程的 cmdline 不含连续 "yufu"，排除自匹配。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeProxy, makeHttpsAgent } = require('./lv-proxy');

const AGENT = makeHttpsAgent(normalizeProxy({
  type: 'socks5', host: 'a.rr2.kdns.fr', port: 10800, username: '6582443', password: '6582443',
}));
const lines = fs.readFileSync(path.join(__dirname, '..', 'domestic-tokens.ndjson'), 'utf8').split('\n').filter(Boolean);
const byId = {};
for (const l of lines) { try { const o = JSON.parse(l); byId[o.idCard] = Object.assign(byId[o.idCard] || {}, o); } catch (e) {} }

const NAMES = ['于泓洋', '杨硕', '陈哲莹', '张璐']; // 张璐作阳性对照
const CMD = [
  "echo '==SVC=='; systemctl is-active 'yu''fu-agent' 2>&1 | head -1",
  "echo '==PS=='; ps aux | grep -i 'yu''fu' | grep -v grep | head -5",
  "echo '==CONF=='; ls -la /etc/'yu''fu-agent.conf' 2>&1 | head -1",
  "echo '==BIN=='; ls -la /usr/local/bin/'yu''fu-agent' 2>&1 | head -1",
  "echo '==PORT=='; (ss -tnp 2>/dev/null | grep -i 'yu''fu' | head -3) || true",
].join('; ');

function api(method, p, bearer, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Authorization': 'Bearer ' + bearer };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ method, hostname: 'api.lightvela.com', path: p, headers: h, agent: AGENT }, (res) => {
      let c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json: j, text: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  for (const name of NAMES) {
    const a = Object.values(byId).find((o) => o.name === name);
    if (!a || !a.instanceId) { console.log(name, ': 无凭证/无实例记录'); continue; }
    console.log('\n======== ' + name + ' (' + a.instanceId + ') ========');
    try {
      const ex = await api('POST', '/v1/instances/' + a.instanceId + '/debug/exec', a.bearer, { command: CMD, run_as_user: 'agentuser', execution_backend: 'tat' });
      const out = (ex.json && ex.json.data && ex.json.data.output) || ex.text || '';
      console.log(out.slice(0, 1200));
    } catch (e) { console.log('exec失败:', e.message); }
  }
})();
