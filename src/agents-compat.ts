/**
 * agents 服务兼容层（0.7.3）—— 本插件**唯一**一处 `roots()` 调用点。
 *
 * 背景（2026-11 实测取证）：DSH `0.2.2-rc.2` 把 `AgentRegistry`
 * （`@deepseek-ai/dsh-agent`）的公开读取面收窄成 `get(id)` / `list()`，
 * `roots()` 被整体删除：
 *   - `0.1.2-rc.1` 的 `lib/types/index.d.ts:365` 有 `roots(): Agent[]`；
 *   - `0.2.2-rc.2` 同名文件只剩 `get` / `list`，且整个宿主 `lib/**` 里
 *     再也搜不到任何 `roots(`。
 * 后果不是降级而是**挂载即崩**：`apply` 期调用 `ctx.agents.roots()`
 * 直接抛 `TypeError: ctx.agents.roots is not a function`，插件整棵树装载失败
 * （实测报错原文：`ctx.agents.roots is not a function`）。
 *
 * 旧语义（0.1.2-rc.1 原注释）：`roots()` 返回「当前存活的顶层 agent」，
 * 顶层 = 创建时**没有 owning agent context**。新宿主没有这条运行时关系可读，
 * 但 `SessionHeader`（`@deepseek-ai/dsh-session` 的 types.d.ts）给了等价且**持久**的判据：
 *   - `origin?: 'subagent'` —— 子代理子会话的产品分类。原注释明说
 *     「`parentSession` 的存在本身不能判定子代理，要用 `origin`」
 *     （普通 fork 也会带 `parentSession`），故这里只认 `origin`。
 *   - `delegationDepth?: number` —— 顶层会话缺省（=0），子代理为父层 +1。
 * 两者任一表明是子代理即排除；两个字段都读不到时**不算顶层**（交给下面的兜底）。
 *
 * 降级方向（绝不比旧代码更差）：过滤结果为空时**回落整张 `list()`**，
 * 与旧写法 `roots()[0] ?? list()[0]` 完全同义 —— 过滤只用于「挑更合适的那个」，
 * 不允许因为读不到 header 就让面板失去 agent。任何服务面异常都吞掉并返回
 * 已读到的部分（`[]` 最差），调用方的 `if (!agent)` 分支照旧。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * 本插件用到的 agents 最小读取面。`roots` 可选：0.2.2-rc.2 起不存在，
 * 故一律经 `typeof === 'function'` 守卫后才调用（结构性读取，不依赖 .d.ts）。
 */
interface AgentsFace {
  roots?: () => unknown
  list: () => unknown
}

/** agent 上用于判定顶层会话的最小形状。 */
interface RootProbe {
  session?: { header?: { origin?: unknown; delegationDepth?: unknown } }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 单个 agent 是否顶层（非子代理）。
 * @param agent - 候选 live agent。
 * @returns 读到 header 且未标记 subagent / 深度不大于 0 时为 true；
 *   header 缺失或形状不明时返回 false（由 {@link rootAgents} 兜底）。
 */
function isTopLevelAgent(agent: unknown): boolean {
  if (typeof agent !== 'object' || agent === null) return false
  const header = (agent as RootProbe).session?.header
  if (typeof header !== 'object' || header === null) return false
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  if (typeof depth === 'number' && depth > 0) return false
  return true
}

/**
 * 当前存活的顶层 agent 列表。
 *
 * 旧宿主（≤ 0.2.1）：`roots()` 在场则**原样沿用**，语义零变化。
 * 新宿主（0.2.2+）：`roots()` 已被删除 → 按 `origin`/`delegationDepth` 过滤 `list()`；
 * 过滤为空则回落整张 `list()`（= 旧 `roots()[0] ?? list()[0]` 的兜底分支）。
 *
 * @param ctx - 宿主 Context（需注入 `agents`）。
 * @returns 顶层 agent 数组，永不抛错；服务缺失或已半卸载时为 `[]`。
 */
export function rootAgents(ctx: Context): Agent[] {
  const service = (ctx as unknown as { agents?: AgentsFace }).agents
  if (service === undefined || service === null || typeof service.list !== 'function') return []
  if (typeof service.roots === 'function') {
    try {
      const legacy = asArray(service.roots.call(service))
      // 旧接口在场且真有顶层 agent：直接返回，保持 0.1.x / 0.2.0 行为逐字节相同。
      if (legacy.length > 0) return legacy as Agent[]
    } catch {
      // 接口在场但抛错（半卸载的注册表）：继续走 list() 兜底，不让诊断/请求链断掉。
    }
  }
  let all: unknown[]
  try {
    all = asArray(service.list.call(service))
  } catch {
    return []
  }
  const topLevel = all.filter(isTopLevelAgent)
  return (topLevel.length > 0 ? topLevel : all) as Agent[]
}

/**
 * 顶层 agent 的第一个，取不到时取 `list()[0]`。
 * @param ctx - 宿主 Context。
 * @returns 首个顶层 agent；无 agent 时为 `undefined`（= 旧 `roots()[0] ?? list()[0]`）。
 */
export function firstRootAgent(ctx: Context): Agent | undefined {
  return rootAgents(ctx)[0]
}
