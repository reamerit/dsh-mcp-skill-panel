/**
 * 延迟生效（P1 会话边界）：MCP 启停意图的待生效队列。
 *
 * next-session 模式下 toggle 不立即 entry.update（避免中途改 tools 前缀 → 缓存 miss），
 * 只写 state.json.desired 并进入本模块的 pendingMcp 内存队列；在边界统一应用：
 * - 实时：新会话 `agent/session-start`（首次请求前）调用 applyPendingMcp
 * - 兜底：DSH 重启后由 syncPresetFiles() 从 state.json 物化到预设组合（既有路径）
 * - 强制：面板「立即应用待生效变更」端点同样调用 applyPendingMcp
 *
 * immediate 模式不经过本队列（toggleMcp 直接 entry.update）。
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { isMcpEntry, serverNameOf } from './mcp-entry'
import type { McpCallController } from './mcpcall'
import { rowDisabledState } from './preset'
import { findStandingEntryById, standingMcpEntries, presetIdOfEntry } from './standing-rows'
import { presetKeyOf } from './preset-mcp'
import { readState, writeState, type StateFile } from './state'
import { messageOf } from './util'

/** 单个待生效项（key = entryId）。 */
export interface PendingMcpEntry {
  entryId: string
  /** 预设组合文件绝对路径（0.2.0 起为 null —— preset 不再落盘）。 */
  file: string | null
  rowId: string
  disabled: boolean
  /**
   * state.json 的行来源键（0.7.0）。有文件时 = 文件路径，否则 = `preset:<id>`。
   * 缺省时由 `applyStateResidue` 按行句柄现算，保证旧队列项也能落对键。
   */
  sourceKey?: string | null
}

/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
export const pendingMcp = new Map<string, PendingMcpEntry>()

export interface PendingDeps {
  ctx: Context
  controller?: McpCallController
}

/**
 * 解析待生效意图对应的行句柄：loader 优先，preset 行回落 standing 树（0.5.7）。
 * 两者都 miss 才视为行已失效（调用方清队列）。
 */
function resolvePendingEntry(ctx: Context, entryId: string): Entry | undefined {
  try {
    const entry = ctx.loader.resolve(entryId) as Entry | undefined
    if (entry) return entry
  } catch {
    /* preset 行必然抛 "cannot resolve entry" → 走 standing 兜底 */
  }
  return findStandingEntryById(entryId)
}

/**
 * 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
 * （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
 * 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
 */
export async function applyPendingMcp(deps: PendingDeps): Promise<number> {
  const { ctx } = deps
  let applied = 0
  // ① 内存队列（本进程内 next-session 记下的意图）
  for (const [entryId, pending] of [...pendingMcp.entries()]) {
    try {
      // loader.resolve 需要完整嵌套 id；行不存在/非 MCP 行时视为已失效，直接清队列。
      // 0.5.7：preset 行不在 loader 可达域，回落 standing 树句柄（否则意图永远应用不了）。
      const entry = resolvePendingEntry(ctx, entryId)
      if (!entry || !isMcpEntry(entry)) {
        pendingMcp.delete(entryId)
        continue
      }
      await entry.update({ disabled: pending.disabled })
      if (!pending.disabled && deps.controller) {
        deps.controller.markUserEnabled(serverNameOf(entry))
      }
      pendingMcp.delete(entryId)
      applied += 1
      ctx.logger.info?.(`mcp-skill-panel: applied pending toggle ${entryId} → disabled=${pending.disabled}`)
    } catch (error) {
      ctx.logger.warn?.(`mcp-skill-panel: pending apply "${entryId}" failed: ${messageOf(error)}`)
      // 保留待办，下个边界重试
    }
  }
  // ② state.json 残留兜底：重启/热重载后内存队列为空，但 desired 与 live 仍可能不一致
  //   （syncPresetFiles 因「有 agent 在跑」跳过物化等）。把 desired 应用到 live；
  //   预设文件被外部改过（cur !== lastApplied）的行尊重现状、放弃管理并清除残留
  //   （与 syncPresetFiles 同语义，防止「Apply pending now」点击后遗留无效徽标）。
  //   运行期仍不写预设文件（事故 5.1 铁律）：重启后由 syncPresetFiles 物化闭环。
  applied += await applyStateResidue(deps, await readState().catch(() => undefined))
  return applied
}

/**
 * state.json 残留补齐（见 applyPendingMcp ②）。只改 live（entry.update），
 * 不动 preset 文件与 lastApplied（lastApplied 语义 = 文件上次状态，供物化判定）。
 *
 * 0.7.0 数据源迁移：**有预设文件时行为不变**（按文件路径取键、读文件判外部改动）；
 * 文件不可得时（DSH 0.2.0 起 preset 不再落盘）改用 `preset:<id>` 键，外部改动判据
 * 退化为「live 树事实 vs 记录值」—— 此时没有第三方文本可被外部编辑，该判据等价。
 */
