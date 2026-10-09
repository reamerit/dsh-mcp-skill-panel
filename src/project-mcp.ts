/**
 * 项目级（工作空间）MCP 运行时：读取 <workspace>/.dsh/mcps 下所有子目录的 mcp.json，
 * 惰性挂载 dsh-mcp-client 行到 loader 根树，并按「当前会话工作空间」过滤可见性，
 * 实现「仅该项目会话可见」。
 *
 * 工作空间 = 会话 cwd（用户约定：只认这个文件夹，不做 .git 向上查找）；
 * 根目录下没有 .dsh/mcps 目录 → 该工作空间没有项目 MCP。
 * 读取规则：<root>/.dsh/mcps/mcp.json 与所有子目录下（`**`）的 mcp.json
 * 都读，按 serverName 去重：先读根目录 json，子目录 json 覆盖根目录。
 *
 * 2026-08-27 实测确认的框架约束：
 * - dsh-mcp-client 的 serverName 按 ctx.root 全局唯一（activeServerNames WeakMap），
 *   跨工作空间同 serverName 只能挂第一个实例，后续冲突跳过并告警。
 * - agent 的 scope key 已被 preset standing key 绑定（bindScopeParent 对已绑定 key
 *   抛错），无法再绑项目作用域 → 严格「按会话作用域挂载」被框架锁死；
 *   因此挂载到 loader 根树（对面板枚举/启停/catalog 完全复用），「仅项目会话可见」
 *   由本模块的常开过滤（system-prompt/assemble 按会话 cwd）实现。
 * - 根树 backing 文件 cordis.yml 每次启动被重置为 []，create 触发的 tree.write 无害。
 * - 已知限制（dev 场景）：插件 HMR 重载后 projectOwners 内存表清空（挂载的 projmcp-* 行仍在
 *   根树）。apply 早期调用 rebuildOwnersFromState 从 state.json 反向重建 owner 映射，
 *   消除「下次会话进入前按全局展示/工具禁用作用域错判」的泄漏窗口。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { watch, type FSWatcher } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServers, McpRowConfig } from './mcp-convert'
import { parseMcpServersJson, resolveServersEnv, serversToRows } from './mcp-convert'
import { serverOfMcp } from './catalog'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import { readState } from './state'
import { messageOf } from './util'

/** 工作空间根下项目 MCP 的固定目录。 */
const MCPS_DIR = '.dsh/mcps'
/** watcher 去抖窗口（合并文件批量写）。 */
const RESCAN_DEBOUNCE_MS = 200

/** serverName → 所属工作空间根（仅本项目 MCP 行；全局行不在表内）。 */
const projectOwners = new Map<string, string>()
/** 最近一次会话进入的工作空间（随会话切换更新；面板添加项目 MCP 的目标工作区）。 */
let activeWorkspace: string | null = null

/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
export function projectServerOwner(serverName: string): string | undefined {
  return projectOwners.get(serverName)
}

/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
export function getActiveWorkspace(): string | null {
  return activeWorkspace
}

/** 路径比较：Windows 下忽略大小写（同一路径大小写不同视为同一工作区）。 */
function strEquals(a: string, b: string | null | undefined, mode?: 'ignorecase'): boolean {
  if (typeof b !== 'string') return false
  return mode === 'ignorecase' ? a.toLowerCase() === b.toLowerCase() : a === b
}

interface WorkspaceState {
  root: string
  /** serverName → loader entryId。 */
  entries: Map<string, string>
  watcher: FSWatcher | undefined
  /** watch 事件去抖定时器（合并编辑器保存时的连续 change 事件）。 */
  refreshTimer: NodeJS.Timeout | undefined
  /** 重扫进行中标志（防止并发 refresh 对同一 state 竞态）。 */
  refreshing: boolean
}

const workspaces = new Map<string, WorkspaceState>()

/* ── 文件系统发现 ─────────────────────────────────────────────────────── */

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 递归收集 `dir` 下所有子目录（含 dir 本身）的 mcp.json：根目录文件在前、子目录按路径序。 */
async function collectMcpJsonFiles(dir: string, out: string[]): Promise<void> {
  if (await fileExists(join(dir, 'mcp.json'))) out.push(join(dir, 'mcp.json'))
  let names: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return
  }
  for (const name of names) await collectMcpJsonFiles(join(dir, name), out)
}

