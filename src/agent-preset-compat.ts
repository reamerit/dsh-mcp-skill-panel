/**
 * agent-presets 模块面兼容层（0.7.0）—— 唯一一处「包名 → 模块实例」的解析点。
 *
 * 背景（2026-10 实测取证）：DSH `0.2.0-rc.2` 把 `@deepseek-ai/dsh-agent-presets`
 * 拆成了两个包：
 *   - `@deepseek-ai/dsh-agent-preset`            —— 纯插件（只 default 导出，无读取面）
 *   - `@deepseek-ai/dsh-agent-preset-registry`   —— 服务 + `livePresetMounts` /
 *     `standingMountFor` 等模块级读取口原样保留
 * 于是旧包名在新宿主上**不存在**，而 `standing-rows.ts` 顶部是**静态 import** ——
 * 模块图在加载期就 `ERR_MODULE_NOT_FOUND`，插件的 try/catch 降级设计根本来不及生效
 * （实测：`import * as agentPresets from "@deepseek-ai/dsh-agent-presets"` 在
 * 0.2.0-rc.2 的模块图上直接抛，改名字后「LOADED CLEANLY」）。
 *
 * ⚠️ 为什么必须解析到**宿主那一份**实例（而不是随便装一个）：
 * `livePresetMounts()` 背后是包内**模块私有**的 `const mounts = new Set()`
 * （新旧包皆然：0.1.2-rc.1 的 lib/index.js:695、0.2.0-rc.2 的 lib/index.js:78），
 * 没有 globalThis / Symbol.for 之类的跨实例通道 —— 两份物理拷贝互不可见
 * （实测两个拷贝的 `livePresetMounts !== livePresetMounts`）。解析错实例的后果
 * 不是报错，而是 `livePresetMounts()` 恒返回 []，面板静默退化。
 *
 * 因此解析基准优先用 `ctx.baseUrl`：宿主挂载 preset 走的是
 * `mountPreset(scope.ctx.extend({ baseUrl: record.context.baseUrl }), ...)`
 * （registry lib/index.js:534），用同一个 baseUrl 建 require 就落在宿主同一份实例上。
 * 拿不到 baseUrl 才回落到本插件自身位置（web profile 的 pnpm 扁平层下两者等价，
 * 见 standing-rows.ts 的历史注释）。
 *
 * 用法：`await resolveAgentPresetApi(ctx)` 取模块命名空间（永不为 null，
 * 全部解析失败时返回空对象，调用方的 typeof 守卫自然降级为 0.5.6 行为）。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** standing 组合的挂载描述（只取本插件用到的字段）。 */
export interface StandingMount {
  presetId?: string
  tree?: StandingTree
}

/** standing 组合的 EntryTree（PresetTree extends Include 的公开子集）。 */
export interface StandingTree {
  entries(): Iterable<import('@deepseek-ai/cordis-plugin-loader').Entry>
  resolve?(id: string): import('@deepseek-ai/cordis-plugin-loader').Entry
}

/**
 * 本插件用到的 agent-presets 模块读取面。**全部可选**：宿主版本落后
 * （< 0.1.5-rc.2）或解析彻底失败时这些函数不存在，面板整体降级为 0.5.6 行为
 * （可见性不过滤、开关只记意图），不崩。
 */
export interface AgentPresetModuleApi {
  livePresetMounts?: (within?: unknown) => StandingMount[]
  standingMountFor?: (agentCtx: Context) => StandingMount | undefined
}

/**
 * 新包名优先。理由：0.2.0 起旧包名被拆掉，新包名是**唯一**同时服务 0.1.7+
 * 与 0.2.x 的落点（`dsh-agent-preset-registry` 自 0.1.7-alpha.1 起就在 npm 上，
 * 且与旧包一样导出 `livePresetMounts` / `standingMountFor`）；只在它的解析
 * 失败时才回退旧包名（纯 0.1.5-rc.x 宿主）。
 */
const SPECIFIERS = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-presets'] as const

