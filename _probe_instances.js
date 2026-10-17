'use strict';
// 测活探针：用凭证账本里的 Bearer 逐个查 GET /v1/instances，
// 对比每台实例的 status / created_at / timeout_at 与当前时间，验证"实例是否真会过期"。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeProxy, makeHttpsAgent } = require('./lv-proxy');

const AGENT = makeHttpsAgent(normalizeProxy({
  type: 'socks5', host: 'a.rr2.kdns.fr', port: 10800, username: '6582443', password: '6582443',
}));

// 读凭证（合并后写覆盖先写）
const lines = fs.readFileSync(path.join(__dirname, '..', 'domestic-tokens.ndjson'), 'utf8').split('\n').filter(Boolean);
const byId = {};
for (const l of lines) { try { const o = JSON.parse(l); byId[o.idCard] = Object.assign(byId[o.idCard] || {}, o); } catch (e) {} }
const accts = Object.values(byId).filter((o) => o.bearer && o.instanceId);
console.log('待查账号数(有bearer且有实例记录的):', accts.length);

function req(bearer) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      method: 'GET', hostname: 'api.lightvela.com', path: '/v1/instances',
      headers: { 'User-Agent': 'Mozilla/5.0 LightVelaPureCode', 'Accept': 'application/json', 'Authorization': 'Bearer ' + bearer },
      agent: AGENT,
    }, (res) => {
      let c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

(async () => {
  const now = Date.now();
  let totalInst = 0, alive = 0, expiredButShown = 0, other = 0;
  const rows = [];
  for (const a of accts) {
    try {
      const r = await req(a.bearer);
      const d = r.json && r.json.data !== undefined ? r.json.data : r.json;
      const items = Array.isArray(d) ? d : (d && (d.items || d.instances)) || [];
      for (const it of items) {
        totalInst++;
        const st = String(it.status || '?');
        const ta = it.timeout_at ? Date.parse(it.timeout_at) : 0;
        const past = ta && ta < now;
        if (/running|active/i.test(st)) { alive++; if (past) expiredButShown++; }
        else other++;
        rows.push({ name: a.name, inst: it.instance_id || it.id, status: st, created: (it.created_at || '').replace('T', ' ').replace(/\..*Z/, 'Z'), timeout_at: (it.timeout_at || '').replace('T', ' ').replace(/\..*Z/, 'Z'), pastExpiry: past });
      }
    } catch (e) {
      rows.push({ name: a.name, inst: '-', status: '查询失败: ' + e.message });
    }
  }
  console.log('\n当前时间(UTC):', new Date(now).toISOString());
  console.log('\n==== 汇总 ====');
  console.log('40个账号查到的实例总数:', totalInst);
  console.log('其中状态 Running/active:', alive);
  console.log('★已过 timeout_at 却仍显示 Running/active 的:', expiredButShown);
  console.log('其他状态:', other);
  console.log('\n==== 明细 ====');
  for (const r of rows) console.log(`${r.name}\t${r.inst}\t${r.status}\t建:${r.created}\t到期:${r.timeout_at}\t已过期:${r.pastExpiry}`);
})();
