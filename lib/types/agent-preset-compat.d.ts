import type { Context } from '@deepseek-ai/cordis';
/** standing 组合的挂载描述（只取本插件用到的字段）。 */
export interface StandingMount {
    presetId?: string;
    tree?: StandingTree;
}
/** standing 组合的 EntryTree（PresetTree extends Include 的公开子集）。 */
export interface StandingTree {
    entries(): Iterable<import('@deepseek-ai/cordis-plugin-loader').Entry>;
    resolve?(id: string): import('@deepseek-ai/cordis-plugin-loader').Entry;
}
/**
 * 本插件用到的 agent-presets 模块读取面。**全部可选**：宿主版本落后
 * （< 0.1.5-rc.2）或解析彻底失败时这些函数不存在，面板整体降级为 0.5.6 行为
 * （可见性不过滤、开关只记意图），不崩。
 */
export interface AgentPresetModuleApi {
    livePresetMounts?: (within?: unknown) => StandingMount[];
    standingMountFor?: (agentCtx: Context) => StandingMount | undefined;
}
/** 解析诊断（/debug standingDiag 展示；不参与任何逻辑判断）。 */
export declare const presetApiDiag: {
    /** 命中的包名；全失败为 null */
    specifier: string | null;
    /** 命中实例的解析路径；用于核对「是不是宿主那一份」 */
    resolvedPath: string | null;
    /** 解析失败清单（每条 "包名: 错误码/消息"） */
    errors: string[];
    /** 解析基准来源：'ctx.baseUrl' | 'self' */
    base: string;
};
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
export declare function standingMountForAgent(agentCtx: Context | undefined): StandingMount | undefined;
/**
 * 解析 agent-presets 模块命名空间（进程级缓存）。
 *
 * 永不抛：全部候选包名都解析失败时返回空对象，并记入 {@link presetApiDiag}。
 * @param ctx - 宿主上下文；提供 `baseUrl` 时优先按其解析，以命中宿主同一模块实例。
 * @returns 模块命名空间（或空对象）。
 */
export declare function resolveAgentPresetApi(ctx?: Context): Promise<AgentPresetModuleApi>;
