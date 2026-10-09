/**
 * preset 行句柄来源（0.5.7）—— 模型侧可见性 / 面板开关 / mcp_call 唤醒的公共咽喉。
 *
 * 背景与断点（2026-09-13 实测取证，详见 README 变更日志 v0.6.0 的
 * 「preset 行句柄 + 临时拉起闭环 + 已安装能力表」一节）：
 * dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合，**不在 `ctx.loader.entries()`
 * 也不在 `ctx.loader.resolve()` 可达域**（resolve 恒抛 "cannot resolve entry"）。
 * 0.5.5/0.5.6 因此把所有 preset 行逻辑降级成「快照读取 + 意图排队」：
 * `listPresetMcpRows` 走 `agentPresets.compositionInventory()` 与 preset 文件文本，
 * 只读得到 `enabled`/`fiberState` 快照，**拿不到 Entry 句柄**。后果是三处通路
 * 同时断裂（同一根因）：
 *   1. `buildVisibility` 遍历 `ctx.loader.entries()` → 表为空 → filter.ts 的
 *      `?? true` 兜底放行 → **可见性层整体空转，MCP 工具全部照原样进上下文**；
 *   2. `toggleMcp` 的 `entry.update({disabled})` 无句柄 → 只写 state.json.desired
 *      意图 → `applyPendingMcp` 仍 resolve 失败 → **面板开关永不生效**；
 *   3. `mcp_call` 的 `resolveEntry` miss → 走 `presetRow.disabled` 分支直接 throw
 *      「当前已停用…请先在面板打开」 → **关着的 MCP 叫不醒**（无法临时拉起）。
 *
 * 解法：dsh 0.1.5-rc.2 公开了 standing 组合的 EntryTree 读取口：
 *   `standingMountFor(agentCtx) -> { presetId, fiber, tree: EntryTree, key }`
 *   `livePresetMounts(within?)   -> PresetMount[]`（模块级注册表，无需 agent）
 * `PresetTree extends Include`（agent-presets lib/index.js:634-643），即一棵带
 * `resolve()` / `entries()` 的真 EntryTree；行 id 形如
 * `include:agent-presets:mcp-filesystem`，行的 `disabled` 与 inventory 的
 * `enabled === false` 一一对应（实测 10/10 一致），故 rc.8 时代的
 * `entry.update({ disabled })` 语义**原样复活**。
 *
 * ⚠️ 模块身份（本文件成立的前提）：`mounted` 是 agent-presets 的**模块私有**
 * WeakMap/Set，`livePresetMounts()` 只有当本插件解析到与**宿主同一份物理实例**
 * 时才看得到挂载。
 *
 * 0.7.0 起这条约束由两个机制共同保证，不再靠部署布局巧合：
 *   1. `agent-preset-compat.ts` 按 `ctx.baseUrl`（宿主挂载 preset 用的同一基准）
 *      建 require 解析，优先落在宿主那一份实例上；
 *   2. `captureStandingMount()` 在 `apply` 里经 `ctx.agentPresets.standingMountFor()`
 *      捕获一份挂载 —— 该路径走宿主**服务对象**，与模块实例无关，是实例错位时的
 *      兜底（`presetMounts()` 首选 `livePresetMounts()`，空则并入捕获的挂载）。
 *
 * 若升级 DSH 后 standing 行为空，第一嫌疑仍是实例错位 —— 由 `/debug` 的
 * `standingDiag.presetApi`（命中的包名 / 实例路径 / 解析基准 / 失败清单）直接可见。
 *
 * 边界：本模块只做「定位 + 句柄交付」，不改任何状态；写操作只发生在调用方
 * （routes 的 entry.update / mcpcall 的 ensureEnabled）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import { type StandingMount } from './agent-preset-compat';
export type { StandingMount, StandingTree } from './agent-preset-compat';
/** 解析一次并缓存（幂等，可重复 await）。 */
export declare function ensureAgentPresetApi(ctx?: Context): Promise<void>;
/** 诊断快照（/debug standingDiag 用；不参与任何逻辑判断）。 */
declare let diag: {
    apiAvailable: boolean;
    apiError: string | null;
    mountsSeen: number;
    lastPresetIds: string[];
    lastRowCount: number;
};
/** 由 `apply` 早期捕获 standing 挂载（取不到属正常路径：rc.4 会话无挂载时为 undefined）。 */
export declare function captureStandingMount(mount: StandingMount | undefined): void;
/**
 * 全进程所有 preset 的 standing 挂载。
 *
 * 顺序：`livePresetMounts()`（进程级、覆盖全部 preset）→ 捕获的挂载（实例错位兜底）。
 * 两侧都过滤掉没有 tree / tree 无 entries() 的项（防御畸形挂载）。
 */
