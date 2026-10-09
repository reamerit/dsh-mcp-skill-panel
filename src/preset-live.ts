/**
 * standing 树的 live 行源（0.7.0 新增）—— 「preset 文件文本」的数据源替代。
 *
 * 为什么需要它：DSH `0.2.0-rc.2` 的 `agentPresets` 服务砍掉了插件赖以工作的文件面：
 *   - `resolve(id)` 返回的 `AgentPreset` **不再有 `path`**（实测：新包全部 .d.ts 里
 *     没有任何路径字段）；
 *   - `read(id)` **方法被删除**（只剩 `readDocument()`）；
 *   - desktop profile 的 preset 是**内联在 `cordis.yml`** 的 loader 行，
 *     磁盘上根本没有 `agent.cordis.yml` 可读可写。
 * 于是 0.6.0 的 `listPresetMcpRows`（`resolve().path` + `read()` + 正则解析 YAML）
 * 在新宿主上会直接 `throw preset "..." has no path` —— 面板 MCP 列表恒空。
 *
 * 替代数据源更准，不是将就：standing 树的 `entry.options.config` 就是 loader
 * **已求值**的挂载配置 —— `!!js` 表达式（如 `!!js process.env.GITLAB_TOKEN`）
 * 是运行时真值，而旧路径靠正则抓文本再自己求值（`parsePresetMcpText`）。
 * 且 config 形状与 `PresetMcpClientConfig` 对齐，无需再走 `presetConfigOf` 归一。
 *
 * 边界：本模块只读 live 树，不写任何状态。纯映射函数（`configOfEntryOptions`）
 * 零宿主依赖，可被 selftest 直接加载。
 */
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { standingMounts, captureStandingMount } from './standing-rows'
import { standingMountForAgent } from './agent-preset-compat'
import { isMcpEntry } from './mcp-entry'
import type { PresetMcpClientConfig } from './preset-mcp'

/** live 行源产出的一行（PresetMcpRow 的 live 版本；`preset-mcp.ts` 负责合并成面板行）。 */
export interface LivePresetRow {
  /** loader 行 id（standing 树里的长 id，如 include:agent-presets:mcp-filesystem）。 */
  entryId: string
  /** 行内短 id（如 mcp-filesystem；state.json row 键）。 */
  rowId: string
  /** 已求值的挂载配置（形状不可挂载时为 undefined）。 */
  config?: PresetMcpClientConfig
  /** 该行当前是否停用（`entry.options.disabled` 的**原始节点值**取反语义见下）。 */
  disabled: boolean
  /** 该行 fiber 是否在跑（standing 树里有 fiber 即视为运行中）。 */
  running: boolean
  /** 原始 entry 句柄（调用方 toggle/update 用；本模块不改它）。 */
  entry: Entry
}

/** `dsh-mcp-client` 行的挂载配置形状（只取本插件用到的字段）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 字符串键值映射（env/headers）；非法或空返回 undefined。 */
function stringMapOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 字符串数组（args）；非法或空返回 undefined。 */
function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v) => v !== undefined && v !== null).map((v) => String(v))
  return out.length > 0 ? out : undefined
}

/**
 * loader 行 options → 挂载配置。**纯函数**，selftest 可直接喂对象覆盖。
 *
 * 不可挂载（transport 无法归一，或 stdio 缺 command / http 缺 url）时返回
 * undefined —— 与 `presetConfigOf` 同判据，调用方据此把该行按「无实例句柄」处理。
 * @param options - `entry.options`（或任何同形状对象）。
 * @returns 挂载配置，或 undefined。
 */