/**
 * 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
 * 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
 * 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
 */
export async function scanWorkspaceMcp(root: string, warn?: (message: string) => void): Promise<McpServers> {
  const mcpsDir = join(root, MCPS_DIR)
  if (!(await isDirectory(mcpsDir))) return {}
  const files: string[] = []
  await collectMcpJsonFiles(mcpsDir, files)
  const servers: McpServers = {}
  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      warn?.(`读取项目 MCP 配置失败 ${file}: ${messageOf(error)}`)
      continue
    }
    const parsed = parseMcpServersJson(text)
    for (const error of parsed.errors) warn?.(`${file}: ${error}`)
    for (const warning of parsed.warnings) warn?.(`${file}: ${warning}`)
    // 后写覆盖先写（根目录文件先被收集，子目录在后 → 子目录覆盖根目录）
    for (const [name, server] of Object.entries(parsed.servers)) servers[name] = server
  }
  return servers
}

/* ── 挂载 / 卸载 ──────────────────────────────────────────────────────── */

/** 工作空间根的稳定 id 前缀（djb2 hash，避免跨工作空间 entry id 冲突）。 */
function projectIdPrefix(root: string): string {
  let hash = 5381
  for (let i = 0; i < root.length; i += 1) hash = ((hash << 5) + hash + root.charCodeAt(i)) >>> 0
  return `projmcp-${hash.toString(16).padStart(8, '0')}`
}

/**
 * 项目 MCP 的 serverName 重命名：追加<路径哈希 8 位 hex>后缀。
 *
 * 背景（2026-08-27 用户需求）：不同工作区可能配置「同 serverName 但路径参数不同」
 * 的项目 MCP（如各自 codegraph 指向不同仓库）。dsh-mcp-client 的 serverName 全进程
 * 唯一，同名会互相挤占 → 后挂载的工作区会拿到前者的路径配置、调用必然失败。
 * 给 serverName 追加确定性路径后缀后，不同工作区 = 不同 serverName = 各自独立实例。
 *
 * 形态：`<原名>-<8位hex>`（如 codegraph-e5f6a7b8，原名领先更可读）。
 * 约束：serverName 限 `[A-Za-z0-9_-]{1,32}`,后缀 8 位 hex + 分隔符 `-`;
 * 原名超过 23 字符时截断尾部（保留头部可读性），总长收敛到 ≤32。
 */
export function projectServerName(root: string, name: string): string {
  let hash = 5381
  for (let i = 0; i < root.length; i += 1) hash = ((hash << 5) + hash + root.charCodeAt(i)) >>> 0
  const suffix = `${hash.toString(16).padStart(8, '0')}`
  return `${name.slice(0, 23)}-${suffix}`
}

/** 对比配置变化（loader.update 的 diff 需要；JSON 序列化足够判等）。 */
function configChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * 项目 MCP 行构建：原始 mcpServers 配置 → dsh-mcp-client 行，
 * 并把 serverName 重命名为带路径哈希前缀（不同工作区同名 server 拆成独立实例）。
 * entry id 仍由 projectIdPrefix（同样含路径 hash）保证跨工作区唯一，无需重复缀加。
 */
function buildRows(root: string, servers: McpServers): McpRowConfig[] {
  const rows = serversToRows(resolveServersEnv(servers), projectIdPrefix(root))
  for (const row of rows) {
    const raw = String(row.config.serverName ?? '')
    row.config.serverName = projectServerName(root, raw)
  }
  return rows
}

/** 按行集合同步该工作空间已挂载的条目：删多出的、更新变化的、新建缺的。
 * 应用 state.json 的 projectMcp 禁用意图（面板开关 → 重启/热更新后保持）。 */
