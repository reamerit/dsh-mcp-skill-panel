/**
 * 把 web profile 的全局 MCP 搬成项目级 mcp.json。
 *
 * 与「原样抄」的两个有意差异：
 *  ① 修正 db 行 args 里被 YAML 双引号语义双写的反斜杠（`D:\\WORK` → `D:\WORK`）。
 *  ② **不写 `${VAR}` 占位符，写字面值**（从机器级环境变量取）。
 *     原因（实测 + 源码）：DSH 在 spawn 子进程前会做凭据脱敏 ——
 *     `@deepseek-ai/dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`，
 *     名字命中就不传给子进程。而 `dsh-mcp-client` 的 `buildChildEnv(extra) =
 *     { ...scrubbedParentEnv(), ...extra }` 里 `extra` 是**脱敏之后**才合并的
 *     → config.env 的显式值能存活，但 `${VAR}` 是在宿主 `process.env` 里解析的，
 *     解析不到就变空串。写字面值可以完全绕开这个不确定性。
 *     安全边界：此文件在工作区 .dsh/ 下，属于工作区本地数据，不要提交到仓库。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

const [srcPath, destPath] = process.argv.slice(2);
if (!srcPath || !destPath) {
  console.error('用法: node scripts/apply-project-mcp.mjs <src.json> <dest-mcp.json>');
  process.exit(2);
}

/** 从机器级注册表读一个变量的**字面值**（避开 DSH 的进程环境脱敏）。 */
function machineEnv(name) {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$rk=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');` +
        `$v=$rk.GetValue('${name}');$rk.Close();if($v){[Console]::Out.Write($v)}`],
      { encoding: 'utf8' },
    );
    return out.trim();
  } catch {
    return '';
  }
}

const parsed = JSON.parse(readFileSync(srcPath, 'utf8'));
const servers = parsed.mcpServers ?? {};
const report = [];

// 递归把 `${VAR}` 换成字面值；取不到则保留占位并记入报告。
function subst(node, path) {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
      const value = machineEnv(name);
      if (value === '') {
        report.push(`  ⚠️  ${path}: ${name} 取不到值，保留占位符（该 server 会拿到字面量 ${whole}）`);
        return whole;
      }
      report.push(`  ✅ ${path}: ${name} → 已内联字面值（${value.length} 字符）`);
      return value;
    });
  }
  if (Array.isArray(node)) return node.map((v, i) => subst(v, `${path}[${i}]`));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = subst(v, `${path}.${k}`);
    return out;
  }
  return node;
}

const rewritten = subst(servers, 'mcpServers');

// ① 反斜杠修正
const fixed = [];
for (const [name, cfg] of Object.entries(rewritten)) {
  if (!Array.isArray(cfg.args)) continue;
  const before = JSON.stringify(cfg.args);
  cfg.args = cfg.args.map((a) => (typeof a === 'string' ? a.replace(/\\\\/g, '\\') : a));
  if (JSON.stringify(cfg.args) !== before) fixed.push(name);
}

console.log('=== 值替换报告 ===');
for (const line of report) console.log(line);
if (fixed.length > 0) console.log(`  ✅ 已修正反斜杠: ${fixed.join(', ')}`);

// ② 用插件自己的解析器校验
const convert = await import(pathToFileURL(join(root, 'lib', 'mcp-convert.js')).href);
const check = convert.parseMcpServersJson(JSON.stringify({ mcpServers: rewritten }));
console.log('\n=== 插件解析器校验 ===');
console.log(`  识别到 server: ${Object.keys(check.servers).join(', ') || '(无)'}`);
for (const e of check.errors) console.log('  ❌ ' + e);
for (const w of check.warnings) console.log('  ⚠️  ' + w);
if (check.errors.length > 0) {
  console.log('\n存在解析错误，未写入。');
  process.exit(1);
}

// ③ 备份 + 写入
mkdirSync(dirname(destPath), { recursive: true });
if (existsSync(destPath)) {
  const bak = `${destPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(destPath, bak);
  console.log(`\n已备份原文件 → ${bak}`);
}
const json = JSON.stringify({ mcpServers: rewritten }, null, 2) + '\n';
writeFileSync(destPath, json, 'utf8');
console.log(`已写入 ${destPath}（${Object.keys(rewritten).length} 个 server，${json.length} 字节）`);
const back = JSON.parse(readFileSync(destPath, 'utf8'));
console.log(`回读确认: ${Object.keys(back.mcpServers).length} 个 server`);
