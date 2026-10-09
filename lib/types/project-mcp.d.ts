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
import type { Context } from '@deepseek-ai/cordis';
import type { McpServers } from './mcp-convert';
/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
export declare function projectServerOwner(serverName: string): string | undefined;
/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
export declare function getActiveWorkspace(): string | null;
/**
 * 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
 * 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
 * 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
 */
export declare function scanWorkspaceMcp(root: string, warn?: (message: string) => void): Promise<McpServers>;
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
export declare function projectServerName(root: string, name: string): string;
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
    assembled: number;
    /** 因 projectOwners 为空而整体放行（快速通道）的次数 */
    bypassed: number;
    /** 最近一次判定的台账（最多 20 条） */
    recent: Array<{
        at: number;
        /** 会话 cwd（= 判定用的 workspace）；undefined 表示没取到 agent/session/cwd */
        workspace: string | null;
        /** 该次装配里被识别为项目 MCP 的 server */
        projectServers: string[];
        /** owner === workspace 的 server（保留） */
        visible: string[];
        /** owner !== workspace 的 server（过滤掉） */
        hidden: string[];
        /** 建表时的 projectOwners 快照 */
        owners: Record<string, string>;
    }>;
    /** 当前 projectOwners 全量（工作区 → 无，仅需要键值对） */
    ownersNow: Record<string, string>;
}
/** 诊断读数（只读快照）。 */
export declare function projectVisibilityDiag(): ProjectVisibilityDiag;
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
export declare function disposeAllWorkspaces(ctx: Context): Promise<void>;
/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
export declare function installProjectMcp(ctx: Context): () => void;
/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
export declare function remountWorkspace(ctx: Context, root: string): Promise<void>;
/**
 * HMR/热重载后从 state.json 反向重建 projectOwners 映射（幂等，已有数据时跳过）。
 *
 * 背景：projectOwners 是模块级内存表，插件 HMR 重载即清空，而 loader 根树上的
 * projmcp-* 行仍然存在 → 期间项目工具短暂按全局展示、项目级禁用作用域错判。
 * state.projectMcp（工作空间 → serverName → 禁用意图）保存了 owner 关系，
 * 以 loader 存活行交叉验证后重建；watcher/entries 由下次 session-start 的
 * ensureWorkspace 完整恢复。
 */
export declare function rebuildOwnersFromState(ctx: Context): Promise<void>;
