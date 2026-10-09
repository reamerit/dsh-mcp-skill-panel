import type { Context } from '@deepseek-ai/cordis';
import type { McpCallController } from './mcpcall';
/** 单个待生效项（key = entryId）。 */
export interface PendingMcpEntry {
    entryId: string;
    /** 预设组合文件绝对路径（0.2.0 起为 null —— preset 不再落盘）。 */
    file: string | null;
    rowId: string;
    disabled: boolean;
    /**
     * state.json 的行来源键（0.7.0）。有文件时 = 文件路径，否则 = `preset:<id>`。
     * 缺省时由 `applyStateResidue` 按行句柄现算，保证旧队列项也能落对键。
     */
    sourceKey?: string | null;
}
/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
export declare const pendingMcp: Map<string, PendingMcpEntry>;
export interface PendingDeps {
    ctx: Context;
    controller?: McpCallController;
}
/**
 * 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
 * （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
 * 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
 */
export declare function applyPendingMcp(deps: PendingDeps): Promise<number>;
/** 当前待生效项数量（面板/诊断用）。 */
export declare function pendingMcpCount(): number;
