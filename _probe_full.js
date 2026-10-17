'use strict';
// 精准测活：对账本里 41 个凭证账号，逐个
//   1) GET /v1/instances 拿实例列表
//   2) POST /v1/instances/{id}/debug/exec 跑 shell，查实例里 yufu-agent 探针是否真在跑
// 判定"部署有效"的唯一标准：探针进程/service 实际存活，而不是我们自己的回复判定。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeProxy, makeHttpsAgent } = require('./lv-proxy');

const AGENT = makeHttpsAgent(normalizeProxy({
  type: 'socks5', host: 'a.rr2.kdns.fr', port: 10800, username: '6582443', password: '6582443',
}));

// 凭证（合并）
const lines = fs.readFileSync(path.join(__dirname, '..', 'domestic-tokens.ndjson'), 'utf8').split('\n').filter(Boolean);
const byId = {};
for (const l of lines) { try { const o = JSON.parse(l); byId[o.idCard] = Object.assign(byId[o.idCard] || {}, o); } catch (e) {} }
const accts = Object.values(byId).filter((o) => o.bearer);
console.log('凭证账号数:', accts.length);

const PROBE_CMD = [
  "echo '==PS=='; ps aux | grep -i 'yu''fu' | grep -v grep | awk '{print $11, $12, $13}' | head -3",
  "echo '==SVC=='; systemctl is-active 'yu''fu-agent' 2>&1 | head -1",
  "echo '==CONF=='; (ls -la /etc/'yu''fu-agent.conf' 2>&1 | head -1)",
].join('; ');
// ⚠️ 查询命令含 'yufu' 字样时，执行命令的 sh 进程会出现在 ps 里造成误报；
//    用 'yu''fu' 引号拼接让 shell 进程 cmdline 不含连续 "yufu"，排除自匹配。

function api(method, p, bearer, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'User-Agent': 'Mozilla/5.0 LightVelaPureCode', 'Accept': 'application/json', 'Authorization': 'Bearer ' + bearer };
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

function judge(out) {
  const svc = (out.match(/==SVC==\s*\n?\s*(\S+)/) || [])[1] || '';
  const ps = /==PS==[\s\S]*?yufu/i.test(out);
  if (/^active$/i.test(svc)) return '探针运行中(systemd active)';
  if (ps) return '探针进程在跑(ps可见)';
  if (/inactive|failed|not-found|unknown/i.test(svc)) return '探针未运行(' + svc + ')';
  return '查不到探针(' + (svc || '无输出') + ')';
}

(async () => {
  const rows = [];
  let idx = 0;
  async function worker() {
    while (idx < accts.length) {
      const a = accts[idx++];
      try {
        const r = await api('GET', '/v1/instances', a.bearer);
        const d = r.json && r.json.data !== undefined ? r.json.data : r.json;
        const items = Array.isArray(d) ? d : (d && (d.items || d.instances)) || [];
        if (!items.length) { rows.push({ name: a.name, inst: '(无)', status: '-', probe: '无实例' }); continue; }
        for (const it of items) {
          const iid = it.instance_id || it.id;
          let probe = '(未查)';
          try {
            const ex = await api('POST', '/v1/instances/' + iid + '/debug/exec', a.bearer, { command: PROBE_CMD, run_as_user: 'agentuser', execution_backend: 'tat' });
            const out = (ex.json && ex.json.data && ex.json.data.output) || ex.text || '';
            probe = judge(out);
          } catch (e) { probe = 'exec失败:' + String(e.message).slice(0, 40); }
          rows.push({ name: a.name, inst: iid, status: String(it.status || '?'), created: (it.created_at || '').slice(11, 19) + 'Z', probe });
        }
      } catch (e) { rows.push({ name: a.name, inst: '?', status: '查询失败', probe: String(e.message).slice(0, 40) }); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);

  console.log('\n当前UTC:', new Date().toISOString());
  console.log('\n==== 41 个凭证账号逐一实测 ====');
  for (const r of rows) console.log(`${r.name}\t${r.inst}\t${r.status}\t建:${r.created || '-'}\t${r.probe}`);
  const noInst = rows.filter((r) => r.inst === '(无)');
  const probeRun = rows.filter((r) => /运行中|在跑/.test(r.probe));
  const probeDead = rows.filter((r) => r.inst !== '(无)' && !/运行中|在跑/.test(r.probe));
  console.log('\n==== 汇总 ====');
  console.log('无实例的凭证账号:', noInst.length, noInst.map((r) => r.name).join(' ') || '(无)');
  console.log('有实例且探针真在跑:', probeRun.length);
  console.log('有实例但探针没跑(' + probeDead.length + '):', probeDead.map((r) => r.name + '[' + r.probe + ']').join(' '));
})();
