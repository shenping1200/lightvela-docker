'use strict';
// 国内版批量账号清单模板（真实 accounts.js 已被 .gitignore 排除，不提交到仓库）。
// 每个人一套：姓名 + 身份证（尾号 X 必须大写）；顺序即并发批次内的顺序。
//
// 用法三选一：
//   1) 复制本文件为 accounts.js，填入真实数据；
//   2) 用环境变量指定别的清单：LIGHTVELA_ACCOUNTS_FILE=./accounts_retry.js node domestic_lightvela_batch.js
//   3) 单账号跑：node domestic_lightvela_bot.js --name 张三 --idcard 110101199001011234
module.exports = [
  { name: '示例张三', idCard: '110101199001011234' },
  { name: '示例李四', idCard: '310101199002022345' },
  { name: '示例王五', idCard: '440101199003033456' },
  // … 继续按同样格式追加，每行一个 { name, idCard }
];