/** 解析诊断（/debug standingDiag 展示；不参与任何逻辑判断）。 */
export const presetApiDiag: {
  /** 命中的包名；全失败为 null */
  specifier: string | null
  /** 命中实例的解析路径；用于核对「是不是宿主那一份」 */
  resolvedPath: string | null
  /** 解析失败清单（每条 "包名: 错误码/消息"） */
  errors: string[]
  /** 解析基准来源：'ctx.baseUrl' | 'self' */
  base: string
} = { specifier: null, resolvedPath: null, errors: [], base: 'self' }

/** 进程级记忆，避免每次读都重解析。 */
let cached: { api: AgentPresetModuleApi; key: string } | null = null

/** 取一个可用于 createRequire 的 base（绝对文件路径或 file: URL）。 */
function baseOf(ctx: Context | undefined): { base: string; source: string } {
  const baseUrl = (ctx as { baseUrl?: unknown } | undefined)?.baseUrl
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    // cordis 的 baseUrl 可能是 file: URL 或绝对路径；createRequire 两者都吃路径，
    // URL 形态必须先转成路径（含 percent-encoding 解码）。
    if (baseUrl.startsWith('file:')) {
      try {
        return { base: fileURLToPath(baseUrl), source: 'ctx.baseUrl' }
      } catch {
        /* 非法 URL：落回 self */
      }
    } else {
      return { base: baseUrl, source: 'ctx.baseUrl' }
    }
  }
  return { base: import.meta.url, source: 'self' }
}

/**
 * 经模块级 `standingMountFor(agentCtx)` 取某 agent 的 standing 挂载。
 *
 * ⚠️ 这是**模块级函数**，不是 `ctx.agentPresets` 上的服务方法（0.2.0 的
 * `AgentPresetRegistry` 只有 `composedPreset` / `acquireScope`，没有
 * `standingMountFor`）。它按 `scopeParentOf(scopeOf(agentCtx))` 查模块私有
 * `mounts` Set，因此同样受实例身份约束 —— 解析失败时返回 undefined，
 * 调用方按空表降级。
 * @param agentCtx - 目标会话的 agent 上下文。
 * @returns 该 agent 所属 standing 挂载，或 undefined。
 */
export function standingMountForAgent(agentCtx: Context | undefined): StandingMount | undefined {
  if (agentCtx === undefined) return undefined
  const api = cached?.api
  if (!api || typeof api.standingMountFor !== 'function') return undefined
  try {
    return api.standingMountFor(agentCtx)
  } catch {
    return undefined
  }
}

/**
 * 解析 agent-presets 模块命名空间（进程级缓存）。
 *
 * 永不抛：全部候选包名都解析失败时返回空对象，并记入 {@link presetApiDiag}。
 * @param ctx - 宿主上下文；提供 `baseUrl` 时优先按其解析，以命中宿主同一模块实例。
 * @returns 模块命名空间（或空对象）。
 */
export async function resolveAgentPresetApi(ctx?: Context): Promise<AgentPresetModuleApi> {
  const { base, source } = baseOf(ctx)
  if (cached && cached.key === base) return cached.api
  presetApiDiag.errors = []
  presetApiDiag.base = source
  let require: NodeRequire
  try {
    require = createRequire(base)
  } catch (error) {
    presetApiDiag.errors.push(`createRequire(${base}): ${messageOf(error)}`)
    return {}
  }
  for (const specifier of SPECIFIERS) {
    try {
      // Node ≥22.12 支持 require() 同步加载无顶层 await 的 ESM；两个包都符合。
      // 用 require 而非动态 import，是因为调用方（filter.ts 的装配过滤）是同步路径。
      const resolved = require.resolve(specifier)
      const mod = require(specifier) as AgentPresetModuleApi
      presetApiDiag.specifier = specifier
      presetApiDiag.resolvedPath = resolved
      cached = { api: mod, key: base }
      return mod
    } catch (error) {
      presetApiDiag.errors.push(`${specifier}: ${messageOf(error)}`)
    }
  }
  presetApiDiag.specifier = null
  presetApiDiag.resolvedPath = null
  return {}
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}`
  return String(error)
}
