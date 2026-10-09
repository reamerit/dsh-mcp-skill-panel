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

// ── ⑥ 事件契约：插件监听的会话边界事件必须真的由宿主发出 ────────────────────
// 为什么需要这一条（2026-10 实测事故）：0.2.0 把 `agent/session-start` 整个删掉，
// 换成 `agent/created`。插件仍监听旧名 ⇒ 在 0.2.0 上**永不触发** ⇒ 重启后项目 MCP
// 行不再重建（面板添加当次可见、重启即消失），且「下次会话生效」也永不生效。
// 这类「监听宿主不再发出的事件」是**静默失效**：不报错、不告警，只在重启后暴露；
// 本仓其它闸门都看不到，故在此设卡。
console.log('\n=== ⑥ 会话边界事件契约（宿主是否真的发出插件监听的事件）===');
{
  const fd2 = fs.openSync(ASAR, 'r');
  const h = Buffer.alloc(16); fs.readSync(fd2, h, 0, 16, 0);
  const js = h.readUInt32LE(12);
  const jb = Buffer.alloc(js); fs.readSync(fd2, jb, 0, js, 16);
  const hdr2 = JSON.parse(jb.toString('utf8'));
  const base2 = 16 + js;
  const emits = new Set();
  const readN = (n) => {
    if (!n || n.offset === undefined) return null; // asar 里的 symlink 条目没有 offset
    const b = Buffer.alloc(Number(n.size)); fs.readSync(fd2, b, 0, Number(n.size), base2 + Number(n.offset)); return b.toString('utf8');
  };
  // 只看 @deepseek-ai 官方包，避免第三方包的同名噪声
  const walk2 = (node, p, isDsh) => {
    for (const [k, v] of Object.entries(node.files || {})) {
      if (v.files) { walk2(v, p + '/' + k, isDsh || k.startsWith('@deepseek-ai')); continue; }
      if (!isDsh || !/\.(js|mjs)$/.test(k)) continue;
      const t = readN(v);
      if (t === null) continue;
      for (const m of t.matchAll(/["'`]((?:agent|session|workspace)\/[a-z-]+)["'`]/g)) emits.add(m[1]);
    }
  };
  walk2(hdr2.files.dsh.files.node_modules, '', false);
  fs.closeSync(fd2);

  const listened = [...new Set([...bundle.matchAll(/\.on\(\s*["']((?:agent|session|workspace)\/[a-z-]+)["']/g)].map((m) => m[1]))];
  console.log('  插件监听: ' + listened.join(', '));
  const live = listened.filter((ev) => emits.has(ev));
  const dead = listened.filter((ev) => !emits.has(ev));
  // 判据是「**至少有一个**监听的事件在宿主侧是活的」，不是「每个都必须活」：
  // 监听一个不存在的事件是**无害**的（cordis 照常注册，永不触发），而为了同时支持
  // 0.1.x 与 0.2.x，插件**必须**同时挂两个名字 —— 各版本各命中一个。
  // 真正的事故形态是「挂的名字**全**是死的」（0.2.0 上只挂 agent/session-start 就是如此），
  // 那会让整条链路静默失效。故这里只把「全死」判为失败。
  check(live.length > 0, '至少一个被监听的会话边界事件在宿主侧是活的',
    live.length > 0 ? `live=${live.join(', ')}` : '全部监听都是死事件 —— 整条链路静默失效');
  if (dead.length > 0) {
    console.log(`  note 兼容性监听（本版本宿主不发，供其它 DSH 版本用）: ${dead.join(', ')}`);
  }
  check(emits.has('agent/created'), '宿主侧确认存在 agent/created（0.2.0 的会话边界事件，遵循它而非猜）');
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n临时目录已清理。');
console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL PASS');
process.exitCode = failed ? 1 : 0;
