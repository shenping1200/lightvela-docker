'use strict';
// 国内版 LightVela 批量调度器：5 并发跑 80 个账号。
// 每个账号起一个独立 node 子进程（domestic_lightvela_bot.js --account-idx N），
// 内存完全隔离，避免 CFG 全局单例被并发污染。
//
// 子进程日志：run_acct_<NN>_<姓名>.log
// 汇总结果：  batch_summary_<时间戳>.json
// 调度器日志：运行本文件时自行重定向（如 > batch_run_<时间戳>.log 2>&1）

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 账号清单：默认 ./accounts.js；可用 LIGHTVELA_ACCOUNTS_FILE 指定别的清单（如补跑用 accounts_retry.js）。
// bot.js 子进程读同一个环境变量，两边保持一致。
const ACCOUNTS = require(process.env.LIGHTVELA_ACCOUNTS_FILE || './accounts.js');

// managed node（与国际版一致，避免环境差异）
const NODE = 'C:\\Users\\Administrator\\.workbuddy-ai\\binaries\\node\\versions\\22.22.2-2\\node.exe';
const BOT = path.join(__dirname, 'domestic_lightvela_bot.js');

const CONCURRENCY = 5;                       // 老大要求：5 并发
const PER_ACCT_TIMEOUT_MS = 40 * 60 * 1000; // 单账号 40 分钟硬超时（部署最慢约 29 分钟，留足余量）

// ★ 读面板「部署策略」配置（domestic-config.json），转成子进程环境变量。
//   查找顺序：LV_DATA_DIR → LIGHTVELA_DOMESTIC_TOKENS 所在目录 → 本脚本所在目录。
//   面板上改完开关，下次起批量就生效；读不到就用 bot.js 内置默认值（验证开/重试2次/180秒）。
function deployEnvFromConfig() {
  const env = {};
  const candidates = [];
  if (process.env.LV_DATA_DIR) candidates.push(path.join(process.env.LV_DATA_DIR, 'domestic-config.json'));
  if (process.env.LIGHTVELA_DOMESTIC_TOKENS) {
    const tokDir = path.dirname(process.env.LIGHTVELA_DOMESTIC_TOKENS.replace(/\.ndjson$/, '').replace(/\.json$/, ''));
    candidates.push(path.join(tokDir, 'domestic-config.json'));
  }
  candidates.push(path.join(__dirname, 'domestic-config.json'));
  let p = null;
  for (const c of candidates) { if (fs.existsSync(c)) { p = c; break; } }
  if (!p) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const d = cfg && cfg.deploy;
    if (!d) return env;
    if ('verify' in d) env.LIGHTVELA_VERIFY = d.verify ? '1' : '0';
    if (d.retry != null) env.LIGHTVELA_DEPLOY_RETRY = String(Number(d.retry) || 0);
    if (d.smsTimeoutSec) env.LIGHTVELA_SMS_CODE_TIMEOUT_MS = String(Number(d.smsTimeoutSec) * 1000);
    if (d.smsMaxRent) env.LIGHTVELA_SMS_MAX_RENT = String(Number(d.smsMaxRent) || 3);
    console.log('[批量] 已读面板部署策略: ' + p + ' → ' + JSON.stringify(d));
  } catch (e) {
    console.warn('[批量] 读取面板部署策略失败，用默认值:', e.message);
  }
  return env;
}

const DEPLOY_ENV = deployEnvFromConfig();   // 批量启动时读一次面板配置，全程透传给每个账号子进程

function runOne(idx, acc) {
  return new Promise((resolve) => {
    const logName = `run_acct_${String(idx).padStart(2, '0')}_${acc.name}.log`;
    const logPath = path.join(__dirname, logName);
    let fd;
    try { fd = fs.openSync(logPath, 'w'); }
    catch (e) { resolve({ idx, name: acc.name, idCard: acc.idCard, code: 'LOGERR:' + e.message, log: logName }); return; }

    const child = spawn(NODE, [BOT, '--account-idx', String(idx)], {
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, DEPLOY_ENV),
    });

    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch (x) {}
      resolve({ idx, name: acc.name, idCard: acc.idCard, code, log: logName });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      finish('TIMEOUT');
    }, PER_ACCT_TIMEOUT_MS);

    child.on('error', (e) => finish('ERR:' + e.message));
    child.on('close', (code) => finish(code === 0 ? 'OK' : ('FAIL:' + code)));
  });
}

async function runBatch() {
  const total = ACCOUNTS.length;
  const startedAt = Date.now();
  console.log(`[批量] 共 ${total} 个账号 | 并发 ${CONCURRENCY} | 单账号超时 ${PER_ACCT_TIMEOUT_MS / 60000} 分钟`);
  console.log(`[批量] 开始时间 ${new Date(startedAt).toLocaleString()}`);

  const all = [];
  for (let i = 0; i < total; i += CONCURRENCY) {
    const batchNo = Math.floor(i / CONCURRENCY) + 1;
    const slice = [];
    for (let k = 0; k < CONCURRENCY && i + k < total; k++) {
      slice.push(runOne(i + k, ACCOUNTS[i + k]));
    }
    console.log(`[批量] >>> 第 ${batchNo} 批启动：账号 ${i + 1}~${i + slice.length}`);
    const batchResults = await Promise.all(slice);
    all.push(...batchResults);

    const ok = batchResults.filter((r) => r.code === 'OK').length;
    const fail = batchResults.length - ok;
    console.log(`[批量] <<< 第 ${batchNo} 批完成：本批 成功 ${ok} / 失败 ${fail} | 累计成功 ${all.filter((r) => r.code === 'OK').length}/${all.length}`);
  }

  const okCount = all.filter((r) => r.code === 'OK').length;
  const failCount = all.length - okCount;
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n[批量] 全部结束：成功 ${okCount} / 失败 ${failCount} / 共 ${all.length} | 耗时 ${elapsedMin} 分钟`);

  const summaryPath = path.join(__dirname, 'batch_summary_' + startedAt + '.json');
  fs.writeFileSync(summaryPath, JSON.stringify(all, null, 2));
  console.log(`[批量] 汇总已写：${path.basename(summaryPath)}`);

  // 列出失败账号，方便后续重试
  const failed = all.filter((r) => r.code !== 'OK');
  if (failed.length) {
    console.log('[批量] 失败/超时账号列表：');
    for (const f of failed) console.log(`   - #${f.idx} ${f.name} (${f.idCard}) -> ${f.code} [${f.log}]`);
  }
}

runBatch().catch((e) => { console.error('BATCH FATAL:', e.message); process.exit(1); });