export function configOfEntryOptions(options: unknown): PresetMcpClientConfig | undefined {
  if (!isRecord(options)) return undefined
  const cfg = options.config
  if (!isRecord(cfg)) return undefined
  const serverName = cfg.serverName !== undefined ? String(cfg.serverName) : undefined
  if (!serverName) return undefined
  // transport 缺省按 mcp-convert 的推断规则：有 command → stdio、有 url → streamable-http。
  const rawTransport = cfg.transport !== undefined ? String(cfg.transport) : undefined
  const transport =
    rawTransport === 'stdio' || rawTransport === 'streamable-http'
      ? rawTransport
      : typeof cfg.command === 'string' && cfg.command.length > 0
        ? 'stdio'
        : typeof cfg.url === 'string' && cfg.url.length > 0
          ? 'streamable-http'
          : undefined
  if (!transport) return undefined
  const out: PresetMcpClientConfig = { serverName, transport }
  if (transport === 'stdio') {
    if (typeof cfg.command !== 'string' || cfg.command.length === 0) return undefined
    out.command = cfg.command
    const args = stringListOf(cfg.args)
    if (args) out.args = args
    const env = stringMapOf(cfg.env)
    if (env) out.env = env
    if (typeof cfg.cwd === 'string' && cfg.cwd.length > 0) out.cwd = cfg.cwd
  } else {
    if (typeof cfg.url !== 'string' || cfg.url.length === 0) return undefined
    out.url = cfg.url
    const headers = stringMapOf(cfg.headers)
    if (headers) out.headers = headers
  }
  const timeout = Number(cfg.toolCallTimeoutMs)
  if (Number.isFinite(timeout) && timeout > 0) out.toolCallTimeoutMs = timeout
  if (typeof cfg.failOnStartupError === 'boolean') out.failOnStartupError = cfg.failOnStartupError
  return out
}

/** 行内短 id（state.json 的 row 键）—— `entry.options.id` 优先，回落长 id 末段。 */
export function rowIdOfEntry(entry: Entry): string {
  const raw = (entry.options as { id?: unknown } | undefined)?.id
  if (typeof raw === 'string' && raw.length > 0) return raw
  return String(entry.id ?? '').split(':').pop() ?? ''
}

/**
 * 某 preset 的 standing 挂载。按 presetId 精确命中；无 presetId 或未命中时回落
 * 单挂载场景（只有一个 preset 挂着时它就是目标）。
 */
export function presetMountOf(presetId?: string): ReturnType<typeof standingMounts>[number] | undefined {
  const mounts = standingMounts()
  if (presetId !== undefined && presetId.length > 0) {
    const hit = mounts.find((m) => String(m.presetId ?? '') === presetId)
    if (hit) return hit
  }
  return mounts.length === 1 ? mounts[0] : undefined
}

/**
 * 某 preset 的 live MCP 行（standing 树直读）。
 *
 * 环境准备：优先经 `ctx.agentPresets.standingMountFor(agentCtx)` 取挂载 ——
 * 该路径走宿主**服务对象**，与模块实例无关（`livePresetMounts()` 的模块私有 Set
 * 只有解析到宿主同一份物理实例时才非空，见 agent-preset-compat.ts）。取不到
 * agentCtx 时回落 `standingMounts()` 的枚举/捕获结果。
 * @param ctx - 宿主上下文（用于服务面兜底）。
 * @param presetId - 目标 preset；缺省时只在单挂载场景可判定。
 * @param agentCtx - 目标会话的 agent ctx（`standingMountFor` 需要它）。
 * @returns live 行（顺序 = 组合顺序）。
 */
export function livePresetRows(ctx: Context, presetId?: string, agentCtx?: Context): LivePresetRow[] {
  let mount = presetMountOf(presetId)
  if (!mount && agentCtx !== undefined) {
    // 经模块级 standingMountFor(agentCtx) —— 走 scopeParentOf(scopeOf(agent)) 查
    // 模块私有 mounts Set，故仍受实例身份约束（见 agent-preset-compat.ts）。
    const viaModule = standingMountForAgent(agentCtx)
    if (viaModule?.tree) {
      mount = viaModule
      // 模块面拿到的挂载记入捕获槽：下一次 `standingMounts()` 也能看到它，
      // 装配过滤等同步路径因此不必再依赖实例解析是否命中。
      captureStandingMount(mount)
    }
  }
  const out: LivePresetRow[] = []
  if (!mount?.tree) return out
  let entries: Entry[]
  try {
    const it = mount.tree.entries()
    entries = Array.isArray(it) ? it : [...it]
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!isMcpEntry(entry)) continue
    const entryId = String(entry.id ?? '')
    if (!entryId) continue
    const rowId = rowIdOfEntry(entry)
    if (!rowId) continue
    const config = configOfEntryOptions(entry.options)
    out.push({
      entryId,
      rowId,
      // `entry.options.disabled` 是**原始节点**（可能是 !!js 字符串）；
      // `entry.disabled` 是求值后的有效值，用它判停用才对。
      disabled: entry.disabled === true,
      running: entry.fiber !== undefined,
      entry,
      ...(config ? { config } : {}),
    })
  }
  return out
}