async function applyStateResidue(deps: PendingDeps, state: StateFile | undefined): Promise<number> {
  const { ctx } = deps
  const mcp = state?.mcp
  if (!mcp || Object.keys(mcp).length === 0) return 0
  let applied = 0
  let residueCleared = false
  /** 每个行来源键下的待应用项（有文件时键=文件路径，否则键=`preset:<id>`）。 */
  const buckets = new Map<
    string,
    { file: string | null; items: { entry: Entry; rowState: NonNullable<NonNullable<StateFile['mcp']>[string]>[string] }[] }
  >()
  // 0.5.7 修：原先只遍历 ctx.loader.entries()，preset 行不在其中 → 本函数对 preset 行
  // **恒为 0 应用**，state.json 的 desired 永远悬着（实测 desired=false 而 disabled=false
  // 并存）。改为「loader 行 ∪ standing 行」，行句柄一律来自 standing 树。
  for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
    if (!isMcpEntry(entry)) continue
    if (pendingMcp.has(entry.id)) continue
    const rowId = String(entry.options.id ?? '')
    if (!rowId) continue
    const tree = entry.parent?.tree as { filename?: string } | undefined
    const file = typeof tree?.filename === 'string' && tree.filename.length > 0 ? tree.filename : null
    const key = file ?? presetKeyFor(entry, rowId, mcp)
    if (!key) continue
    const rowState = mcp[key]?.[rowId]
    if (!rowState || typeof rowState.desired !== 'boolean') continue
    if (rowState.desired === entry.disabled) continue
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { file, items: [] }
      buckets.set(key, bucket)
    }
    bucket.items.push({ entry, rowState })
  }
  for (const [key, bucket] of buckets) {
    // 有文件才读盘判「外部改动」；无文件时用空串，rowDisabledState 找不到行 → null，
    // 与 lastApplied 的比对自然落到「按 live 事实对齐」分支（无第三方文本可被改）。
    let text = ''
    if (bucket.file !== null) {
      try {
        text = await readFile(bucket.file, 'utf8')
      } catch {
        // 文件已不存在：该键下全部 entry 跳过（不动 state）
        continue
      }
    }
    let keyCleared = false
    for (const { entry, rowState } of bucket.items) {
      const cur = bucket.file !== null ? rowDisabledState(text, String(entry.options.id)) : (entry.disabled ?? null)
      if (cur !== rowState.lastApplied) {
        // 行来源被外部/其他途径改过：尊重现状（不动 live）。
        // 2026-08-27 修复：此前直接删除残留条目 → 物化链路误判时用户设置永久丢失；
        // 改为保留 desired、lastApplied 对齐现实，面板仍显示意图，可重新接管。
        if (bucket.file !== null) {
          rowState.lastApplied = cur
          keyCleared = true
          ctx.logger.info?.(`mcp-skill-panel: state-residue ${entry.id}: preset file externally modified, aligning lastApplied`)
          continue
        }
        // 无文件（0.2.0）：没有"外部改动"这回事，lastApplied 只是启动前的记录值，
        // 直接按 desired 应用 —— 否则 state.json 的意图永远悬着。
      }
      try {
        await entry.update({ disabled: rowState.desired })
        if (!rowState.desired && deps.controller) {
          deps.controller.markUserEnabled(serverNameOf(entry))
        }
        applied += 1
        ctx.logger.info?.(`mcp-skill-panel: applied state-residue toggle ${entry.id} → disabled=${rowState.desired}`)
      } catch (error) {
        ctx.logger.warn?.(`mcp-skill-panel: state-residue apply "${entry.id}" failed: ${messageOf(error)}`)
      }
    }
    if (keyCleared) residueCleared = true
  }
  if (residueCleared) await writeState(state ?? {}).catch(() => undefined)
  return applied
}

/**
 * 无预设文件时的行来源键：优先用行所属 preset 反查 `preset:<id>`；反查不到时
 * 在 state 里找「含该 rowId 的 preset: 键」兜底（多 preset 下 rowId 唯一即可命中）。
 */
function presetKeyFor(
  entry: Entry,
  rowId: string,
  mcp: NonNullable<StateFile['mcp']>,
): string | null {
  const pid = presetIdOfEntry(entry)
  if (pid.length > 0) {
    const key = presetKeyOf(pid)
    if (mcp[key]) return key
  }
  for (const key of Object.keys(mcp)) {
    if (key.startsWith('preset:') && mcp[key]?.[rowId]) return key
  }
  return null
}

/** 当前待生效项数量（面板/诊断用）。 */
export function pendingMcpCount(): number {
  return pendingMcp.size
}
