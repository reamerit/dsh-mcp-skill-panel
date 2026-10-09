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
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { Context } from '@deepseek-ai/cordis';
import { standingMounts } from './standing-rows';
import type { PresetMcpClientConfig } from './preset-mcp';
/** live 行源产出的一行（PresetMcpRow 的 live 版本；`preset-mcp.ts` 负责合并成面板行）。 */
export interface LivePresetRow {
    /** loader 行 id（standing 树里的长 id，如 include:agent-presets:mcp-filesystem）。 */
    entryId: string;
    /** 行内短 id（如 mcp-filesystem；state.json row 键）。 */
    rowId: string;
    /** 已求值的挂载配置（形状不可挂载时为 undefined）。 */
    config?: PresetMcpClientConfig;
    /** 该行当前是否停用（`entry.options.disabled` 的**原始节点值**取反语义见下）。 */
    disabled: boolean;
    /** 该行 fiber 是否在跑（standing 树里有 fiber 即视为运行中）。 */
    running: boolean;
    /** 原始 entry 句柄（调用方 toggle/update 用；本模块不改它）。 */
    entry: Entry;
}
/**
 * loader 行 options → 挂载配置。**纯函数**，selftest 可直接喂对象覆盖。
 *
 * 不可挂载（transport 无法归一，或 stdio 缺 command / http 缺 url）时返回
 * undefined —— 与 `presetConfigOf` 同判据，调用方据此把该行按「无实例句柄」处理。
 * @param options - `entry.options`（或任何同形状对象）。
 * @returns 挂载配置，或 undefined。
 */
export declare function configOfEntryOptions(options: unknown): PresetMcpClientConfig | undefined;
/** 行内短 id（state.json 的 row 键）—— `entry.options.id` 优先，回落长 id 末段。 */
export declare function rowIdOfEntry(entry: Entry): string;
/**
 * 某 preset 的 standing 挂载。按 presetId 精确命中；无 presetId 或未命中时回落
 * 单挂载场景（只有一个 preset 挂着时它就是目标）。
 */
export declare function presetMountOf(presetId?: string): ReturnType<typeof standingMounts>[number] | undefined;
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
export declare function livePresetRows(ctx: Context, presetId?: string, agentCtx?: Context): LivePresetRow[];