async function syncRows(ctx: Context, state: WorkspaceState, rows: McpRowConfig[]): Promise<void> {
  const wanted = new Map(rows.map((row) => [String(row.config.serverName), row]))
  // state 内存缓存：每次 sync 读一次，成本可忽略（面板 toggle 也走同一缓存）
  const stateFile = await readState().catch(() => undefined)
  const intentOf = (serverName: string): boolean => Boolean(stateFile?.projectMcp?.[state.root]?.[serverName])
  // 删除已不再需要的行
  for (const [serverName, entryId] of [...state.entries]) {
    if (wanted.has(serverName)) continue
    try {
      await ctx.loader.remove(entryId)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 卸载项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
    }
    state.entries.delete(serverName)
    projectOwners.delete(serverName)
  }
  for (const [serverName, row] of wanted) {
    const existingId = state.entries.get(serverName)
    if (existingId) {
      try {
        const entry = ctx.loader.resolve(existingId)
        const wantDisabled = intentOf(serverName)
        if (entry && (configChanged(entry.options.config, row.config) || Boolean(entry.disabled) !== wantDisabled)) {
          await ctx.loader.update(existingId, { ...row, disabled: wantDisabled })
        }
      } catch (error) {
        ctx.logger.warn?.(`mcp-skill-panel: 更新项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
      }
      continue
    }
    // serverName 已带路径哈希后缀（projectServerName）：不同工作空间同名 server
    // 天然拆成不同 serverName，无需再手动查重；loader 全局唯一冲突（哈希碰撞等
    // 极端情况）由下方 loader.create 抛错 → catch 记录告警兜底。
    try {
      await ctx.loader.create({ ...row, disabled: intentOf(serverName) })
      state.entries.set(serverName, row.id)
      projectOwners.set(serverName, state.root)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 挂载项目 MCP "${serverName}" 失败: ${messageOf(error)}`)
    }
  }
}

/** 卸载某工作空间的全部项目 MCP 条目并停 watcher。 */
async function disposeWorkspace(ctx: Context, root: string): Promise<void> {
  const state = workspaces.get(root)
  if (!state) return
  workspaces.delete(root)
  if (state.refreshTimer) clearTimeout(state.refreshTimer)
  state.watcher?.close()
  for (const [serverName, entryId] of [...state.entries]) {
    try {
      await ctx.loader.remove(entryId)
    } catch {
      /* 行已失效，忽略 */
    }
    projectOwners.delete(serverName)
  }
  state.entries.clear()
}

/**
 * 会话进入工作空间时：无 .dsh/mcps → 卸载；有 → 扫描并按需挂载。
 * 记录「最近进入的工作空间」（活动工作区，随会话切换更新）。 */
async function ensureWorkspace(ctx: Context, root: string): Promise<void> {
  // 会话切换即刷新活动工作区（即使该目录没有项目 MCP，也是当前所处工作区）
  activeWorkspace = root
  if (!(await isDirectory(join(root, MCPS_DIR)))) {
    await disposeWorkspace(ctx, root)
    return
  }
  const servers = await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))
  const rows = buildRows(root, servers)
  let state = workspaces.get(root)
  if (!state) {
    state = { root, entries: new Map(), watcher: undefined, refreshTimer: undefined, refreshing: false }
    workspaces.set(root, state)
  }
  await syncRows(ctx, state, rows)
  if (!state.watcher) {
    try {
      // 去抖合并连续 change（编辑器保存一个文件常触发 2-3 次事件），
      // 避免并发 refresh 对同一 state 竞态（loader.create 同 id 并发会抛错）。
      state.watcher = watch(join(root, MCPS_DIR), { recursive: true }, () => {
        if (state.refreshTimer) clearTimeout(state.refreshTimer)
        state.refreshTimer = setTimeout(() => {
          state.refreshTimer = undefined
          void refresh(ctx, root, state!).catch((error) => {
            ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 热更新失败（${root}）: ${messageOf(error)}`)
          })
        }, RESCAN_DEBOUNCE_MS)
      })
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 无法监视 ${join(root, MCPS_DIR)}: ${messageOf(error)}`)
    }
  }
}

/** watcher 触发的重扫：配置/目录变化后按新集合同步（热更新）。 */
async function refresh(ctx: Context, root: string, state: WorkspaceState): Promise<void> {
  if (state.refreshing) return
  state.refreshing = true
  try {
    if (!(await isDirectory(join(root, MCPS_DIR)))) {
      await disposeWorkspace(ctx, root)
      return
    }
    const servers = await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))
    await syncRows(ctx, state, buildRows(root, servers))
  } finally {
    state.refreshing = false
  }
}

/* ── 可见性过滤（常开，独立于 autoManage） ────────────────────────────── */

/**
 * 上一次装配的可见性判定痕迹（诊断用；`/debug` 的 `projectVisibilityDiag` 读它）。
 *
 * 为什么需要它：面板读的是 `ctx.loader.entries()`，而过滤读的是本模块的
 * `projectOwners`。两者**可以不一致** —— 若 `projectOwners` 为空，过滤会在
 * 快速通道 `return next()` 直接放行，**所有项目 MCP 工具泄露给每一个会话**，
 * 而面板看起来一切正常。这条痕迹就是为区分「接管了但判错工作区」与
 * 「根本没接管（表为空）」而设，避免靠猜。
 */
export interface ProjectVisibilityDiag {
  /** 判定执行次数 */
  assembled: number
  /** 因 projectOwners 为空而整体放行（快速通道）的次数 */
  bypassed: number
  /** 最近一次判定的台账（最多 20 条） */
  recent: Array<{
    at: number
    /** 会话 cwd（= 判定用的 workspace）；undefined 表示没取到 agent/session/cwd */
    workspace: string | null
    /** 该次装配里被识别为项目 MCP 的 server */
    projectServers: string[]
    /** owner === workspace 的 server（保留） */
    visible: string[]
    /** owner !== workspace 的 server（过滤掉） */
    hidden: string[]
    /** 建表时的 projectOwners 快照 */
    owners: Record<string, string>
  }>
  /** 当前 projectOwners 全量（工作区 → 无，仅需要键值对） */
  ownersNow: Record<string, string>
}

const visibilityDiag: ProjectVisibilityDiag = { assembled: 0, bypassed: 0, recent: [], ownersNow: {} }

/** 诊断读数（只读快照）。 */
export function projectVisibilityDiag(): ProjectVisibilityDiag {
  return { ...visibilityDiag, recent: visibilityDiag.recent.map((r) => ({ ...r })), ownersNow: Object.fromEntries(projectOwners) }
}

/**
 * 常开过滤：项目 MCP 工具仅在本工作空间会话的装配结果中可见。
 * 非项目 MCP 工具不在此处理（交给 autoManage 的过滤器）。
 */
function installProjectMcpVisibility(ctx: Context): () => void {
  return ctx.effect(() => {
    const off = ctx.root.on(
      'system-prompt/assemble',
      (
        assembly: PromptAssembly,
        context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        if (assembly && Array.isArray(assembly.tools)) {
          // 快速通道：无任何项目 MCP 行时零开销放行（默认场景）
          if (projectOwners.size === 0) {
            visibilityDiag.bypassed += 1
            return next()
          }
          const cwd = (context as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent?.session?.header?.cwd
          const workspace = typeof cwd === 'string' ? cwd : null
          const ownersSnap = Object.fromEntries(projectOwners)
          const projectServers: string[] = []
          const visible: string[] = []
          const hidden: string[] = []
          assembly.tools = assembly.tools.filter((tool) => {
            const name = String(tool?.name ?? '')
            if (!name.startsWith('mcp__')) return true
            const server = serverOfMcp(name)
            // 畸形工具名保守保留，不误伤
            if (server === null) return true
            const owner = projectOwners.get(server)
            // 非项目 MCP：交给 autoManage 过滤器
            if (owner === undefined) return true
            if (!projectServers.includes(server)) projectServers.push(server)
            // 项目 MCP：仅本项目（活动工作空间）会话可见；无会话上下文时隐藏
            // Windows 路径大小写不敏感（c:\ 与 C:\ 视为同一工作区）
            const keep = workspace !== null && strEquals(workspace, owner, 'ignorecase')
            if (keep) {
              if (!visible.includes(server)) visible.push(server)
              return true
            }
            if (!hidden.includes(server)) hidden.push(server)
            return false
          })
          visibilityDiag.assembled += 1
          visibilityDiag.ownersNow = ownersSnap
          visibilityDiag.recent.push({ at: Date.now(), workspace, projectServers, visible, hidden, owners: ownersSnap })
          if (visibilityDiag.recent.length > 20) visibilityDiag.recent.shift()
        }
        return next()
      },
    )
    return off
  }, 'mcp-skill-panel: project mcp visibility')
}

/**
 * 释放全部工作空间的运行时资源（watcher + 已挂载行）。
 *
 * 为什么需要它（0.7.2 修的真实缺口）：`installProjectMcp` 的 teardown 此前只
 * `dispose()` 两个 effect，**从不关 `fs.watch` 句柄**，也不摘掉 `projmcp-*` 行。
 * 后果：插件卸载 / HMR 重载后 watcher 泄漏（每个已激活工作区一个句柄，且回调仍
 * 持有旧 ctx）；单测里更直接 —— 进程因为活跃的 fs.watch 永不退出。
 * @param ctx - 宿主上下文。
 * @returns 释放完成（行移除失败只记日志，不抛）。
 */
export async function disposeAllWorkspaces(ctx: Context): Promise<void> {
  for (const root of [...workspaces.keys()]) {
    try {
      await disposeWorkspace(ctx, root)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: 释放项目 MCP 工作区失败（${root}）: ${messageOf(error)}`)
    }
  }
}

/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
export function installProjectMcp(ctx: Context): () => void {
  const disposers: Array<() => void> = []
  disposers.push(
    ctx.effect(() => {
      // ⚠️ 0.2.0 事件改名（0.7.0 修复，2026-10 实测）：0.1.x 由 `dsh-agent-loop`
      // 发 `agent/session-start`；0.2.0 起该事件**整个消失**（全量扫 app.asar 零命中），
      // 改由 `dsh-agent` 在注册活 agent 时发 **`agent/created`**
      // （dsh-agent/lib/index.js:579 `ctx.serial(carrier, "agent/created", { agent, source, signal })`；
      //  api-catalog: payload `{ agent: Agent; source: SessionStartSource; signal?: AbortSignal }`，
      //  source = 'startup' | 'resume' | 'clear' | 'compact'）。
      //
      // 症状（本 bug）：只监听旧名 ⇒ 0.2.0 上**永不触发** ⇒ 重启后没有任何东西重建
      // 项目 MCP 行（根 loader 树 cordis.yml 每次启动重置为 []），而项目 MCP 的持久化
      // 只有 mcp.json 一个来源 ⇒ 面板添加后当次可见（走 remountWorkspace 直挂），
      // 重启即消失。**不是文件没写、也不是路径不对，是重建时机的事件名过时了。**
      //
      // 两个名字都挂：它们语义相同（会话进入工作空间），且 0.1.x 下发 agent/created
      // 无人消费、0.2.0 下发 agent/session-start 无人发 —— 各版本各命中一个，互不影响。
      const onSessionStart = (payload: {
        agent?: { session?: { header?: { cwd?: unknown } } }
      }): void => {
        const cwd = payload?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) return
        void ensureWorkspace(ctx, cwd).catch((error) => {
          ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 挂载失败（${cwd}）: ${messageOf(error)}`)
        })
      }
      const offs = [
        ctx.root.on('agent/created', onSessionStart),
        ctx.root.on('agent/session-start', onSessionStart),
      ]
      return () => {
        for (const off of offs) off()
      }
    }, 'mcp-skill-panel: project mcp session hook'),
  )
  disposers.push(installProjectMcpVisibility(ctx))
  return () => {
    for (const dispose of disposers) dispose()
    // 0.7.2：teardown 必须同时释放工作区资源 —— 否则 fs.watch 句柄泄漏，
    // 且回调继续持有旧 ctx（HMR 后指向已卸载的树）。
    void disposeAllWorkspaces(ctx).catch(() => {})
  }
}

