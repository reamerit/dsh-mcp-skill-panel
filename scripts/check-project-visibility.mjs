// 项目 MCP 可见性过滤的端到端单测（0.7.2）。
// 覆盖此前**完全没有测试**的那条链路：挂载 → projectOwners → 装配过滤。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = 'D:/WORK/github/dsh-mcp-skill-panel'
const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

/** 假 ctx：捕获事件监听器 + 支撑 loader.create/resolve/entries。 */
function makeCtx() {
  const listeners = new Map()
  const rows = new Map()
  let seq = 0
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    root: {
      on(event, fn) {
        listeners.set(event, fn)
        return () => listeners.delete(event)
      },
    },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    loader: {
      async create(row) {
        const id = row.id ?? `created-${++seq}`
        rows.set(id, { ...row, id, options: { id, name: row.name, config: row.config, disabled: row.disabled === true } })
        return id
      },
      resolve(id) {
        const r = rows.get(id)
        if (!r) throw new Error(`cannot resolve entry ${id}`)
        return r
      },
      async update(id, patch) {
        const r = rows.get(id)
        if (!r) throw new Error(`cannot resolve entry ${id}`)
        rows.set(id, { ...r, ...patch, options: { ...r.options, ...(patch.config ? { config: patch.config } : {}) } })
      },
      async remove(id) {
        rows.delete(id)
      },
      entries: () => [...rows.values()],
    },
    agents: { list: () => [], roots: () => [] },
    agentPresets: {},
  }
  const fire = (event, ...args) => {
    const fn = listeners.get(event)
    if (!fn) throw new Error(`no listener for ${event}`)
    return fn(...args)
  }
  return { ctx, rows, fire, has: (e) => listeners.has(e) }
}

function makeWorkspace(servers) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'))
  mkdirSync(join(dir, '.dsh', 'mcps'), { recursive: true })
  writeFileSync(join(dir, '.dsh', 'mcps', 'mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf8')
  return dir
}

/**
 * 驱动一次装配。
 *
 * ⚠️ `next` 必须回吐**同一个** assembly 对象 —— waterfall 的语义是 handler 就地改
 * assembly 后调 `next()` 让它继续，返回值即 `next()` 的结果。回吐新建对象会丢掉
 * handler 的改动（本脚本第一版就这么写，误报成「插件把工具全删了」）。
 */
async function assemble(fire, tools, cwd) {
  const assembly = { tools: tools.map((name) => ({ name })) }
  const context = cwd === undefined ? {} : { agent: { session: { header: { cwd } } } }
  const result = await fire('system-prompt/assemble', assembly, context, async () => assembly)
  return result.tools.map((t) => t.name)
}

const wsA = makeWorkspace({ alpha: { command: 'npx', args: ['-y', 'alpha-mcp'] } })
const wsB = makeWorkspace({ beta: { command: 'npx', args: ['-y', 'beta-mcp'] } })

try {
  const { ctx, fire } = makeCtx()
  const dispose = index.installProjectMcp(ctx)

  // ① 两个工作区各自挂载（remountWorkspace = 面板添加 / 会话进入的同一路径）
  await index.remountWorkspace(ctx, wsA)
  await index.remountWorkspace(ctx, wsB)

  const owners = index.projectVisibilityDiag().ownersNow
  const aServer = Object.keys(owners).find((s) => s.startsWith('alpha'))
  const bServer = Object.keys(owners).find((s) => s.startsWith('beta'))
  assert.ok(aServer, 'alpha 行应已登记 owner')
  assert.ok(bServer, 'beta 行应已登记 owner')
  assert.equal(owners[aServer].toLowerCase(), wsA.toLowerCase(), 'alpha owner 应为 wsA')
  assert.equal(owners[bServer].toLowerCase(), wsB.toLowerCase(), 'beta owner 应为 wsB')

  const tools = [`mcp__${aServer}__tool`, `mcp__${bServer}__tool`, 'read', 'write']

  // ② wsB 会话：剔除 wsA、保留 wsB 与非 MCP 工具
  const keptB = await assemble(fire, tools, wsB)
  assert.ok(!keptB.includes(`mcp__${aServer}__tool`), `wsA 的工具不得出现在 wsB 会话：${JSON.stringify(keptB)}`)
  assert.ok(keptB.includes(`mcp__${bServer}__tool`), `wsB 自己的工具应保留：${JSON.stringify(keptB)}`)
  assert.ok(keptB.includes('read') && keptB.includes('write'), '非 MCP 工具不受影响')

  // ③ wsA 会话：反向成立
  const keptA = await assemble(fire, tools, wsA)
  assert.ok(keptA.includes(`mcp__${aServer}__tool`), 'wsA 自己的工具应保留')
  assert.ok(!keptA.includes(`mcp__${bServer}__tool`), 'wsB 的工具不得出现在 wsA 会话')

  // ④ 无项目 MCP 的第三个工作区：两边都看不到。但 loader 里仍有行 ⇒ 不过快速通道，
  //    必须走判定并逐条剔除（这正是「面板可见但模型不可见」的正确形态）。
  const wsC = mkdtempSync(join(tmpdir(), 'ws-'))
  assert.deepEqual(await assemble(fire, tools, wsC), ['read', 'write'], '无项目 MCP 的工作区不应看到任何项目工具')

  // ⑤ 无 agent 上下文（诊断装配）：项目工具隐藏
  assert.deepEqual(await assemble(fire, tools, undefined), ['read', 'write'], '无会话上下文时应隐藏项目工具')

  // ⑥ 路径大小写不敏感（Windows）
  const keptUpper = await assemble(fire, tools, wsB.toUpperCase())
  assert.ok(keptUpper.includes(`mcp__${bServer}__tool`), 'Windows 下路径大小写不敏感应命中同一工作区')

  // ⑦ 诊断台账：必须真的执行过判定，而不是走「projectOwners 为空」的快速通道放行
  const diag = index.projectVisibilityDiag()
  assert.ok(diag.assembled >= 5, `应执行过判定，实际 assembled=${diag.assembled}`)
  assert.equal(diag.bypassed, 0, 'projectOwners 非空时不得走快速通道放行')
  const last = diag.recent.at(-1)
  assert.ok(last.workspace !== null, '台账应记录到会话 cwd')

  // ⑧ teardown 必须释放工作区资源（否则 fs.watch 句柄泄漏、进程不退出）
  dispose()
  await index.disposeAllWorkspaces(ctx)
  assert.deepEqual(index.projectVisibilityDiag().ownersNow, {}, 'teardown 后 projectOwners 应清空')
  rmSync(wsC, { recursive: true, force: true })
  console.log(`项目 MCP 可见性：${diag.assembled} 次判定全部正确，bypassed=${diag.bypassed}`)
  console.log('project visibility: all checks passed')
  process.exit(0) // 显式退出：确保任何残留句柄不阻塞收尾
}
catch (error) {
  console.error('FAIL:', error?.message ?? error)
  process.exit(1)
}
finally {
  rmSync(wsA, { recursive: true, force: true })
  rmSync(wsB, { recursive: true, force: true })
}
