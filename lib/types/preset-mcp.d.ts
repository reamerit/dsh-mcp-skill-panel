/**
 * rc.1 standing 组合 preset 行读取（空面板修复A 0.5.5 + 预设直通 0.5.6，2026-09-08）。
 *
 * 背景：dsh 0.1.2-rc.1 起 preset 行挂在 standing 组合（agent scope 树），不再进
 * `ctx.loader.entries()`（实证 host/agent loader 156 行零 MCP，而
 * `compositionInventory()` 显示 standard-mcp 10 行、filesystem fiberState=2 运行中）。
 * collectMcp 只扫 loader → mcp[]==0 空面板（0.5.5 补行修复）；mcp_call 也因
 * findMcpEntry miss 而报「不在 loader 中」（0.5.6 直通修复见 mcpcall.ts call()）。
 *
 * 本模块只经 `ctx.agentPresets` 服务读数（compositionInventory/resolve/read），
 * 不直连 `livePresetMounts` 模块实例（host 与面板各装一份，模块态不共享），
 * 不产生运行时新依赖（type-only import，tsdown external 无影响）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** preset 文件文本解析出的单行 MCP 配置（key = 短 rowId，如 mcp-filesystem）。
 *
 * P1 直读（2026-09-09）：除 serverName/transport/超时外，追加 dsh-mcp-client
 * 挂载所需的全键（command/args/env/cwd/url/headers/failOnStartupError）。
 * env/headers 的值是**求值后**的最终字符串（`!!js` 在解析时即用 process.env
 * 求值，与 loader 加载时语义一致；失败回落 ''）。transport 缺省时按
 * mcp-convert.ts:108-119 规则推断（有 command→stdio/有 url→http），推断不出
 * 才为 null（兼容旧行为）。
 */
export interface PresetMcpParsed {
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    failOnStartupError?: boolean;
}
/**
 * 解析 preset 组合文本，抽取全部 `mcp-*` 行的 serverName/transport/超时/挂载全键。
 * 纯文本正则（preset 文件结构稳定）：按 `^- id:` 切块，块内抓 serverName/
 * transport/toolCallTimeoutMs/command/args/env/cwd/url/headers/failOnStartupError。
 * 键锚定行首（防注释/长键误命中）；值允许可选双引号（YAML `"stdio"` 形态）。
 * `!!js "..."` 表达式在解析时即求值（process.env 语义，与 loader 一致）。
 * transport 缺省按 mcp-convert.ts:108-119 推断（有 command→stdio/有 url→http）。
 * 纯函数，可被 selftest 直接覆盖。
 */
export declare function parsePresetMcpText(text: string): Map<string, PresetMcpParsed>;
/** standing 组合中的一行 MCP（inventory 行 + preset 文本配置的合并）。
 *
 * P1 直读（2026-09-09）：新增可选 `config`，为该行的 dsh-mcp-client 全量挂载
 * 配置（与 McpServerConfig 形状对齐的子集；`!!js`/`${VAR}` 已在解析时求值）。
 * 旧字段语义不变：disabled/running 仍是 inventory 快照。
 */
export interface PresetMcpRow {
    /** inventory 长 id（含 standing 前缀，如 include:agent-presets:mcp-filesystem）。 */
    entryId: string;
    /** preset 文件内短 id（如 mcp-filesystem；state.json row 键）。 */
    rowId: string;
    serverName: string;
    transport: string | null;
    toolCallTimeoutMs?: number;
    disabled: boolean;
    running: boolean;
    /** preset 组合文件绝对路径（state.json mcp 段的文件键）。 */
    file: string;
    /** 该行的 dsh-mcp-client 全量挂载配置（P1 直读新增；缺省=旧快照行）。 */
    config?: PresetMcpClientConfig;
}
/** dsh-mcp-client 行 config 全量子集（与 mcp-convert.ts McpServerConfig 对齐）。 */
export interface PresetMcpClientConfig {
    serverName: string;
    transport: 'stdio' | 'streamable-http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    toolCallTimeoutMs?: number;
    failOnStartupError?: boolean;
}
/** 由 PresetMcpParsed 组装挂载 config（transport 归一失败/缺失时返回 undefined）。 */
export declare function presetConfigOf(parsed: PresetMcpParsed): PresetMcpClientConfig | undefined;
/**
 * 按 serverName 在某 preset 的 standing 行里定位（mcp_call 预设直调用，0.5.6）。
 * serverName 大小写敏感精确匹配（与 serverNameOf/config.serverName 同语义）；
 * preset 文本缺 serverName 键时按 fallbackServerName 回落（与 listPresetMcpRows
 * 同规则，覆盖 mcp-anki→anki-mcp 例外）。若重复取首行（上游保证唯一）。
 */
