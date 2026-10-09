// 产物验证：无 TOOL_RUNTIME_SCHEDULER 内联、external import 正确、导出完整、类型产物齐全
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = false
// 注意：check 必须**返回布尔** —— 多处用法是 `if (check(...)) { …细粒度断言… }`。
// 早先这里没有 return（返回 undefined），使那些内层断言恒不执行：row-display 与 session-scope
// 两组「零依赖独立产物」的内层断言其实一直是死代码（2026-09-16 独立审查 WARN-1，实测输出为证）。
const check = (ok, label) => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  return ok
}

const nodeOut = join(root, 'lib', 'index.js')
const clientOut = join(root, 'lib', 'client.js')
const typesDir = join(root, 'lib', 'types')

check(existsSync(nodeOut), `node bundle exists: ${nodeOut}`)
check(existsSync(clientOut), `client bundle exists: ${clientOut}`)
check(existsSync(typesDir) && readdirSync(typesDir, { recursive: true }).some((f) => String(f).endsWith('.d.ts')), 'lib/types/*.d.ts generated (package.json types must not dangle)')

if (existsSync(nodeOut)) {
  const src = readFileSync(nodeOut, 'utf8')
  const inline = (src.match(/TOOL_RUNTIME_SCHEDULER/g) || []).length
  check(inline === 0, `no inlined TOOL_RUNTIME_SCHEDULER (found ${inline})`)
  check(/import\s*\{[^}]*scopeOf[^}]*\}\s*from\s*"@deepseek-ai\/dsh-scope"/.test(src), 'external dsh-scope import kept')
  check(/import\s+Schema\s+from\s*"@deepseek-ai\/schemastery"/.test(src), 'external schemastery import kept')
  // 0.5.7 回归：agent-presets 系列的挂载记录是**模块私有** Set（0.1.x lib/index.js:695、
  // 0.2.x registry lib/index.js:78），内联成第二份实例会让 livePresetMounts() 恒返回 []，
  // preset 行句柄再次失联 —— 与 dsh-tools 双实例同类事故。
  //
  // 0.7.0 起**不能**再用「静态 import 字符串」判定：0.2.0 删掉了旧包名，静态 import
  // 会在模块图加载期 ERR_MODULE_NOT_FOUND，故改为 createRequire 动态解析
  // （src/agent-preset-compat.ts）。护栏随之改成两条更本质的断言：
  //   ① 两个候选包名都出现在产物里（证明解析器没被摇掉）；
  //   ② **没有**静态 import 这两个包（静态 import 是 0.2.0 上必崩的写法）。
  check(
    src.includes('@deepseek-ai/dsh-agent-preset-registry') && src.includes('@deepseek-ai/dsh-agent-presets'),
    'agent-presets 双包名解析器保留（0.1.x 旧名 + 0.2.x registry）',
  )
  check(
    !/^\s*import\s[^\n]*from\s*["']@deepseek-ai\/dsh-agent-presets?["']/m.test(src) &&
      !/^\s*import\s[^\n]*from\s*["']@deepseek-ai\/dsh-agent-preset-registry["']/m.test(src),
    'no static import of agent-presets (0.2.0 removed the old name; must stay dynamic)',
  )
  check(
    /createRequire/.test(src),
    'agent-presets resolved through createRequire (external instance keeps module identity)',
  )
}

if (existsSync(clientOut)) {
  const src = readFileSync(clientOut, 'utf8')
  check(src.includes('__ModuleLoader__.load'), 'client wrapped with __ModuleLoader__.load')
  check(src.includes('exports.apply = apply'), 'client exports.apply')
  check(src.includes('exports.inject = inject'), 'client exports.inject')
  check(src.includes('require("react")') || src.includes('require(\'react\')'), 'react kept external')
}

// 0.6.0：row-display 必须是零依赖独立产物（selftest 靠它绕开宿主包解析）。
{
  const rowDisplayOut = join(root, 'lib', 'row-display.js')
  if (check(existsSync(rowDisplayOut), `row-display standalone bundle exists: ${rowDisplayOut}`)) {
    const src = readFileSync(rowDisplayOut, 'utf8')
    check(!/^\s*import\s/m.test(src), 'row-display has zero imports (host-free, selftest-loadable)')
    check(/export\s*\{[^}]*rowDisplay/.test(src), 'row-display exports rowDisplay')
  }
}

// 0.6.0 会话透传：session-scope 同样必须是零依赖独立产物（selftest 直接 import 它）。
{
  const sessionScopeOut = join(root, 'lib', 'session-scope.js')
  if (check(existsSync(sessionScopeOut), `session-scope standalone bundle exists: ${sessionScopeOut}`)) {
    const src = readFileSync(sessionScopeOut, 'utf8')
    check(!/^\s*import\s/m.test(src), 'session-scope has zero imports (host-free, selftest-loadable)')
    check(
      /export\s*\{[^}]*readCurrentSession/.test(src) &&
        /export\s*\{[^}]*withSessionParam/.test(src) &&
        /export\s*\{[^}]*sessionField/.test(src),
      'session-scope exports readCurrentSession / withSessionParam / sessionField',
    )
  }
}

// 0.7.0：预设文本工具同样是独立产物（selftest 直接加载），**不得引入任何宿主包**。
// 0.7.0 起它合法地 import `node:os` / `node:path`（来自 preset.ts），故判据是
// 「非 node: 前缀的 import 必须为零」而不是「零 import」。
{
  const presetTextOut = join(root, 'lib', 'preset-text.js')
  if (check(existsSync(presetTextOut), `preset-text standalone bundle exists: ${presetTextOut}`)) {
    const src = readFileSync(presetTextOut, 'utf8')
    const bare = [...src.matchAll(/^\s*import\s[^\n]*?from\s*["']([^"']+)["']/gm)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('node:'))
    check(bare.length === 0, `preset-text has no host-package imports (found ${bare.join(', ') || 'none'})`)
    check(/livePresetRowsToRows/.test(src), 'preset-text exports livePresetRowsToRows (0.2.0 数据源映射)')
    check(/presetKeyOf/.test(src), 'preset-text exports presetKeyOf (state.json 行来源键)')
  }
}

if (failed) process.exit(1)
console.log('verify done: all checks passed')