/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
export async function remountWorkspace(ctx: Context, root: string): Promise<void> {
  await ensureWorkspace(ctx, root)
}

/**
 * HMR/热重载后从 state.json 反向重建 projectOwners 映射（幂等，已有数据时跳过）。
 *
 * 背景：projectOwners 是模块级内存表，插件 HMR 重载即清空，而 loader 根树上的
 * projmcp-* 行仍然存在 → 期间项目工具短暂按全局展示、项目级禁用作用域错判。
 * state.projectMcp（工作空间 → serverName → 禁用意图）保存了 owner 关系，
 * 以 loader 存活行交叉验证后重建；watcher/entries 由下次 session-start 的
 * ensureWorkspace 完整恢复。
 */
export async function rebuildOwnersFromState(ctx: Context): Promise<void> {
  if (projectOwners.size > 0) return
  const stateFile = await readState().catch(() => undefined)
  const map = stateFile?.projectMcp
  if (!map) return
  const live = new Set<string>()
  for (const entry of ctx.loader.entries()) {
    if (isMcpEntry(entry)) live.add(serverNameOf(entry))
  }
  for (const [workspace, servers] of Object.entries(map)) {
    if (!servers || typeof servers !== 'object') continue
    for (const serverName of Object.keys(servers)) {
      if (live.has(serverName)) projectOwners.set(serverName, workspace)
    }
  }
}