export declare function findPresetRowByServerName(ctx: Context, presetId: string, serverName: string, agentCtx?: Context): Promise<PresetMcpRow | undefined>;
/**
 * 列出某 preset 在 standing 组合中的全部 MCP 行（0.7.0 数据源迁移）。
 *
 * **数据源优先级**：
 *   1. live standing 树（`livePresetRows`）—— 0.2.0 起唯一可用面：`resolve().path`
 *      与 `read()` 都已不存在，desktop 的 preset 也不落盘。`entry.options.config`
 *      是 loader 已求值的真值，比旧的正则解析 YAML 更准。
 *   2. preset 文件文本（0.1.x 兼容面）：仅当 `resolve(id).path` 仍存在时才读，
 *      用于补齐 live 树给不出的短 id/transport/超时（web profile 行为不变）。
 *
 * **不再 throw**：拿不到 preset（未挂载 / 不在 compositionInventory / 无文件）
 * 时返回空表 + `presetKey`，由调用方决定怎么显示。0.6.0 的
 * `throw preset "x" has no path` 会把整条 `/state` 打成 500、面板 MCP 页全空。
 */
export declare function listPresetMcpRows(ctx: Context, presetId: string, agentCtx?: Context): Promise<{
    rows: PresetMcpRow[];
    presetPath: string;
    presetKey: string;
}>;
/**
 * 严格版：preset 不可得时**抛错**（"not in compositionInventory" / 文件面读不到文本）。
 *
 * 与 {@link listPresetMcpRows} 的分工：调用方需要区分「preset 不存在」与
 * 「该 preset 恰好没有 MCP 行」时用本函数；面板批量渲染走包装版（不因一个
 * 异常 preset 打空整页）。文件面行为与 0.6.0 逐字节一致，selftest 直接覆盖它。
 */
export declare function listPresetMcpRowsOrThrow(ctx: Context, presetId: string, agentCtx?: Context): Promise<{
    rows: PresetMcpRow[];
    presetPath: string;
}>;
/**
 * live 行 → 面板行（**导出以便 selftest 直接覆盖 0.2.0 数据源**）。
 *
 * 这是 0.7.0 的核心映射：`entry.options.config` 直接就是挂载配置（loader 已求值），
 * 不再经「读 preset 文件文本 + 正则解析 + 自行求值 `!!js`」那条 0.2.0 已删除的链路。
 *
 * ⚠️ 入参用**结构化类型**而非 `preset-live.ts` 的 `LivePresetRow`：一旦引入那个
 * 具名类型，本模块就与 `preset-live` → `standing-rows` → 宿主包链上关系，
 * 而本模块要作为**零宿主依赖独立产物**（`lib/preset-text.js`）被 selftest 直接加载。
 * @param live - live 树行（结构兼容 `preset-live.ts` 的产出）。
 * @param parsed - 可选的文件面解析结果（仅用于补齐 live config 给不出的字段）。
 * @param presetPath - 组合文件路径（0.2.0 起恒为 ''）。
 * @returns 面板行。
 */
export declare function livePresetRowsToRows(live: ReadonlyArray<{
    entryId: string;
    rowId: string;
    config?: PresetMcpClientConfig;
    disabled: boolean;
    running: boolean;
}>, parsed: Map<string, PresetMcpParsed> | undefined, presetPath: string): PresetMcpRow[];
/**
 * state.json `mcp` 段的行来源键。
 *
 * 0.2.0 起 preset 不再有文件路径（`AgentPreset` 无 `path`、`read()` 已删、
 * desktop 的 preset 内联在 `cordis.yml`），故键退化为 preset id。语义未变：
 * 该键只回答「这份行集属于哪个来源」，插件本就是「一个 preset 一棵树」的模型。
 * @param presetId - preset id。
 * @returns `preset:<id>` 形态的稳定键。
 */
export declare function presetKeyOf(presetId: string): string;
/**
 * 按长 entryId 反查其所属 preset 行（toggleMcp 预设兜底用）。
 *
 * 0.7.0：优先在 live standing 树里直接命中该 entryId —— 句柄本身就是行，
 * 不必再经 inventory + `read()` + 正则；只有 live 树不可得时才回落
 * 「逐 preset 扫 compositionInventory + 读 preset 文件」的旧路径。
 */
export declare function findPresetRowByEntryId(ctx: Context, entryId: string, agentCtx?: Context): Promise<{
    presetId: string;
    row: PresetMcpRow;
    presetPath: string;
    presetKey: string;
} | undefined>;