export declare function standingMounts(): StandingMount[];
/**
 * 在 standing 树里按 serverName 找 MCP 行。先枚举全部 standing 挂载；
 * 空表且给了 agentCtx 时再用 `standingMountFor(agentCtx)` 兜一次
 * （带 agent 的调用方更精确，但不依赖它——RC.4 会话无挂载时为 undefined）。
 * 命中规则与 loader 侧一致（isMcpEntry + serverNameOf），两条路径同语义。
 */
export declare function findStandingEntryByServer(serverName: string, agentCtx?: Context): Entry | undefined;
/** 在 standing 树里按长 entryId 找行（toggleMcp 直传 entryId 时用）。 */
export declare function findStandingEntryById(entryId: string): Entry | undefined;
/** 全部 standing MCP 行（可见性层用：需同时覆盖 open 与 closed 两种行）。 */
export declare function standingMcpEntries(): Entry[];
/**
 * 该 live 行所属 preset 的 id（多 preset 时逐挂载查找 entry.id 命中）。
 *
 * 用途：0.2.0 起 preset 不再有组合文件，state.json 的行来源键由「绝对路径」
 * 退化为 `preset:<id>`（见 preset-mcp.ts 的 `presetKeyOf`），而 live 行本身
 * 只带 entryId —— 需要反查它属于哪个 preset 才能算出同一个键。
 * @param entry - standing 树里的行句柄。
 * @returns preset id；找不到返回 ''。
 */
export declare function presetIdOfEntry(entry: Entry): string;
/** 一行 MCP 的安装态摘要（mcp_search 的「已安装能力表」用）。 */ export interface InstalledMcpRow {
    serverName: string;
    entryId: string;
    /** 用户在面板的开关：true = 开着（模型可见、运行中） */
    open: boolean;
    /** 该行有实例句柄（standing 树里可 resolve） */
    hasEntry: boolean;
}
/**
 * 全部**已安装**的 MCP server（含用户关闭的），供 mcp_search 列能力表。
 *
 * 与 `standingMcpEntries()` 的差别：这里只要"配置里存在这一行"就算已安装，
 * 不要求它有运行实例 —— 这正是 rc.8 语义里「关着的 server 仍应可被检索到」的落点
 * （0.5.7 之前关掉的行既不在 loader 也不在 catalog，模型完全看不到它存在）。
 */
export declare function installedMcpRows(): InstalledMcpRow[];
/**
 * /debug 诊断读数（只读快照，外部改不到内部状态）。
 *
 * `presetApi` 段是 0.7.0 新增：模块解析命中的包名/实例路径/解析基准/失败清单。
 * 「面板 MCP 行为空」的第一嫌疑仍是实例错位（`mounts` 是包内模块私有 Set），
 * 这里直接给出取证面，不要靠猜（判读：`specifier` 为 null 或 `mountsSeen === 0`
 * 而 `capturedMount` 有值 ⇒ 解析到的不是宿主那一份实例）。
 */
export declare function standingDiag(): typeof diag & {
    presetApi: {
        specifier: string | null;
        resolvedPath: string | null;
        base: string;
        errors: string[];
        hasCapturedMount: boolean;
    };
};
