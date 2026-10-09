// 反向验证：护栏能否抓住「只挂旧事件名」这个事故形态。
import fs from 'node:fs';

const t = fs.readFileSync('lib/index.js', 'utf8');
const listened = [...new Set([...t.matchAll(/\.on\(\s*["']((?:agent|session|workspace)\/[a-z-]+)["']/g)].map((m) => m[1]))];
// 宿主 0.2.0 实际会发出的事件集（取自 app.asar 全量扫描结果）
const emits = new Set([
  'agent/created', 'agent/disposed',
  'session/created', 'session/disposed', 'session/event', 'session/flush',
  'workspace/session-activity', 'workspace/session-stop',
]);

console.log('当前产物监听的会话边界事件: ' + listened.join(', '));
const live = listened.filter((e) => emits.has(e));
console.log('在 0.2.0 事件集下 live = ' + (live.join(', ') || '(空)'));

console.log('\n--- 反向验证 ---');
const buggy = ['agent/session-start']; // 修复前的形态
const liveBuggy = buggy.filter((e) => emits.has(e));
console.log(`修复前只挂 [${buggy.join(', ')}] → live = ${liveBuggy.length ? liveBuggy.join(', ') : '(空)'}`);
console.log(liveBuggy.length === 0 ? '✅ 护栏会 FAIL（能抓住这个事故）' : '❌ 护栏抓不住');
console.log(live.length > 0 ? '✅ 修复后 live 非空 → 护栏 PASS' : '❌ 修复后仍然全死');
process.exitCode = live.length > 0 && liveBuggy.length === 0 ? 0 : 1;
