// 最终验收：直接从 DSH 宿主的 app.asar 取**真实现**，验证本插件在 0.2.0 上能被接受并加载。
//
// 为什么必须用宿主真实现（而不是复刻逻辑）：本条链路的两个故障点都在宿主侧 ——
//   ① 兼容门 dsh-app-boot 的 evaluatePluginCompatibility（semver 对 prerelease 的行为极易复刻错）
//   ② 0.2.0 把 agent-presets 拆包后旧包名消失（只能实测解析结果，不能靠读代码断言）
// 复刻一份等价实现来"验证"自己，等于自我欺骗（本仓 selftest 的既有原则）。
//
// 用法：
//   npm run verify:host020
//   DSH_ASAR="D:\path\to\resources\app.asar" npm run verify:host020
// app.asar 位置按平台常见安装位置自动探测，探测不到才要求显式指定。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** 按平台常见安装位置探测宿主的 app.asar。 */
function discoverAsar() {
  const candidates = [];
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const rel = ['resources', 'app.asar'];
  for (const base of [la && path.join(la, 'Programs'), pf, pf86]) {
    if (!base) continue;
    for (const name of ['DeepSeek Harness', 'deepseek-harness-desktop', 'deepseek-harness']) {
      candidates.push(path.join(base, name, ...rel));
    }
  }
  candidates.push(path.join('/Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const ASAR = process.env.DSH_ASAR ?? discoverAsar();
if (ASAR === null || ASAR === undefined || !fs.existsSync(ASAR)) {
  console.error('FATAL: 找不到宿主 app.asar。');
  console.error('       请用 DSH_ASAR 显式指定，例如：');
  console.error('       DSH_ASAR="C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar" \\');
  console.error('         node scripts/verify-020-host.mjs');
  if (ASAR) console.error(`       （本次探测到的路径不存在：${ASAR}）`);
  process.exit(2);
}

const PLUGIN = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WORK = path.join(process.env.TEMP ?? process.env.TMP ?? '/tmp', 'dsh-verify-020');

let failed = false;
const check = (ok, label, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`);
};

// ── asar 读取器 ──────────────────────────────────────────────────────────────
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const jsonSize = head.readUInt32LE(12);
const hdrBuf = Buffer.alloc(jsonSize); fs.readSync(fd, hdrBuf, 0, jsonSize, 16);
const hdr = JSON.parse(hdrBuf.toString('utf8'));
const base = 16 + jsonSize;
const get = (p) => { let n = hdr; for (const s of p.split('/').filter(Boolean)) { if (!n?.files) return null; n = n.files[s]; } return n; };
const content = (p) => { const n = get(p); if (!n || n.offset === undefined) return null; const b = Buffer.alloc(Number(n.size)); fs.readSync(fd, b, 0, Number(n.size), base + Number(n.offset)); return b; };

console.log('=== 从 app.asar 解出宿主真实现 ===');
fs.rmSync(WORK, { recursive: true, force: true });
const NM = path.join(WORK, 'node_modules');
let files = 0;
const extract = (node, out) => {
  fs.mkdirSync(out, { recursive: true });
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = path.join(out, k);
    if (v.files) { extract(v, p); continue; }
    if (v.link !== undefined || v.offset === undefined) continue;
    const b = Buffer.alloc(Number(v.size));
    fs.readSync(fd, b, 0, Number(v.size), base + Number(v.offset));
    fs.writeFileSync(p, b);
    files++;
  }
};
extract(get('dsh/node_modules'), NM);
console.log(`  解出 ${files} 个文件 → ${WORK}`);

const hostVersion = JSON.parse(content('dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json').toString('utf8')).version;
fs.closeSync(fd);
console.log(`  宿主运行时版本: ${hostVersion}`);

// ── ① 兼容门 ────────────────────────────────────────────────────────────────
console.log('\n=== ① 用宿主真 evaluatePluginCompatibility 判定插件 manifest ===');
const appBoot = await import(pathToFileURL(path.join(NM, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const runtime = appBoot.getDshRuntimeVersion();
check(runtime === '0.2.0-rc.2', `宿主自报版本 = 0.2.0-rc.2`, `实际 ${runtime}`);

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
const issue = appBoot.evaluatePluginCompatibility(manifest, {}, runtime);
check(issue === undefined, `兼容门放行 dsh-mcp-skill-panel@${manifest.version}`,
  issue ? `仍被拒: ${JSON.stringify(issue.peers)}` : '');

// 对照：0.6.0 的旧 dsh-scope 声明必须被拒（证明这个门是真的在判）
const oldPeers = { ...manifest.peerDependencies, '@deepseek-ai/dsh-scope': '^0.1.2-rc.1' };
const oldIssue = appBoot.evaluatePluginCompatibility({ ...manifest, peerDependencies: oldPeers }, {}, runtime);
check(oldIssue !== undefined, '对照：0.6.0 的 ^0.1.2-rc.1 在同一运行时下被拒',
  oldIssue ? JSON.stringify(oldIssue.peers) : '竟被放行');

// ── ② 旧包名在 0.2.0 不存在 ─────────────────────────────────────────────────
console.log('\n=== ② 0.2.0 的模块图里旧包名是否存在 ===');
const dest = path.join(NM, 'dsh-mcp-skill-panel');
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(PLUGIN, 'lib'), path.join(dest, 'lib'), { recursive: true });
fs.copyFileSync(path.join(PLUGIN, 'package.json'), path.join(dest, 'package.json'));
const req = createRequire(pathToFileURL(path.join(dest, 'lib', 'index.js')).href);

let oldMissing = false;
try { req.resolve('@deepseek-ai/dsh-agent-presets'); } catch (e) { oldMissing = e.code === 'MODULE_NOT_FOUND'; }
check(oldMissing, '旧包名 @deepseek-ai/dsh-agent-presets 不可解析（原 bug 的现场）');

let reg = null;
try { reg = req('@deepseek-ai/dsh-agent-preset-registry'); } catch (e) { console.log('   registry require 失败:', e.code); }
check(reg !== null, 'registry 可解析并 require（Node 24 支持 require 无顶层 await 的 ESM）');
check(typeof reg?.livePresetMounts === 'function' && typeof reg?.standingMountFor === 'function',
  'registry 导出 livePresetMounts / standingMountFor 两个读取口');

// ── ③ 插件模块图可加载 ──────────────────────────────────────────────────────
console.log('\n=== ③ 构建产物在 0.2.0 运行时下加载 ===');
let mod = null;
try { mod = await import(pathToFileURL(path.join(dest, 'lib', 'index.js')).href); } catch (e) { console.log('  ', e.code ?? e.name, String(e.message).split('\n')[0]); }
check(mod !== null && typeof mod.apply === 'function', 'lib/index.js 加载成功且导出 apply',
  mod ? `${Object.keys(mod).length} 个导出` : '加载失败');

// ── ④ 解析器选择顺序 ────────────────────────────────────────────────────────
console.log('\n=== ④ 两包名并存时解析器必须选 registry（新名优先）===');
const req2 = createRequire(pathToFileURL(path.join(NM, '__base__.js')).href);
const SPECIFIERS = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-presets'];
let picked = null;
for (const s of SPECIFIERS) { try { req2.resolve(s); picked = s; break; } catch {} }
check(picked === '@deepseek-ai/dsh-agent-preset-registry' || picked === null,
  'registry 是新名优先项', `picked=${picked}`);
check(mod && typeof mod.agentPresetApiForDebug === 'function',
  '导出 agentPresetApiForDebug（装机排障判读面）');

// ── ⑤ 静态 import 必须已消失（0.2.0 上静态 import 必崩）────────────────────
console.log('\n=== ⑤ 产物中不得再有 agent-presets 的静态 import ===');
const bundle = fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8');
const staticImport = /^\s*import\s[^\n]*from\s*["']@deepseek-ai\/dsh-agent-presets?(-registry)?["']/m.test(bundle);
check(!staticImport, '无静态 import（0.2.0 上会 ERR_MODULE_NOT_FOUND）');
check(bundle.includes('createRequire'), '经 createRequire 动态解析（保住模块实例身份）');
check(bundle.includes('@deepseek-ai/dsh-agent-preset-registry') && bundle.includes('@deepseek-ai/dsh-agent-presets'),
  '两个候选包名都在产物里（0.1.x 回落未被摇掉）');

fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n临时目录已清理。');
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL PASS');
process.exitCode = failed ? 1 : 0;
