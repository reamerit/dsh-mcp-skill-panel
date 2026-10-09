import { a as stateAutoManageByRoute, i as stateApplyMode, l as writeState, n as readState, o as stateMiddleLayerHides, r as setStateAiOwner, s as stateToolBudget, t as clearStateAiOwner } from "./state-Nrn6A6RC.mjs";
import { a as serversToRows, i as serversToPatchYaml, n as parseMcpServersJson, r as resolveServersEnv } from "./mcp-convert-DBh-8vB6.mjs";
import { i as serverNameOf, n as mcpEntryConfig, t as isMcpEntry } from "./mcp-entry-CPGfHQXX.mjs";
import { createRequire } from "node:module";
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { StringDecoder } from "node:string_decoder";
//#region src/catalog.ts
/** 从完整 tool name 解析 server 段（与 src/index.ts serverOf 一致）。 */
function serverOfMcp$1(name) {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
/**
* 从 tools.schemas(scope) 的结果里，按 `mcp__<serverName>__` 前缀抽取该 server
* 的全部工具条目。name 是完整工具 id；参数取原样 JSON Schema。
*/
function snapshotFromSchemas(schemas, serverName) {
	const prefix = `mcp__${serverName}__`;
	const out = [];
	for (const schema of schemas) {
		const name = String(schema?.name ?? "");
		if (!name.startsWith(prefix)) continue;
		out.push({
			name,
			description: String(schema?.description ?? ""),
			parameters: schema?.parameters ?? {}
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
/** 从工具参数 JSON Schema 提取参数名集合（properties 键）。 */
function paramNamesOf(parameters) {
	const names = /* @__PURE__ */ new Set();
	if (parameters && typeof parameters === "object") {
		const props = parameters.properties;
		if (props && typeof props === "object") for (const key of Object.keys(props)) names.add(key.toLowerCase());
	}
	return names;
}
/**
* 关键词全文检索 top-K（P3 网关定稿：加权 B）。
* 打分（bench `.scratch/mvt-5-search-bench.mjs` 实测定稿，加权 B）：
* 工具裸名 substring 15 / server 名 substring 3 / 描述 substring 6 /
* 参数名命中 3 / 公名 haystack（server/bare 拼接）substring 兜底 +1。
* substring 而非 token 精确命中：中文连写（“读文件”）不切分也能命中。
* 返回按分数降序（同分按 server、name 字典序稳定）的命中数组。
*/
function searchCatalog(catalog, query, limit = 8, scopedTo) {
	const terms = String(query).toLowerCase().split(/[\s,，。、/\\|]+/).filter(Boolean);
	if (terms.length === 0) return [];
	const pool = scopedTo !== void 0 ? Object.entries(catalog).filter(([s]) => s === scopedTo) : Object.entries(catalog);
	const scored = [];
	for (const [server, serverInfo] of pool) for (const tool of serverInfo.tools) {
		const bare = tool.name.split("__").pop() ?? tool.name;
		const nameHay = `${server}/${bare}`.toLowerCase();
		const descHay = String(tool.description ?? "").toLowerCase();
		const paramHay = [...paramNamesOf(tool.parameters)].join(" ");
		const serverHay = String(server).toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (bare.toLowerCase().includes(term)) score += 15;
			if (serverHay.includes(term)) score += 3;
			if (descHay.includes(term)) score += 6;
			if (paramHay.includes(term)) score += 3;
			if (nameHay.includes(term)) score += 1;
		}
		if (score > 0) scored.push({
			hit: {
				server,
				tool
			},
			score
		});
	}
	scored.sort((a, b) => b.score - a.score || a.hit.server.localeCompare(b.hit.server) || a.hit.tool.name.localeCompare(b.hit.tool.name));
	const k = Math.max(1, Math.floor(Number(limit) || 1));
	return scored.slice(0, k).map((s) => s.hit);
}
function listServer(catalog, server, offset = 0, limit = 20) {
	const start = Math.max(0, Math.floor(Number(offset) || 0));
	const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
	const serverInfo = catalog[server];
	if (!serverInfo) return {
		found: false,
		hasSnapshot: false,
		tools: [],
		totalCount: 0,
		fetchedAt: null,
		source: null
	};
	const totalCount = serverInfo.tools.length;
	return {
		found: true,
		hasSnapshot: true,
		tools: serverInfo.tools.slice(start, start + size).map((tool) => ({
			name: tool.name,
			description: tool.description
		})),
		totalCount,
		fetchedAt: serverInfo.fetchedAt ?? null,
		source: serverInfo.source ?? null
	};
}
/** catalog 文件路径：<dir>/catalog.json。 */
function catalogFileFor(dir) {
	return `${dir.replace(/[\\/]$/, "")}/catalog.json`;
}
/** 从目录加载 catalog；文件不存在 / 解析失败时返回空 catalog。 */
async function loadCatalog(dir) {
	try {
		const text = await import("node:fs/promises").then((fsp) => fsp.readFile(catalogFileFor(dir), "utf8"));
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}
/** 原子写回 catalog（tmp + rename，0600）。调用方负责 mkdir。 */
async function saveCatalog(dir, catalog) {
	const fsp = await import("node:fs/promises");
	await fsp.mkdir(dir, { recursive: true });
	const file = catalogFileFor(dir);
	const json = JSON.stringify(catalog, null, 2);
	await fsp.writeFile(`${file}.tmp`, json, {
		encoding: "utf8",
		mode: 384
	});
	await fsp.rename(`${file}.tmp`, file);
}
//#endregion
//#region src/util.ts
/** 通用小工具（index / collect / routes 共用）。 */
/** 把未知错误投影为可读字符串（日志与 HTTP 错误响应）。 */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/project-mcp.ts
/** 工作空间根下项目 MCP 的固定目录。 */
const MCPS_DIR = ".dsh/mcps";
/** watcher 去抖窗口（合并文件批量写）。 */
const RESCAN_DEBOUNCE_MS = 200;
/** serverName → 所属工作空间根（仅本项目 MCP 行；全局行不在表内）。 */
const projectOwners = /* @__PURE__ */ new Map();
/** 最近一次会话进入的工作空间（随会话切换更新；面板添加项目 MCP 的目标工作区）。 */
let activeWorkspace = null;
/** 查询某 serverName 是否为本项目 MCP 行及其所属工作空间（collect/面板集成用）。 */
function projectServerOwner(serverName) {
	return projectOwners.get(serverName);
}
/** 最近一次会话进入的工作空间（add project 目标 + 面板展示当前工作区）。 */
function getActiveWorkspace() {
	return activeWorkspace;
}
/** 路径比较：Windows 下忽略大小写（同一路径大小写不同视为同一工作区）。 */
function strEquals$1(a, b, mode) {
	if (typeof b !== "string") return false;
	return mode === "ignorecase" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const workspaces = /* @__PURE__ */ new Map();
async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
/** 递归收集 `dir` 下所有子目录（含 dir 本身）的 mcp.json：根目录文件在前、子目录按路径序。 */
async function collectMcpJsonFiles(dir, out) {
	if (await fileExists(join(dir, "mcp.json"))) out.push(join(dir, "mcp.json"));
	let names = [];
	try {
		names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch {
		return;
	}
	for (const name of names) await collectMcpJsonFiles(join(dir, name), out);
}
/**
* 扫描工作空间的项目 MCP 配置：根目录 mcp.json 优先，子目录覆盖（后写覆盖先写）。
* 目录不存在 → 空。解析错误经 warn 回调上报、跳过该文件。
* 纯文件系统逻辑（不依赖 ctx），可被 selftest 用临时目录覆盖。
*/
async function scanWorkspaceMcp(root, warn) {
	const mcpsDir = join(root, MCPS_DIR);
	if (!await isDirectory(mcpsDir)) return {};
	const files = [];
	await collectMcpJsonFiles(mcpsDir, files);
	const servers = {};
	for (const file of files) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			warn?.(`读取项目 MCP 配置失败 ${file}: ${messageOf$1(error)}`);
			continue;
		}
		const parsed = parseMcpServersJson(text);
		for (const error of parsed.errors) warn?.(`${file}: ${error}`);
		for (const warning of parsed.warnings) warn?.(`${file}: ${warning}`);
		for (const [name, server] of Object.entries(parsed.servers)) servers[name] = server;
	}
	return servers;
}
/** 工作空间根的稳定 id 前缀（djb2 hash，避免跨工作空间 entry id 冲突）。 */
function projectIdPrefix(root) {
	let hash = 5381;
	for (let i = 0; i < root.length; i += 1) hash = (hash << 5) + hash + root.charCodeAt(i) >>> 0;
	return `projmcp-${hash.toString(16).padStart(8, "0")}`;
}
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
function projectServerName(root, name) {
	let hash = 5381;
	for (let i = 0; i < root.length; i += 1) hash = (hash << 5) + hash + root.charCodeAt(i) >>> 0;
	const suffix = `${hash.toString(16).padStart(8, "0")}`;
	return `${name.slice(0, 23)}-${suffix}`;
}
/** 对比配置变化（loader.update 的 diff 需要；JSON 序列化足够判等）。 */
function configChanged(a, b) {
	return JSON.stringify(a) !== JSON.stringify(b);
}
/**
* 项目 MCP 行构建：原始 mcpServers 配置 → dsh-mcp-client 行，
* 并把 serverName 重命名为带路径哈希前缀（不同工作区同名 server 拆成独立实例）。
* entry id 仍由 projectIdPrefix（同样含路径 hash）保证跨工作区唯一，无需重复缀加。
*/
function buildRows(root, servers) {
	const rows = serversToRows(resolveServersEnv(servers), projectIdPrefix(root));
	for (const row of rows) {
		const raw = String(row.config.serverName ?? "");
		row.config.serverName = projectServerName(root, raw);
	}
	return rows;
}
/** 按行集合同步该工作空间已挂载的条目：删多出的、更新变化的、新建缺的。
* 应用 state.json 的 projectMcp 禁用意图（面板开关 → 重启/热更新后保持）。 */
async function syncRows(ctx, state, rows) {
	const wanted = new Map(rows.map((row) => [String(row.config.serverName), row]));
	const stateFile = await readState().catch(() => void 0);
	const intentOf = (serverName) => Boolean(stateFile?.projectMcp?.[state.root]?.[serverName]);
	for (const [serverName, entryId] of [...state.entries]) {
		if (wanted.has(serverName)) continue;
		try {
			await ctx.loader.remove(entryId);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: 卸载项目 MCP "${serverName}" 失败: ${messageOf$1(error)}`);
		}
		state.entries.delete(serverName);
		projectOwners.delete(serverName);
	}
	for (const [serverName, row] of wanted) {
		const existingId = state.entries.get(serverName);
		if (existingId) {
			try {
				const entry = ctx.loader.resolve(existingId);
				const wantDisabled = intentOf(serverName);
				if (entry && (configChanged(entry.options.config, row.config) || Boolean(entry.disabled) !== wantDisabled)) await ctx.loader.update(existingId, {
					...row,
					disabled: wantDisabled
				});
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: 更新项目 MCP "${serverName}" 失败: ${messageOf$1(error)}`);
			}
			continue;
		}
		try {
			await ctx.loader.create({
				...row,
				disabled: intentOf(serverName)
			});
			state.entries.set(serverName, row.id);
			projectOwners.set(serverName, state.root);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: 挂载项目 MCP "${serverName}" 失败: ${messageOf$1(error)}`);
		}
	}
}
/** 卸载某工作空间的全部项目 MCP 条目并停 watcher。 */
async function disposeWorkspace(ctx, root) {
	const state = workspaces.get(root);
	if (!state) return;
	workspaces.delete(root);
	if (state.refreshTimer) clearTimeout(state.refreshTimer);
	state.watcher?.close();
	for (const [serverName, entryId] of [...state.entries]) {
		try {
			await ctx.loader.remove(entryId);
		} catch {}
		projectOwners.delete(serverName);
	}
	state.entries.clear();
}
/** 会话进入工作空间时：无 .dsh/mcps → 卸载；有 → 扫描并按需挂载。
* 记录「最近进入的工作空间」（活动工作区，随会话切换更新）。 */
async function ensureWorkspace(ctx, root) {
	activeWorkspace = root;
	if (!await isDirectory(join(root, MCPS_DIR))) {
		await disposeWorkspace(ctx, root);
		return;
	}
	const rows = buildRows(root, await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`)));
	let state = workspaces.get(root);
	if (!state) {
		state = {
			root,
			entries: /* @__PURE__ */ new Map(),
			watcher: void 0,
			refreshTimer: void 0,
			refreshing: false
		};
		workspaces.set(root, state);
	}
	await syncRows(ctx, state, rows);
	if (!state.watcher) try {
		state.watcher = watch(join(root, MCPS_DIR), { recursive: true }, () => {
			if (state.refreshTimer) clearTimeout(state.refreshTimer);
			state.refreshTimer = setTimeout(() => {
				state.refreshTimer = void 0;
				refresh(ctx, root, state).catch((error) => {
					ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 热更新失败（${root}）: ${messageOf$1(error)}`);
				});
			}, RESCAN_DEBOUNCE_MS);
		});
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: 无法监视 ${join(root, MCPS_DIR)}: ${messageOf$1(error)}`);
	}
}
/** watcher 触发的重扫：配置/目录变化后按新集合同步（热更新）。 */
async function refresh(ctx, root, state) {
	if (state.refreshing) return;
	state.refreshing = true;
	try {
		if (!await isDirectory(join(root, MCPS_DIR))) {
			await disposeWorkspace(ctx, root);
			return;
		}
		await syncRows(ctx, state, buildRows(root, await scanWorkspaceMcp(root, (msg) => ctx.logger.warn?.(`mcp-skill-panel: ${msg}`))));
	} finally {
		state.refreshing = false;
	}
}
/**
* 常开过滤：项目 MCP 工具仅在本工作空间会话的装配结果中可见。
* 非项目 MCP 工具不在此处理（交给 autoManage 的过滤器）。
*/
function installProjectMcpVisibility(ctx) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				if (projectOwners.size === 0) return next();
				const cwd = context?.agent?.session?.header?.cwd;
				const workspace = typeof cwd === "string" ? cwd : null;
				assembly.tools = assembly.tools.filter((tool) => {
					const name = String(tool?.name ?? "");
					if (!name.startsWith("mcp__")) return true;
					const server = serverOfMcp$1(name);
					if (server === null) return true;
					const owner = projectOwners.get(server);
					if (owner === void 0) return true;
					return workspace !== null && strEquals$1(workspace, owner, "ignorecase");
				});
			}
			return next();
		});
	}, "mcp-skill-panel: project mcp visibility");
}
/** 安装项目 MCP 运行时：会话挂载 + 常开过滤。返回整体释放函数。 */
function installProjectMcp(ctx) {
	const disposers = [];
	disposers.push(ctx.effect(() => {
		return ctx.root.on("agent/session-start", (payload) => {
			const cwd = payload?.agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return;
			ensureWorkspace(ctx, cwd).catch((error) => {
				ctx.logger.warn?.(`mcp-skill-panel: 项目 MCP 挂载失败（${cwd}）: ${messageOf$1(error)}`);
			});
		});
	}, "mcp-skill-panel: project mcp session hook"));
	disposers.push(installProjectMcpVisibility(ctx));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** 面板添加/外部修改项目 MCP 文件后，强制重扫该工作空间并同步挂载（幂等）。 */
async function remountWorkspace(ctx, root) {
	await ensureWorkspace(ctx, root);
}
/**
* HMR/热重载后从 state.json 反向重建 projectOwners 映射（幂等，已有数据时跳过）。
*
* 背景：projectOwners 是模块级内存表，插件 HMR 重载即清空，而 loader 根树上的
* projmcp-* 行仍然存在 → 期间项目工具短暂按全局展示、项目级禁用作用域错判。
* state.projectMcp（工作空间 → serverName → 禁用意图）保存了 owner 关系，
* 以 loader 存活行交叉验证后重建；watcher/entries 由下次 session-start 的
* ensureWorkspace 完整恢复。
*/
async function rebuildOwnersFromState(ctx) {
	if (projectOwners.size > 0) return;
	const map = (await readState().catch(() => void 0))?.projectMcp;
	if (!map) return;
	const live = /* @__PURE__ */ new Set();
	for (const entry of ctx.loader.entries()) if (isMcpEntry(entry)) live.add(serverNameOf(entry));
	for (const [workspace, servers] of Object.entries(map)) {
		if (!servers || typeof servers !== "object") continue;
		for (const serverName of Object.keys(servers)) if (live.has(serverName)) projectOwners.set(serverName, workspace);
	}
}
//#endregion
//#region src/tool-disable.ts
/** 全局禁用：serverName → 禁用的工具全名集合（mcp__<server>__<tool>）。 */
const disabledTools = /* @__PURE__ */ new Map();
/** 项目禁用：工作空间 → serverName → 禁用的工具全名集合。 */
const projectDisabledTools = /* @__PURE__ */ new Map();
/** 空集合兜底（避免每次查询分配新 Set）。 */
const EMPTY_SET = /* @__PURE__ */ new Set();
/** 启动/热更新时从 state.json 加载禁用集合（全局 + 项目两张表）。 */
async function loadDisabledTools() {
	disabledTools.clear();
	projectDisabledTools.clear();
	const state = await readState().catch(() => void 0);
	const globalMap = state?.toolDisabled;
	if (globalMap) {
		for (const [server, names] of Object.entries(globalMap)) if (Array.isArray(names)) disabledTools.set(server, new Set(names.filter((n) => typeof n === "string")));
	}
	const projectMap = state?.projectToolDisabled;
	if (projectMap) for (const [workspace, servers] of Object.entries(projectMap)) {
		if (!servers || typeof servers !== "object") continue;
		const perServer = /* @__PURE__ */ new Map();
		for (const [server, names] of Object.entries(servers)) if (Array.isArray(names)) perServer.set(server, new Set(names.filter((n) => typeof n === "string")));
		if (perServer.size > 0) projectDisabledTools.set(workspace, perServer);
	}
}
/** 某 server 的禁用工具集合（面板展示用；workspace=该 server 所属工作区，与 tableKeys 同源）。 */
function disabledToolsOf(serverName, workspace) {
	const owner = projectServerOwner(serverName);
	if (owner !== void 0) {
		const target = workspace ?? owner;
		return projectDisabledTools.get(target)?.get(serverName) ?? EMPTY_SET;
	}
	return disabledTools.get(serverName) ?? EMPTY_SET;
}
/**
* 工具全名是否被禁用（按当前会话工作区判定作用域）：
* - 全局表无条件生效；
* - 项目表只在「会话工作区 === 项目所属工作区」时生效（A 区禁用不影响 B 区）。
* workspace 缺省时仅全局表生效（无会话上下文的冷路径）。
*/
function isToolDisabled(fullName, workspace) {
	const server = serverOfMcp$1(fullName);
	if (server === null) return false;
	const owner = projectServerOwner(server);
	if (owner !== void 0) {
		if (workspace === void 0) return false;
		if (!strEquals(workspace, owner)) return false;
		return projectDisabledTools.get(owner)?.get(server)?.has(fullName) ?? false;
	}
	return disabledTools.get(server)?.has(fullName) ?? false;
}
/**
* 切换某工具禁用状态（面板）：
* - 项目 MCP server（projectServerOwner 有值）→ 写入所属工作区的项目表（仅该区生效）；
* - 全局 MCP server → 写入全局表。
* 同时更新内存 Map + 持久化到 state.json（原子合并写盘）。
* `persist: false`（selftest）只改内存，不动磁盘。
*/
async function setToolDisabled(serverName, fullName, disabled, persist = true) {
	const owner = projectServerOwner(serverName);
	if (owner !== void 0) {
		let perServer = projectDisabledTools.get(owner);
		if (disabled && !perServer) {
			perServer = /* @__PURE__ */ new Map();
			projectDisabledTools.set(owner, perServer);
		}
		if (perServer) {
			toggleInSet(perServer, serverName, fullName, disabled);
			if (perServer.size === 0) projectDisabledTools.delete(owner);
		}
		if (persist) {
			const state = await readState();
			state.projectToolDisabled ??= {};
			const serverMap = state.projectToolDisabled[owner] ??= {};
			toggleInList(serverMap, serverName, fullName, disabled);
			if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner];
			await writeState(state);
		}
	} else {
		toggleInSet(disabledTools, serverName, fullName, disabled);
		if (persist) {
			const state = await readState();
			state.toolDisabled ??= {};
			toggleInList(state.toolDisabled, serverName, fullName, disabled);
			await writeState(state);
		}
	}
}
/**
* 解析 `/mcp/toolBulk` 的 `toolNames` **三态**契约（纯函数，无 IO，可直测）。
*
* - `undefined`（字段缺失）= 该 server 面板视图里的**全部**工具 —— 只有这一种写法表示全部；
* - 显式数组 = 精确集合：`[]` 是合法空操作（targets 为空，调用方据此跳过写盘）；
*   非空则与 known 求交，**一条都不匹配即拒绝**（否则「以为批量禁用了，实际一条没动」）；
* - 其它类型（字符串 / 数字 / 对象 / null / 含非字符串项的数组）= 拒绝：契约是工具全名数组，
*   静默降级成「全部」会把一次客户端 bug 变成该 server 的全量持久化写入。
*
* 2026-09-16 修复（审查 BLOCK-1）：此前「非空数组 ? 交集 : 全部」，显式 `[]` 与任何非数组
* 都落进「全部」——面板「按当前过滤」在过滤命中 0 项时天然发 `[]`，对 450 工具的 server
* 就是一次性全量禁用，与用户意图相反且已写盘。
* @param known - 该 server 当前已知的工具全名（调用方视图，顺序保留）。
* @param toolNames - 客户端原始入参（未收窄，故为 unknown）。
* @returns 精确名单 + 未识别名单，或拒绝原因（调用方转 400）。
*/
function resolveToolBulkTargets(known, toolNames) {
	const knownSet = new Set(known);
	if (toolNames === void 0) return {
		targets: [...known],
		ignored: []
	};
	if (!Array.isArray(toolNames)) return { error: "toolNames must be an array of tool full names" };
	const nonString = toolNames.findIndex((name) => typeof name !== "string");
	if (nonString >= 0) return { error: `toolNames must be an array of tool full names (item ${nonString} is not a string)` };
	const names = [...new Set(toolNames)];
	const nameSet = new Set(names);
	const targets = known.filter((name) => nameSet.has(name));
	const ignored = names.filter((name) => !knownSet.has(name));
	if (names.length > 0 && targets.length === 0) return { error: `toolNames matches none of the ${known.length} known tools on this server (bare names or a stale list?)` };
	return {
		targets,
		ignored
	};
}
/**
* 批量切换某 server 上一组工具的禁用状态（面板「全部禁用 / 全部启用 / 按过滤」）。
*
* 与逐个调用 {@link setToolDisabled} 的区别只在 IO：这里对 state.json 只做
* **一次** 读-改-写。prompthelper 这种 450 工具的 server 逐个写会是 450 次
* 合并写盘 + 450 次面板失效，实际不可用。
*
* 语义与单个开关完全一致（同一张表、同一套项目/全局作用域分派），所以批量与
* 单点操作可以任意交替，不存在「批量模式」这种隐藏状态。
* @param serverName - 目标 MCP server。
* @param toolNames - 工具全名（mcp__<server>__<tool>）列表；非本 server 的条目忽略。
* @param disabled - true=禁用这批，false=启用这批。
* @param persist - false 时只改内存不落盘（selftest）。
* @returns 实际发生变化的工具数。
*/
async function setToolsDisabledBulk(serverName, toolNames, disabled, persist = true) {
	const prefix = `mcp__${serverName}__`;
	const names = [...new Set(toolNames.filter((name) => typeof name === "string" && name.startsWith(prefix)))];
	if (names.length === 0) return 0;
	const owner = projectServerOwner(serverName);
	const before = disabledToolsOf(serverName, owner).size;
	if (owner !== void 0) {
		let perServer = projectDisabledTools.get(owner);
		if (disabled && !perServer) {
			perServer = /* @__PURE__ */ new Map();
			projectDisabledTools.set(owner, perServer);
		}
		if (perServer) {
			for (const name of names) toggleInSet(perServer, serverName, name, disabled);
			if (perServer.size === 0) projectDisabledTools.delete(owner);
		}
		if (persist) {
			const state = await readState();
			state.projectToolDisabled ??= {};
			const serverMap = state.projectToolDisabled[owner] ??= {};
			for (const name of names) toggleInList(serverMap, serverName, name, disabled);
			if (Object.keys(serverMap).length === 0) delete state.projectToolDisabled[owner];
			await writeState(state);
		}
	} else {
		for (const name of names) toggleInSet(disabledTools, serverName, name, disabled);
		if (persist) {
			const state = await readState();
			state.toolDisabled ??= {};
			for (const name of names) toggleInList(state.toolDisabled, serverName, name, disabled);
			await writeState(state);
		}
	}
	return Math.abs(disabledToolsOf(serverName, owner).size - before);
}
/** 内存 Set 表的开关（serverName → Set<fullName>）。 */
function toggleInSet(table, serverName, fullName, disabled) {
	let set = table.get(serverName);
	if (disabled) {
		if (!set) {
			set = /* @__PURE__ */ new Set();
			table.set(serverName, set);
		}
		set.add(fullName);
	} else if (set) {
		set.delete(fullName);
		if (set.size === 0) table.delete(serverName);
	}
}
/** state.json 数组表的开关（serverName → string[]）。 */
function toggleInList(table, serverName, fullName, disabled) {
	const list = table[serverName] ??= [];
	const at = list.indexOf(fullName);
	if (disabled && at < 0) list.push(fullName);
	if (!disabled && at >= 0) list.splice(at, 1);
	if (list.length === 0) delete table[serverName];
}
/** Windows 路径比较忽略大小写（c:\ 与 C:\ 视为同一工作区）。 */
function strEquals(a, b) {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/**
* 常开装配过滤：把用户禁用的 MCP 工具从模型工具目录剔除。
* 项目表按当前会话工作区匹配（context.agent.session.header.cwd），
* 会话工作区不等于项目所属区时该项目工具本就不会挂载可见（由 project-mcp 过滤），
* 这里对全局表无条件生效、对项目表按 owner===cwd 生效。
*/
function installToolDisableFilter(ctx) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				if (disabledTools.size === 0 && projectDisabledTools.size === 0) return next();
				const cwd = context?.agent?.session?.header?.cwd;
				const workspace = typeof cwd === "string" ? cwd : void 0;
				assembly.tools = assembly.tools.filter((tool) => {
					return !isToolDisabled(String(tool?.name ?? ""), workspace);
				});
			}
			return next();
		});
	}, "mcp-skill-panel: tool disable filter");
}
//#endregion
//#region src/mcpcall.ts
/**
* MCP 中间层控制层（P2）：保活启用 → 等注册 → 插件内执行 → 空闲回收。
*
* 模型面恒定 2 个工具：
*   mcp_search —— 检索私有 catalog（能力摘要 / 列表 / top-K 全文检索）
*   mcp_call   —— 保活启用指定 server → 执行工具 → 返回文本结果
*
* 控制层职责：
* - ensureEnabled：从 loader entries 反查 entry，disabled 时 update 开启并记录
*   AI owner（写 state.json 的 ai 段）。
* - waitRegistered：轮询 ctx.tools.get + tools/change 事件加速。
* - call：enable → waitRegistered → ctx.tools.execute。失败时若本次 AI 启用且
*   无并发则恢复 disabled 并清 owner。
* - 引用计数（Map<serverName, number>）+ 空闲回收器（ctx.interval 每 10s 扫描）。
*/
/** 空闲回收器扫描周期（ms）。 */
const REAPER_INTERVAL_MS = 1e4;
/** waitRegistered 轮询间隔（ms）。 */
const REGISTER_POLL_MS = 50;
/**
* 中间层两个模型工具的注册名。
*
* 命名前缀铁律（2026-09-15，claude 400 取证）：**不得以 `mcp_` 开头**。
* 实测 claude.ai 订阅网关把 `mcp_` 前缀的工具名当作 MCP connector 保留名，
* 整个请求被拒为 HTTP 400 `invalid_request_error`，且错误文案被改写成
* 「You're out of extra usage」（与配额无关，极具误导性）。
* 证据：同一会话 16 秒内 486 工具（含本组）→400、484 工具（不含）→正常、
* 486 →400；32 工具的最小集同样复现，与工具数量/体积无关。
* 全部 session 统计：含本组 0/5 成功，不含本组 111/111 成功。
*/
const MCP_SEARCH_TOOL = "dsh_mcp_search";
const MCP_CALL_TOOL = "dsh_mcp_call";
/** 两个控制工具的名字集合（装配过滤按模型路由决定是否投放）。 */
const CONTROL_TOOL_NAMES = /* @__PURE__ */ new Set([MCP_SEARCH_TOOL, MCP_CALL_TOOL]);
/**
* 归一化 mcp_call 的 tool 参数（2026-08-22 修补）：模型可能把 mcp_search 返回的
* 注册全名（mcp__<server>__<tool>）直接填入 tool，无条件拼接会生成双重前缀。
* 规则：以 mcp__ 开头视为注册全名形态 → 循环剥离本 server 前缀（兼容嵌套重复）；
* 剥完仍以 mcp__ 开头 → 传的是其他 server 的注册全名或格式异常 → 快速失败
* （避免在 waitRegistered 白等满 toolCallTimeoutMs，默认 60s、mimo-image 300s）。
* 注：远端工具裸名恰好以 mcp__ 开头属生态外的病态命名，会被误判，可接受。
*/
function normalizeToolName(serverName, toolName) {
	const prefix = `mcp__${serverName}__`;
	let name = toolName;
	if (name.startsWith("mcp__")) {
		while (name.startsWith(prefix)) name = name.slice(prefix.length);
		if (name.startsWith("mcp__")) throw new Error(`${MCP_CALL_TOOL}: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名（如 understand_image，不带 mcp__ 前缀）`);
	}
	return name;
}
/**
* 归一化 mcp_call 的 arguments 参数（2026-08-24 修补；2026-09-16 注释修正，审查 WARN-4）：
* 起因是 `type:'json'` 参数的编译产物不带 type 标注，模型直连 Tool call 时倾向把参数字典
* 填成 JSON 字符串（实测 flash 与 mimo 两系均会出现）。**该起因已消失**：参数自 2026-09-16
* （0f4794a）起改 `type:'object' + additionalProperties`，字符串在进 execute 前即被参数校验拒绝，
* 模型路径到不了这里 —— 本函数现在只服务**直调/内部路径**（gatewayCall 等）的兜底。
* 这里循环安全解析为对象后再透传：
* - 值以 { / [ 开头 → 直接按容器 JSON 解析；
* - 值以 " 开头（引号包裹层）→ 解包后若内层仍是容器形态才继续剥，防止误改合法标量入参；
* - 解析失败或非字典形态 → 保留原值交由远端给出可读错误。
*/
function normalizeArguments(raw) {
	let value = raw ?? {};
	let depth = 0;
	while (typeof value === "string" && depth < 4) {
		const trimmed = value.trim();
		if (trimmed.length === 0) return {};
		const head = trimmed.charCodeAt(0);
		const isContainerJson = head === 123 || head === 91;
		const isQuotedJson = head === 34;
		if (!isContainerJson && !isQuotedJson) break;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			break;
		}
		if (parsed !== null && typeof parsed === "object") return parsed;
		const inner = typeof parsed === "string" ? parsed.trim() : "";
		const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
		if (!isQuotedJson || !innerLooksContainer) break;
		value = parsed;
		depth++;
	}
	return value;
}
function msgOf(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") try {
		const text = JSON.stringify(error);
		if (typeof text === "string" && text.length > 0) return text;
	} catch {}
	return String(error);
}
/** 从 execute 结果的 content 块抽取文本（防御式）。 */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block && typeof block === "object") {
		const b = block;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n").trim();
}
/**
* 组装候选工具视图（2026-08-24 scope 回归第二版修复）：dsh-tools 注册表的
* scope 约定是「agent 对象」而非 `scopeOf(agent.ctx)` 的 ctx 标签——模型面的
* schemas(exec.agent) / 执行面 get(name, agent) 均以 agent 对象为钥匙建立层级链，
* session-boundary 下 MCP 工具注册进该链可达的作用域层；而旧实现用 scopeOf(agent.ctx)
* 查询同一注册表，链条不达 → 全部「未在超时内注册」。现改为直接以 agent 对象为
* 作用域钥匙，与模型面/执行面完全同构；无 agent 时退回全局视图。
*/
function collectToolViews(ctx, agent) {
	const views = [];
	if (agent) views.push({
		label: "agent-object",
		tools: ctx.tools,
		scope: agent
	});
	views.push({
		label: "host-global",
		tools: ctx.tools,
		scope: void 0
	});
	return views;
}
async function ensureEnabled(control, ctx, state, serverName, entry) {
	const wasDisabled = entry.disabled;
	const entryId = entry.id;
	if (wasDisabled) {
		counters().wakeAdded += 1;
		await entry.update({ disabled: false });
		state.aiEnabled.add(serverName);
		await control.setAiOwner(entryId, Date.now());
		ctx.logger.info?.(`mcp-skill-panel: AI enabled MCP server "${serverName}"`);
	} else counters().wakeSkippedAlreadyEnabled += 1;
	return wasDisabled;
}
/**
* 0.6.0：按需采集某个「已安装但没有快照」server 的能力表。
*
* 使用场景：用户在面板关掉了某个 MCP，它从未运行过 → catalog 里没有它 →
* `mcp_search(server=X)` 原本只能回 `found:false`（P1 实验失败的现场）。
* 这里把它**临时拉起**（复用 `ensureEnabled`：真连接、真注册工具、登记 AI 归属）、
* 等工具注册后采一次 schema 快照写进 catalog，再**显式放回关闭**
* （不等回收器：搜索结果返回时它就该回到用户设定的状态）。
*
* 失败缓存（TTL 5 分钟）：server 起不来时避免模型每次搜索都卡满超时。
* 返回 null 表示"没采到"（未挂载 / 无工具 / 失败），调用方按无快照文案回。
*/
const INVENTORY_FAIL_TTL_MS = 3e5;
const inventoryFailUntil = /* @__PURE__ */ new Map();
const inventoryTrace = /* @__PURE__ */ new Map();
function inventoryTraceDiag() {
	const out = {};
	for (const [server, row] of inventoryTrace) out[server] = {
		...row,
		agoMs: Date.now() - row.at
	};
	return out;
}
async function collectInventory(ctx, caches, state, serverName, requestedBy = "unknown", waitMs) {
	const t0 = Date.now();
	const trace = {
		at: t0,
		requestedBy,
		stage: "start",
		ms: 0,
		entryFound: null,
		wasDisabled: null,
		wakeAdded: null,
		viewLabel: null,
		viewScope: null,
		schemaTotal: null,
		schemaMatched: null,
		stored: null,
		error: null
	};
	inventoryTrace.set(serverName, trace);
	const mark = (stage) => {
		trace.stage = stage;
		trace.ms = Date.now() - t0;
	};
	const stop = (stage, error) => {
		mark(stage);
		trace.error = error;
		return null;
	};
	const until = inventoryFailUntil.get(serverName) ?? 0;
	if (Date.now() < until) return stop("skip:failCache", `retry after ${Math.ceil((until - Date.now()) / 1e3)}s`);
	const entry = caches.resolveEntry(serverName);
	trace.entryFound = entry !== void 0;
	if (!entry) return stop("resolveEntry:none", "no entry for server");
	const wasDisabled = entry.disabled === true;
	trace.wasDisabled = wasDisabled;
	const entryId = String(entry.id);
	let aiOwned = false;
	try {
		aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry);
		trace.wakeAdded = aiOwned;
		mark("ensureEnabled");
	} catch (error) {
		inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
		ctx.logger.warn?.(`mcp-skill-panel: inventory fetch enable "${serverName}" failed: ${msgOf(error)}`);
		return stop("ensureEnabled:ERR", msgOf(error));
	}
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	let out = null;
	try {
		mark("ensureEnabled → 等待 catalog 出现该 server（由 snapshotEnabled 采集）");
		const deadline = Date.now() + (waitMs !== void 0 && waitMs > 0 ? waitMs : caches.serverTimeoutMs(serverName));
		let waited = 0;
		for (;;) {
			await ctx.timeout(600);
			const snap = caches.getCatalog()[serverName];
			if (snap && snap.tools.length > 0) {
				out = {
					tools: snap.tools.length,
					joined: false
				};
				trace.stored = out.tools;
				break;
			}
			if (Date.now() >= deadline || waited > 80) break;
			await caches.requestSnapshot?.();
			waited += 1;
		}
		mark(`catalogWait(n=${out?.tools ?? 0}, polls=${waited})`);
		if (!out) {
			inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
			stop("timeout", `catalog 未在 ${Date.now() - t0}ms 内出现 "${serverName}"（snapshotEnabled 未采到）`);
		}
	} catch (error) {
		inventoryFailUntil.set(serverName, Date.now() + INVENTORY_FAIL_TTL_MS);
		ctx.logger.warn?.(`mcp-skill-panel: inventory fetch "${serverName}" failed: ${msgOf(error)}`);
		stop("collect:ERR", msgOf(error));
	} finally {
		mark("done");
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
		if (wasDisabled && aiOwned && next <= 0) try {
			const cur = caches.resolveEntry(serverName);
			if (cur && cur.id === entryId && !cur.disabled) await cur.update({ disabled: true });
			await caches.clearAiOwner(entryId).catch(() => void 0);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: inventory fetch restore "${serverName}" failed: ${msgOf(error)}`);
		} finally {
			state.aiEnabled.delete(serverName);
			state.refCounts.delete(serverName);
			state.lastUsed.delete(serverName);
		}
	}
	return out;
}
async function waitRegistered(ctx, name, views, timeoutMs, signal) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer;
		let offTools;
		let offAbort;
		let offDispose;
		const onAbort = () => finish(/* @__PURE__ */ new Error("aborted"));
		const finish = (error, view) => {
			if (settled) return;
			settled = true;
			pollTimer?.();
			offTools?.();
			offAbort?.();
			offDispose?.();
			if (error) reject(error);
			else resolve(view);
		};
		const check = () => {
			if (settled) return;
			for (const view of views) {
				if (!view.tools) continue;
				try {
					const schemasOf = view.tools;
					if (name.endsWith("__") ? (schemasOf.schemas?.(view.scope) ?? []).some((s) => String(s?.name ?? "").startsWith(name)) : Boolean(view.tools.get(name, view.scope))) {
						ctx.logger.info?.(`mcp-skill-panel: tool "${name}" resolved via view "${view.label}"`);
						return finish(void 0, view);
					}
				} catch {}
			}
			if (Date.now() - start >= timeoutMs) return finish(/* @__PURE__ */ new Error(`tool "${name}" 未在 ${timeoutMs}ms 内注册`));
			pollTimer = ctx.timeout(check, REGISTER_POLL_MS);
		};
		offTools = ctx.root.on("tools/change", () => check());
		offDispose = ctx.effect(() => () => finish(/* @__PURE__ */ new Error("context disposed")), "mcp-skill-panel: waitRegistered");
		if (signal) {
			if (signal.aborted) {
				finish(/* @__PURE__ */ new Error("aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			offAbort = () => signal.removeEventListener("abort", onAbort);
		}
		check();
	});
}
/**
* 预设行直通执行（0.5.6）：已启用 standing 行的工具已在 tools 注册表 scope 层
* （mcp-client 注册），无需 ensureEnabled。引用计数/lastUsed 照常记（回收器
* startIdleReaper 经 resolveEntry 找不到预设行 entry 时仅清内存态，不碰运行时，
* 见 mcpcall.ts:394-400 无 entry 分支）。失败不 restore（无 Entry 可恢复；
* 预设行开关走面板 state.json 意图，不由单次调用翻转）。
*/
async function callViaPresetViews(ctx, control, state, serverName, bareTool, name, args, agent, signal, explicitTimeoutMs) {
	const timeoutMs = explicitTimeoutMs ?? control.serverTimeoutMs(serverName);
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	try {
		const result = await (await waitRegistered(ctx, name, collectToolViews(ctx, agent), timeoutMs, signal)).tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: args,
			agent,
			signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) return `MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`;
		const text = contentText(result ? result.content : void 0);
		return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`;
	} catch (error) {
		return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 ${MCP_SEARCH_TOOL} 确认）`;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
	}
}
async function gatewayCall(ctx, control, state, serverName, bareIn, args, opts) {
	const bareTool = normalizeToolName(serverName, bareIn);
	const name = `mcp__${serverName}__${bareTool}`;
	const normArgs = normalizeArguments(args);
	if (isToolDisabled(name, typeof opts.agent?.session?.header?.cwd === "string" ? opts.agent.session.header.cwd : void 0)) throw new Error(`MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`);
	const entry = control.resolveEntry(serverName);
	if (entry) return callViaLoaderEntry(ctx, control, state, serverName, bareTool, name, normArgs, opts, entry);
	const presetRow = control.resolvePresetRow ? await control.resolvePresetRow(serverName, opts.agent).catch(() => void 0) : void 0;
	if (!presetRow) throw new Error(`未知 MCP server：${serverName}（不在 loader 中）`);
	if (presetRow.disabled) throw new Error(`MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`);
	const timeoutMs = opts.explicitTimeoutMs ?? presetRow.toolCallTimeoutMs ?? control.serverTimeoutMs(serverName);
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	try {
		const view = await waitRegistered(ctx, name, collectToolViews(ctx, opts.agent), timeoutMs, opts.signal);
		if (opts.signal.aborted) throw opts.signal.reason ?? /* @__PURE__ */ new Error("aborted");
		const result = await view.tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: normArgs,
			agent: opts.agent,
			signal: opts.signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) {
			const failure = /* @__PURE__ */ new Error(`MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`);
			failure.cause = result;
			throw failure;
		}
		const text = contentText(result ? result.content : void 0);
		if (text.length === 0) throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`);
		return text;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
	}
}
/**
* B1（P5）：loader 常驻行执行分支（项目行/global 行/网关 gw- 行）。
* 与 call() 的 loader 分支同语义但错误走 throw：ensureEnabled 开启→执行→
* 失败且本次 AI 启用且无并发则 restore。超时=loader 行 toolCallTimeoutMs。
*/
async function callViaLoaderEntry(ctx, control, state, serverName, bareTool, name, normArgs, opts, entry) {
	const entryId = entry.id;
	const timeoutMs = opts.explicitTimeoutMs ?? control.serverTimeoutMs(serverName);
	let aiOwned = false;
	try {
		aiOwned = await ensureEnabledGateway(control, ctx, state, serverName, entry);
	} catch (error) {
		throw new Error(`启用 MCP server "${serverName}" 失败：${msgOf(error)}`);
	}
	state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
	state.lastUsed.set(serverName, Date.now());
	let failed = false;
	try {
		const view = await waitRegistered(ctx, name, collectToolViews(ctx, opts.agent), timeoutMs, opts.signal);
		if (opts.signal.aborted) throw opts.signal.reason ?? /* @__PURE__ */ new Error("aborted");
		const result = await view.tools.execute({
			callId: `mcp-call-${randomUUID()}`,
			name,
			arguments: normArgs,
			agent: opts.agent,
			signal: opts.signal
		});
		state.lastUsed.set(serverName, Date.now());
		if (result && result.isError) {
			failed = true;
			const failure = /* @__PURE__ */ new Error(`MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`);
			failure.cause = result;
			throw failure;
		}
		const text = contentText(result ? result.content : void 0);
		if (text.length === 0) {
			failed = true;
			throw new Error(`MCP ${serverName}.${bareTool} 无返回内容`);
		}
		return text;
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		const next = (state.refCounts.get(serverName) ?? 1) - 1;
		if (next <= 0) state.refCounts.delete(serverName);
		else state.refCounts.set(serverName, next);
		if (failed && aiOwned && next <= 0) restoreGateway(control, ctx, state, serverName, entryId);
	}
}
/**
* gateway 透传分支的 ensureEnabled（0.5.9 修正）。
*
* 历史 bug（0.5.7/0.5.8 实测现场）：本函数原样**不碰 `state.aiEnabled`**，注释理由是
* 「网关行用户语义恒用户打开」。但 0.5.6 起 `mcp_call` 已改道 gateway 透传
* （见 registerMcpCallTool），于是 preset 行被 AI 拉起的每一次调用都落在这里 →
* 「行被真拉起、工具真执行」与「回收器集合永远为空、永不回收」同时成立。
* 实测指纹：`mcp_call` 未知 server 返回 `MCP 调用异常：未知 MCP server：…（不在 loader 中）`
* ——带 `MCP 调用异常：` 前缀即证明走的是 gatewayCall（`call()` 分支无此前缀），
* 而此时 `controller.status().aiOwned` 为空、回收器 `candidates` 为空。
*
* 现在统一到 `state.aiEnabled`：AI 借用的行用完即关；失败走 restoreGateway 立即回关。
* 用户自己打开的行不会进集合（见 markUserEnabled），语义不变。
*/
async function ensureEnabledGateway(control, ctx, state, serverName, entry) {
	if (!entry.disabled) {
		counters().wakeSkippedAlreadyEnabled += 1;
		return false;
	}
	counters().wakeAdded += 1;
	await entry.update({ disabled: false });
	state.aiEnabled.add(serverName);
	await control.setAiOwner(entry.id, Date.now()).catch(() => void 0);
	ctx.logger.info?.(`mcp-skill-panel: gateway enabled MCP server "${serverName}"`);
	return true;
}
/**
* gateway 分支的失败恢复（best-effort；失败即回关，不留半开）。
* 0.5.9：同时清 `state.aiEnabled`/refCounts/lastUsed —— 否则回关后回收器下一轮
* 仍把这个 server 当候选，`idleMs` 因 lastUsed 已被删而变成 `now-0` 的巨值，
* 每轮白扫一次（无害但噪声）。调用方保证此时 refCount 已归零。
*/
async function restoreGateway(control, ctx, state, serverName, entryId) {
	if (!state.aiEnabled.has(serverName)) {
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
		return;
	}
	try {
		const entry = control.resolveEntry(serverName);
		if (entry && entry.id === entryId && !entry.disabled) await entry.update({ disabled: true });
		await control.clearAiOwner(entryId).catch(() => void 0);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: gateway restore disabled for "${serverName}" failed: ${msgOf(error)}`);
	} finally {
		state.aiEnabled.delete(serverName);
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
	}
}
/** 失败 / 无并发时恢复原状态：禁用并清 AI owner。 */
async function restore(control, ctx, state, serverName, entryId) {
	if (!state.aiEnabled.has(serverName)) {
		state.refCounts.delete(serverName);
		state.lastUsed.delete(serverName);
		return;
	}
	try {
		const entry = control.resolveEntry(serverName);
		if (entry && entry.id === entryId && !entry.disabled) await entry.update({ disabled: true });
		await control.clearAiOwner(entryId);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: restore disabled for "${serverName}" failed: ${msgOf(error)}`);
	} finally {
		state.aiEnabled.delete(serverName);
		state.lastUsed.delete(serverName);
		state.refCounts.delete(serverName);
	}
}
let reaperDiag = {
	rounds: 0,
	lastRound: null,
	everDisabled: []
};
const COUNTER_KEY = "__dshMcpPanelControllerCounters__";
function counters() {
	const g = globalThis;
	let c = g[COUNTER_KEY];
	if (!c) {
		c = {
			controllers: 0,
			callResolvedEntry: 0,
			callNoEntry: 0,
			callPresetBranch: 0,
			wakeAdded: 0,
			wakeSkippedAlreadyEnabled: 0,
			clearedByUser: 0,
			reaped: 0,
			reaperDroppedNoEntry: 0
		};
		g[COUNTER_KEY] = c;
	}
	return c;
}
/** /debug 用：分支决策计数快照。 */
function controllerCounters() {
	return { ...counters() };
}
/** 供 /debug 读取（每次刷新 agoMs，不参与逻辑判断）。 */
function reaperDiagnostics() {
	return {
		rounds: reaperDiag.rounds,
		lastRound: reaperDiag.lastRound,
		everDisabled: [...reaperDiag.everDisabled],
		agoMs: reaperDiag.lastRound ? Date.now() - reaperDiag.lastRound.at : null
	};
}
function startIdleReaper(control, ctx, state) {
	return ctx.interval(() => {
		const now = Date.now();
		const keepAliveMs = control.keepAliveMs;
		const decisions = [];
		for (const server of [...state.aiEnabled]) {
			const refCount = state.refCounts.get(server) ?? 0;
			const last = state.lastUsed.get(server) ?? 0;
			if (refCount > 0) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "skip:refCount"
				});
				continue;
			}
			if (now - last < keepAliveMs) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "skip:keepAlive"
				});
				continue;
			}
			const entry = control.resolveEntry(server);
			if (!entry) {
				decisions.push({
					server,
					refCount,
					idleMs: now - last,
					action: "drop:noEntry"
				});
				counters().reaperDroppedNoEntry += 1;
				state.aiEnabled.delete(server);
				state.refCounts.delete(server);
				state.lastUsed.delete(server);
				continue;
			}
			const entryId = entry.id;
			decisions.push({
				server,
				refCount,
				idleMs: now - last,
				action: "reap"
			});
			(async () => {
				try {
					if (!entry.disabled) await entry.update({ disabled: true });
					if ((state.refCounts.get(server) ?? 0) > 0) return;
					await control.clearAiOwner(entryId);
					if (!reaperDiag.everDisabled.includes(server)) reaperDiag.everDisabled.push(server);
					counters().reaped += 1;
					ctx.logger.info?.(`mcp-skill-panel: idle-reaped MCP server "${server}"`);
				} catch (error) {
					ctx.logger.warn?.(`mcp-skill-panel: idle reaper disable "${server}" failed: ${msgOf(error)}`);
				} finally {
					if ((state.refCounts.get(server) ?? 0) === 0) {
						state.aiEnabled.delete(server);
						state.refCounts.delete(server);
						state.lastUsed.delete(server);
					}
				}
			})();
		}
		reaperDiag = {
			...reaperDiag,
			rounds: reaperDiag.rounds + 1,
			lastRound: {
				at: now,
				keepAliveMs,
				candidates: [...state.aiEnabled],
				decisions
			}
		};
	}, REAPER_INTERVAL_MS);
}
/**
* 创建控制层控制器。`caches` 即控制层依赖（McpControlCtx），由 index.ts
* 在 apply 里构建并封闭所有 IO。
*/
function createMcpCallController(ctx, caches) {
	counters().controllers += 1;
	const state = {
		refCounts: /* @__PURE__ */ new Map(),
		lastUsed: /* @__PURE__ */ new Map(),
		aiEnabled: /* @__PURE__ */ new Set()
	};
	return {
		/**
		* 网关透传入口（P2）：与 call() 同控制器共享引用计数态（state），但错误
		* 走 throw（gatewayCall），不进恒文本 call()。controller 外透出供网关
		* own 层双工具复用；call() 原行为不动。
		*/
		async gateway(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			return gatewayCall(ctx, caches, state, serverName, toolName, args, {
				signal,
				agent,
				explicitTimeoutMs
			});
		},
		async ensureEnabled(serverName) {
			const entry = caches.resolveEntry(serverName);
			if (!entry) throw new Error(`unknown MCP server "${serverName}"`);
			return ensureEnabled(caches, ctx, state, serverName, entry);
		},
		isAiEnabled(serverName) {
			return state.aiEnabled.has(serverName);
		},
		markUserEnabled(serverName) {
			state.aiEnabled.delete(serverName);
			state.refCounts.delete(serverName);
			state.lastUsed.delete(serverName);
			const entry = caches.resolveEntry(serverName);
			if (entry) caches.clearAiOwner(entry.id);
		},
		async fetchInventory(serverName, waitMs) {
			return collectInventory(ctx, caches, state, serverName, MCP_SEARCH_TOOL, waitMs);
		},
		async call(serverName, toolName, args, agent, signal, explicitTimeoutMs) {
			const bareTool = normalizeToolName(serverName, toolName);
			const name = `mcp__${serverName}__${bareTool}`;
			if (isToolDisabled(name, typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : void 0)) return `MCP 工具 ${serverName}.${bareTool} 已被禁用（请在 MCP 管理面板打开该工具后再调用）`;
			const entry = caches.resolveEntry(serverName);
			if (!entry) {
				counters().callNoEntry += 1;
				const presetRow = caches.resolvePresetRow ? await caches.resolvePresetRow(serverName, agent).catch(() => void 0) : void 0;
				if (presetRow) {
					if (presetRow.disabled) return `MCP server "${serverName}" 当前已停用（预设行 ${presetRow.rowId}），请在 MCP 管理面板打开后（新会话生效）再调用`;
					const presetTimeout = presetRow.toolCallTimeoutMs;
					const hint = presetRow.running ? "" : "（提示：该行已启用但实例暂未运行，若持续超时请在面板确认后重试）";
					const out = await callViaPresetViews(ctx, caches, state, serverName, bareTool, name, args, agent, signal, explicitTimeoutMs ?? presetTimeout);
					return out.startsWith(`MCP ${serverName}.${bareTool} 调用异常`) && hint ? `${out}${hint}` : out;
				}
				return `未知 MCP server：${serverName}（不在 loader 中）`;
			}
			const entryId = entry.id;
			counters().callResolvedEntry += 1;
			const presetTimeout = caches.presetTimeoutMs ? await caches.presetTimeoutMs(serverName).catch(() => void 0) : void 0;
			const timeoutMs = explicitTimeoutMs ?? presetTimeout ?? caches.serverTimeoutMs(serverName);
			let aiOwned = false;
			try {
				aiOwned = await ensureEnabled(caches, ctx, state, serverName, entry);
			} catch (error) {
				return `启用 MCP server "${serverName}" 失败：${msgOf(error)}`;
			}
			state.refCounts.set(serverName, (state.refCounts.get(serverName) ?? 0) + 1);
			state.lastUsed.set(serverName, Date.now());
			let failed = false;
			try {
				const result = await (await waitRegistered(ctx, name, collectToolViews(ctx, agent), timeoutMs, signal)).tools.execute({
					callId: `mcp-call-${randomUUID()}`,
					name,
					arguments: args,
					agent,
					signal
				});
				state.lastUsed.set(serverName, Date.now());
				if (result && result.isError) {
					failed = true;
					return `MCP ${serverName}.${bareTool} 调用失败：${msgOf(result.error ?? "unknown error")}`;
				}
				const text = contentText(result ? result.content : void 0);
				return text.length > 0 ? text : `MCP ${serverName}.${bareTool} 无返回内容`;
			} catch (error) {
				failed = true;
				return `MCP ${serverName}.${bareTool} 调用异常：${msgOf(error)}（提示：tool 参数应传该 server 上的裸名；server/tool 是否存在可先 ${MCP_SEARCH_TOOL} 确认）`;
			} finally {
				const next = (state.refCounts.get(serverName) ?? 1) - 1;
				if (next <= 0) state.refCounts.delete(serverName);
				else state.refCounts.set(serverName, next);
				if (failed && aiOwned && next <= 0) restore(caches, ctx, state, serverName, entryId);
			}
		},
		startIdleReaper() {
			return startIdleReaper(caches, ctx, state);
		},
		status() {
			const out = [];
			for (const server of state.aiEnabled) out.push({
				server,
				refCount: state.refCounts.get(server) ?? 0,
				lastUsed: state.lastUsed.get(server) ?? 0
			});
			out.sort((a, b) => a.server.localeCompare(b.server));
			return out;
		}
	};
}
function clampLimit(value, defaultValue, max) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return defaultValue;
	return Math.min(Math.floor(value), max);
}
/** 摘要截断长度：mcp_search 空查询的输出 token 控制（P2-5）。 */
const SUMMARY_MAX_LEN = 80;
/**
* mcp_search 空查询的 server 清单（0.6.0 重写为「**已安装**」而非「在跑的」）。
*
* 关键修复动机（P1 实验实测）：原实现只遍历 catalog，而 catalog 只对**运行过的**
* 行采快照 → 用户关掉且从未运行过的 server 既不在 catalog、又不在 loader，
* 于是模型**完全不知道它存在**，「关着的 server 可被按需拉起」这条 rc.8 语义落空。
*
* 现在的数据源是「已安装行（standing 树，含关闭行）∪ catalog ∪ Config.serverSummary」：
* - 已安装行给出权威的开关状态（open/closed）；
* - 摘要优先取 `serverSummary` 配置，其次 catalog 里第一个工具的描述（截断）；
* - 无快照的行显式标注「无工具快照，首次按需调用时会自动拉起采集」。
*/
function buildSummary(control) {
	const catalog = control.getCatalog();
	const installed = /* @__PURE__ */ new Map();
	for (const row of control.installedInventory?.() ?? []) installed.set(row.server, row.open);
	const servers = /* @__PURE__ */ new Set([
		...installed.keys(),
		...Object.keys(catalog),
		...Object.keys(control.serverSummary)
	]);
	const lines = [];
	for (const server of servers) {
		const snap = catalog[server];
		const tools = snap ? snap.tools.length : null;
		const configured = control.serverSummary[server];
		let summary;
		if (configured !== void 0) summary = configured;
		else if (tools && tools > 0) {
			const raw = String(snap?.tools?.[0]?.description ?? "MCP server");
			summary = raw.length > SUMMARY_MAX_LEN ? `${raw.slice(0, SUMMARY_MAX_LEN)}…` : raw;
		} else summary = "（无工具快照：首次按需调用时会自动拉起并采集）";
		lines.push({
			server,
			summary,
			open: installed.get(server) ?? true,
			tools
		});
	}
	lines.sort((a, b) => Number(b.open) - Number(a.open) || a.server.localeCompare(b.server));
	return lines;
}
/**
* 空查（能力摘要表）的首行文案 —— 必须与本次装配的**实际可见性**同口径（G3）。
*
* - `hidesAll=false`（隐藏范围 = 仅手动停用）：手动启用的 server 确实对模型可见，
*   旧文案成立；
* - `hidesAll=true`（隐藏范围 = 全部）：命中中间层的模型一个 mcp__ 工具都拿不到，
*   此时 `[开]` 只表示「server 已挂载在跑」，**不代表对模型可见**。旧文案在这里
*   直接说谎（评审风险 7），故换口径。
*
* 抽成纯函数只为 selftest 能直接断言这条文案契约（不留「改完没人守」的窗口）。
* @param total - 已安装 server 数。
* @param openCount - 其中处于打开（已挂载）状态的数量。
* @param hidesAll - 中间层隐藏范围是否为 'all'。
*/
function buildSummaryHeader(total, openCount, hidesAll) {
	if (hidesAll) return `已安装 ${total} 个 MCP server（本会话的中间层隐藏范围=全部：MCP 工具一律不直连模型，全部经 ${MCP_SEARCH_TOOL} 检索 + ${MCP_CALL_TOOL} 按需取用；下表 [开]/[关] 只表示 server 是否已挂载在跑，与模型可见性无关 —— ${total} 个都可经 ${MCP_CALL_TOOL} 按需临时拉起）。`;
	return `已安装 ${total} 个 MCP server（${openCount} 个已打开并对模型可见，${total - openCount} 个已关闭——关闭的对模型不可见，但可经 ${MCP_CALL_TOOL} 按需临时拉起）。`;
}
function registerMcpSearchTool(ctx, control, controller) {
	const definition = defineTool({
		name: MCP_SEARCH_TOOL,
		description: `检索可用的 MCP 服务器与工具目录（只读，不执行）。四种用法：① 空参数 → server 清单（含已关闭的，按挂载态标开/关，并说明本会话的可见性口径）；② server=X → 该 server 的**能力摘要**（工具总数 + 前 5 个名字预览，不返回全表，避免上下文膨胀）；③ query + server → 在 X 内按需检索，返回 top-K 命中（含完整 schema），**想找某个 server 上的具体工具就用这个**；④ query → 全目录关键词检索。查到工具名后用 ${MCP_CALL_TOOL}(server, tool, arguments) 调用；不知道工具名先用 ②/③，不要用 ② 拉全表（工具多时传 all:true 才会返回全表）。中文连写请用空格分词（如“搜索 网页”）。`,
		parameters: {
			query: {
				type: "string",
				description: "检索关键词，按工具名/描述/参数名打分（缺省 top-K 8，上限 10）；与 server 同传即在该 server 内检索"
			},
			server: {
				type: "string",
				description: "目标 MCP server 名（见空查清单）。单独传 = 返回该 server 的能力摘要 + 前 5 个工具名预览"
			},
			all: {
				type: "boolean",
				description: "仅在传 server 时有效：true = 返回该 server 的完整工具清单（分页，可能很大）。默认 false 只给摘要"
			},
			limit: {
				type: "integer",
				description: "关键词 top-K（默认 8）或 server 页大小（默认 20，上限 50；配合 all:true 用）"
			},
			offset: {
				type: "integer",
				description: "server 页偏移（默认 0，仅 all:true 分支有效）"
			},
			topK: {
				type: "integer",
				description: "关键词命中数（默认 8，与 limit 同义，显式优先）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args, exec) => {
			const catalog = control.getCatalog();
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const server = typeof args.server === "string" ? args.server.trim() : "";
			const topK = clampLimit(typeof args.topK === "number" ? args.topK : typeof args.limit === "number" ? args.limit : void 0, 8, 10);
			const pageLimit = clampLimit(typeof args.limit === "number" ? args.limit : void 0, 20, 50);
			const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
			const workspace = typeof exec?.agent?.session?.header?.cwd === "string" ? exec.agent.session.header.cwd : void 0;
			const keep = (name) => !isToolDisabled(name, workspace);
			if (server && query) {
				const hits = searchCatalog(catalog, query, topK, server).filter((hit) => keep(hit.tool.name));
				return toJson({
					ok: true,
					kind: "search",
					server,
					query,
					count: hits.length,
					limit: topK,
					hits,
					hint: `命中即用 ${MCP_CALL_TOOL}（server + 裸工具名）调用；不够准就换关键词再搜，中文连写请用空格分词。`
				});
			}
			if (server) {
				const known = (control.installedInventory?.() ?? []).find((row) => row.server === server);
				let page = listServer(catalog, server, offset, pageLimit);
				let probed = false;
				if (page.totalCount === 0 && known) {
					await controller.fetchInventory(server).catch(() => null);
					probed = true;
					page = listServer(control.getCatalog(), server, offset, pageLimit);
				}
				if (!page.hasSnapshot && !known) return toJson({
					ok: true,
					kind: "list",
					server,
					found: false,
					installed: false,
					hasSnapshot: false,
					count: 0,
					totalCount: 0,
					offset,
					limit: pageLimit,
					tools: [],
					hint: `未知 server "${server}"，空查 ${MCP_SEARCH_TOOL} 看 server 清单；中文连写请用空格分词。`
				});
				const all = page.tools.filter((tool) => keep(tool.name));
				if (args.all !== true) {
					const preview = all.slice(0, 5).map((tool) => ({
						name: tool.name,
						description: tool.description
					}));
					return toJson({
						ok: true,
						kind: "summary",
						server,
						found: true,
						installed: true,
						open: known?.open ?? true,
						hasSnapshot: page.hasSnapshot,
						probed,
						count: page.totalCount,
						totalCount: page.totalCount,
						preview,
						hint: page.hasSnapshot ? `共 ${page.totalCount} 个工具，此处只预览 ${preview.length} 个。用 query + server 检索具体能力（推荐，按需且不占上下文）；确需完整清单请传 all: true。` : `该 server 已安装但当前没有工具（未运行或采集未成功）。可直接 ${MCP_CALL_TOOL} 调用它——中间层会临时拉起；若持续失败请在面板打开它后重试。`
					});
				}
				return toJson({
					ok: true,
					kind: "list",
					server,
					found: true,
					installed: true,
					open: known?.open ?? true,
					hasSnapshot: page.hasSnapshot,
					probed,
					count: all.length,
					totalCount: page.totalCount,
					offset,
					limit: pageLimit,
					tools: all,
					hint: "已按 all:true 返回全表（分页）。工具多时优先改用 query + server 检索，避免上下文膨胀。"
				});
			}
			if (query) {
				const hits = searchCatalog(catalog, query, topK).filter((hit) => keep(hit.tool.name));
				return toJson({
					ok: true,
					kind: "search",
					query,
					count: hits.length,
					limit: topK,
					hits
				});
			}
			const servers = buildSummary(control);
			const openCount = servers.filter((s) => s.open).length;
			return toJson({
				ok: true,
				kind: "summary",
				summary: [buildSummaryHeader(servers.length, openCount, control.middleLayerHides?.() === "all"), ...servers.map((s) => `- ${s.server} [${s.open ? "开" : "关"}]${s.tools === null ? "" : ` (${s.tools} 工具)`}: ${s.summary}`)].join("\n"),
				servers,
				count: servers.length
			});
		}
	});
	return ctx.tools.register(definition);
}
/** 把运行时对象投影为 JsonValue（工具 schema 本身是 JSON，转换是安全的）。 */
function toJson(value) {
	return JSON.parse(JSON.stringify(value));
}
function registerMcpCallTool(ctx, controller) {
	const definition = defineTool({
		name: MCP_CALL_TOOL,
		description: `调用一个 MCP 服务器上的工具。知道工具名直接调（server + 裸 tool 名），不知道先用 ${MCP_SEARCH_TOOL} 关键词搜。参数透传给远端工具。`,
		parameters: {
			server: {
				type: "string",
				required: true,
				description: `MCP 服务器名（见 ${MCP_SEARCH_TOOL} 摘要）`
			},
			tool: {
				type: "string",
				required: true,
				description: "该 server 上的工具名（裸名，如 understand_image；误传注册全名 mcp__<server>__<tool> 会自动归一化）"
			},
			arguments: {
				type: "object",
				additionalProperties: true,
				description: "传给远端工具的参数字典；必须传 JSON 对象本身，不要传 JSON 字符串（字符串形态会被参数校验直接拒绝）"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: (args, exec) => {
			return controller.gateway(args.server, args.tool, normalizeArguments(args.arguments), exec.agent, exec.signal).catch((error) => `MCP 调用异常：${msgOf(error)}`);
		}
	});
	return ctx.tools.register(definition);
}
/**
* 注册 mcp_search + mcp_call 两个模型工具。`controller` 必须是调用方持有的唯一
* 控制层实例（与空闲回收器共享同一引用计数/owner 状态），否则回收与调用不同步。
* 返回合并 disposer。
*/
function installMcpControlTools(ctx, control, controller) {
	return ctx.effect(() => {
		const disposers = [];
		try {
			disposers.push(registerMcpSearchTool(ctx, control, controller));
			disposers.push(registerMcpCallTool(ctx, controller));
		} catch (error) {
			for (const d of disposers) d();
			throw error;
		}
		return () => {
			for (const d of disposers) d();
		};
	}, "mcp-skill-panel: mcp control tools");
}
//#endregion
//#region src/filter.ts
const MCP_TOOL_PREFIX = "mcp__";
/** 从完整 tool name 解析 server 段（与 catalog.serverOfMcp 一致，保持本模块零依赖）。 */
function serverOfMcp(name) {
	if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at < 0) return null;
	return rest.slice(0, at);
}
function installMcpVisibilityFilter(ctx, buildVisibility, gateFor) {
	return ctx.effect(() => {
		return ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
			if (assembly && Array.isArray(assembly.tools)) {
				const agent = context?.agent;
				const gate = gateFor(agent);
				const visibility = buildVisibility();
				assembly.tools = assembly.tools.filter((tool) => {
					const name = String(tool.name ?? "");
					if (CONTROL_TOOL_NAMES.has(name)) return gate.on;
					if (!name.startsWith(MCP_TOOL_PREFIX)) return true;
					if (gate.on && gate.hideAll) return false;
					const server = serverOfMcp(name);
					return server === null ? true : visibility.get(server) ?? true;
				});
			}
			return next();
		});
	}, "mcp-skill-panel: mcp visibility filter");
}
//#endregion
//#region src/agent-preset-compat.ts
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
/**
* 新包名优先。理由：0.2.0 起旧包名被拆掉，新包名是**唯一**同时服务 0.1.7+
* 与 0.2.x 的落点（`dsh-agent-preset-registry` 自 0.1.7-alpha.1 起就在 npm 上，
* 且与旧包一样导出 `livePresetMounts` / `standingMountFor`）；只在它的解析
* 失败时才回退旧包名（纯 0.1.5-rc.x 宿主）。
*/
const SPECIFIERS = ["@deepseek-ai/dsh-agent-preset-registry", "@deepseek-ai/dsh-agent-presets"];
/** 解析诊断（/debug standingDiag 展示；不参与任何逻辑判断）。 */
const presetApiDiag = {
	specifier: null,
	resolvedPath: null,
	errors: [],
	base: "self"
};
/** 进程级记忆，避免每次读都重解析。 */
let cached = null;
/** 取一个可用于 createRequire 的 base（绝对文件路径或 file: URL）。 */
function baseOf(ctx) {
	const baseUrl = ctx?.baseUrl;
	if (typeof baseUrl === "string" && baseUrl.length > 0) {
		if (baseUrl.startsWith("file:")) try {
			return {
				base: fileURLToPath(baseUrl),
				source: "ctx.baseUrl"
			};
		} catch {}
		else return {
			base: baseUrl,
			source: "ctx.baseUrl"
		};
	}
	return {
		base: import.meta.url,
		source: "self"
	};
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
function standingMountForAgent(agentCtx) {
	if (agentCtx === void 0) return void 0;
	const api = cached?.api;
	if (!api || typeof api.standingMountFor !== "function") return void 0;
	try {
		return api.standingMountFor(agentCtx);
	} catch {
		return;
	}
}
/**
* 解析 agent-presets 模块命名空间（进程级缓存）。
*
* 永不抛：全部候选包名都解析失败时返回空对象，并记入 {@link presetApiDiag}。
* @param ctx - 宿主上下文；提供 `baseUrl` 时优先按其解析，以命中宿主同一模块实例。
* @returns 模块命名空间（或空对象）。
*/
async function resolveAgentPresetApi(ctx) {
	const { base, source } = baseOf(ctx);
	if (cached && cached.key === base) return cached.api;
	presetApiDiag.errors = [];
	presetApiDiag.base = source;
	let require;
	try {
		require = createRequire(base);
	} catch (error) {
		presetApiDiag.errors.push(`createRequire(${base}): ${messageOf(error)}`);
		return {};
	}
	for (const specifier of SPECIFIERS) try {
		const resolved = require.resolve(specifier);
		const mod = require(specifier);
		presetApiDiag.specifier = specifier;
		presetApiDiag.resolvedPath = resolved;
		cached = {
			api: mod,
			key: base
		};
		return mod;
	} catch (error) {
		presetApiDiag.errors.push(`${specifier}: ${messageOf(error)}`);
	}
	presetApiDiag.specifier = null;
	presetApiDiag.resolvedPath = null;
	return {};
}
function messageOf(error) {
	if (error instanceof Error) return `${error.code ?? error.name}: ${error.message}`;
	return String(error);
}
//#endregion
//#region src/standing-rows.ts
/**
* agent-presets 读取面。**异步解析**（模块图不能在顶层静态 import 旧包名，
* 见 agent-preset-compat.ts 的模块注释）。解析完成前 `presetMounts()` 返回 []，
* 面板按 0.5.6 降级行为显示；`ensureAgentPresetApi()` 应在插件 `apply` 里 await。
*/
let api = {};
/** 解析一次并缓存（幂等，可重复 await）。 */
async function ensureAgentPresetApi(ctx) {
	const resolved = await resolveAgentPresetApi(ctx);
	if (Object.keys(resolved).length > 0 || Object.keys(api).length === 0) api = resolved;
}
/** 诊断快照（/debug standingDiag 用；不参与任何逻辑判断）。 */
let diag = {
	apiAvailable: false,
	apiError: null,
	mountsSeen: 0,
	lastPresetIds: [],
	lastRowCount: 0
};
/**
* 本插件 `apply` 里经 `ctx.agentPresets.standingMountFor(...)` 捕获的挂载。
*
* 为什么需要它（**模块身份兜底**）：`livePresetMounts()` 读的是包里模块私有的
* `mounts` Set，只有解析到宿主**同一份物理实例**时才非空（见 agent-preset-compat.ts）。
* 而 `standingMountFor(agentCtx)` 走的是宿主服务对象上的方法，与实例无关。
* 因此捕获一份挂载即可绕开实例错位；`livePresetMounts()` 仍作首选的进程级枚举。
*/
let capturedMount;
/** 由 `apply` 早期捕获 standing 挂载（取不到属正常路径：rc.4 会话无挂载时为 undefined）。 */
function captureStandingMount(mount) {
	if (mount?.tree && typeof mount.tree.entries === "function") capturedMount = mount;
}
/**
* 全进程所有 preset 的 standing 挂载。
*
* 顺序：`livePresetMounts()`（进程级、覆盖全部 preset）→ 捕获的挂载（实例错位兜底）。
* 两侧都过滤掉没有 tree / tree 无 entries() 的项（防御畸形挂载）。
*/
function standingMounts() {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	if (typeof api.livePresetMounts === "function") try {
		const raw = api.livePresetMounts();
		for (const m of Array.isArray(raw) ? raw : []) {
			if (!m?.tree || typeof m.tree.entries !== "function") continue;
			const key = String(m.presetId ?? "");
			if (key.length > 0 && seen.has(key)) continue;
			if (key.length > 0) seen.add(key);
			out.push(m);
		}
		diag = {
			...diag,
			apiAvailable: true,
			apiError: null
		};
	} catch (error) {
		diag = {
			...diag,
			apiAvailable: true,
			apiError: error instanceof Error ? error.message : String(error)
		};
	}
	else if (Object.keys(api).length === 0) diag = {
		...diag,
		apiAvailable: false,
		apiError: presetApiDiag.errors.length > 0 ? presetApiDiag.errors.join(" | ") : "agent-presets module not resolved yet"
	};
	else diag = {
		...diag,
		apiAvailable: false,
		apiError: "livePresetMounts not exported by host agent-presets module"
	};
	if (capturedMount?.tree && typeof capturedMount.tree.entries === "function") {
		const key = String(capturedMount.presetId ?? "");
		if (key.length === 0 || !seen.has(key)) out.push(capturedMount);
	}
	diag = {
		...diag,
		mountsSeen: out.length,
		lastPresetIds: out.map((m) => String(m.presetId ?? ""))
	};
	return out;
}
/**
* 在 standing 树里按 serverName 找 MCP 行。先枚举全部 standing 挂载；
* 空表且给了 agentCtx 时再用 `standingMountFor(agentCtx)` 兜一次
* （带 agent 的调用方更精确，但不依赖它——RC.4 会话无挂载时为 undefined）。
* 命中规则与 loader 侧一致（isMcpEntry + serverNameOf），两条路径同语义。
*/
function findStandingEntryByServer(serverName, agentCtx) {
	const mounts = standingMounts();
	if (mounts.length === 0 && agentCtx !== void 0 && typeof api.standingMountFor === "function") try {
		const mount = api.standingMountFor(agentCtx);
		if (mount?.tree && typeof mount.tree.entries === "function") mounts.push(mount);
	} catch {}
	for (const mount of mounts) for (const entry of safeEntries(mount.tree)) {
		if (!isMcpEntry(entry)) continue;
		if (serverNameOf(entry) === serverName) return entry;
	}
}
/** 在 standing 树里按长 entryId 找行（toggleMcp 直传 entryId 时用）。 */
function findStandingEntryById(entryId) {
	for (const mount of standingMounts()) for (const entry of safeEntries(mount.tree)) if (String(entry.id) === entryId) return entry;
}
/** 全部 standing MCP 行（可见性层用：需同时覆盖 open 与 closed 两种行）。 */
function standingMcpEntries() {
	const out = [];
	for (const mount of standingMounts()) for (const entry of safeEntries(mount.tree)) {
		if (!isMcpEntry(entry)) continue;
		out.push(entry);
	}
	diag = {
		...diag,
		lastRowCount: out.length
	};
	return out;
}
/**
* 该 live 行所属 preset 的 id（多 preset 时逐挂载查找 entry.id 命中）。
*
* 用途：0.2.0 起 preset 不再有组合文件，state.json 的行来源键由「绝对路径」
* 退化为 `preset:<id>`（见 preset-mcp.ts 的 `presetKeyOf`），而 live 行本身
* 只带 entryId —— 需要反查它属于哪个 preset 才能算出同一个键。
* @param entry - standing 树里的行句柄。
* @returns preset id；找不到返回 ''。
*/
function presetIdOfEntry(entry) {
	const id = String(entry?.id ?? "");
	if (!id) return "";
	for (const mount of standingMounts()) for (const row of safeEntries(mount.tree)) if (String(row.id) === id) return String(mount.presetId ?? "");
	return "";
}
/**
* 全部**已安装**的 MCP server（含用户关闭的），供 mcp_search 列能力表。
*
* 与 `standingMcpEntries()` 的差别：这里只要"配置里存在这一行"就算已安装，
* 不要求它有运行实例 —— 这正是 rc.8 语义里「关着的 server 仍应可被检索到」的落点
* （0.5.7 之前关掉的行既不在 loader 也不在 catalog，模型完全看不到它存在）。
*/
function installedMcpRows() {
	const out = [];
	for (const entry of standingMcpEntries()) out.push({
		serverName: serverNameOf(entry),
		entryId: String(entry.id),
		open: entry.disabled !== true,
		hasEntry: true
	});
	out.sort((a, b) => a.serverName.localeCompare(b.serverName));
	return out;
}
/** entries() 迭代器防御：挂载途中树可能重建，抛错时按空树处理并记诊断。 */
function safeEntries(tree) {
	if (!tree) return [];
	try {
		const it = tree.entries();
		return Array.isArray(it) ? it : [...it];
	} catch (error) {
		diag = {
			...diag,
			apiError: error instanceof Error ? error.message : String(error)
		};
		return [];
	}
}
/**
* /debug 诊断读数（只读快照，外部改不到内部状态）。
*
* `presetApi` 段是 0.7.0 新增：模块解析命中的包名/实例路径/解析基准/失败清单。
* 「面板 MCP 行为空」的第一嫌疑仍是实例错位（`mounts` 是包内模块私有 Set），
* 这里直接给出取证面，不要靠猜（判读：`specifier` 为 null 或 `mountsSeen === 0`
* 而 `capturedMount` 有值 ⇒ 解析到的不是宿主那一份实例）。
*/
function standingDiag() {
	return {
		...diag,
		presetApi: {
			specifier: presetApiDiag.specifier,
			resolvedPath: presetApiDiag.resolvedPath,
			base: presetApiDiag.base,
			errors: [...presetApiDiag.errors],
			hasCapturedMount: capturedMount !== void 0
		}
	};
}
//#endregion
//#region src/gateway.ts
/** 网关行 entryId 前缀（连字符；冒号是 EntryTree.sep 不可用，见 B4）。 */
const GATEWAY_ENTRY_PREFIX = "gw-mcp-";
/** 网关行 entryId ↔ serverName 双向映射（B4 三键落字）。 */
function gatewayEntryId(serverName) {
	return `${GATEWAY_ENTRY_PREFIX}${serverName}`;
}
function gatewayServerOfEntryId(entryId) {
	if (!entryId.startsWith("gw-mcp-")) return null;
	return entryId.slice(7);
}
/** 空网关态。 */
function createGatewayState() {
	return {
		restrictDisposers: [],
		mounts: /* @__PURE__ */ new Map(),
		entryIds: /* @__PURE__ */ new Map(),
		lastCheck: null,
		syncing: false
	};
}
/**
* 子 scope 视野隔离：在给定 tools 服务上 deny 除双工具外的全部继承 `mcp__*` 名。
* deny 表调用方传入（动态表：`view(standingKey).visible` 快照，见 MVT-5 R3-2）。
* 未知名按 dsh-tools 语义抛错——调用方须只传已知 global 名（MVT-4 R2-2）。
*/
function isolateChildScope(childTools, inheritMcpNames) {
	return childTools.restrict({ deny: [...inheritMcpNames] });
}
/**
* open 行网关挂载决策（纯逻辑，可自测）：
* - preset 行缺失/不可挂载（config undefined）→ 'skip'（回退旧直通语义）；
* - preset 行 disabled → 'skip'（拒绝语义归 gatewayCall，前置已判定）；
* - loader 已有同名 server 行（官方行/项目行/global 行启用中，网关让路）→ 'skip-official'
*  （B3：rc.1 下 standing 行不在 loader.entries，判据=loader 同 serverName 行存在；
*   standing 行与网关行是否同 scope 抛错互斥未经现网实证，不假设——让路即不建第二实例）；
* - 已有同名 mount → 'reuse'（防 #3984 `already in use` / #4798 重复注册）；
* - 否则 'mount'。
*/
function decideMount(serverName, presetConfig, presetDisabled, mounted, hasLoaderRow = false) {
	if (!presetConfig) return "skip";
	if (presetDisabled) return "skip";
	if (hasLoaderRow) return "skip-official";
	if (mounted.has(serverName)) return "reuse";
	return "mount";
}
/**
* 网关自检断言（MVT-4 ASSERT-A/A2 产品化）：child 可见面恒为双工具。
* 纯逻辑：visible 名单由调用方传入（`tools.view(childKey).visible.keys()`），
* 本函数只做集合比对，不碰运行时。
*/
function checkChildVisible(visibleNames) {
	const sorted = [...visibleNames].sort();
	const ok = sorted.length === 2 && sorted[0] === "dsh_mcp_call" && sorted[1] === "dsh_mcp_search";
	return {
		ok,
		detail: ok ? `child visible == [${MCP_CALL_TOOL}, ${MCP_SEARCH_TOOL}]` : `child visible unexpected: ${JSON.stringify(sorted)}`
	};
}
/** 释放网关挂载态：restrict disposer 逐个 lift + loader gw- 行逐个 remove + 清 mounts（B2）。 */
function disposeGatewayState(ctx, state) {
	for (const dispose of state.restrictDisposers.splice(0)) try {
		dispose();
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: gateway restrict lift failed: ${messageOf$1(error)}`);
	}
	for (const [serverName, entryId] of [...state.entryIds]) {
		try {
			ctx.loader.remove(entryId)?.catch?.(() => void 0);
		} catch {}
		state.entryIds.delete(serverName);
	}
	state.mounts.clear();
}
/** 同步释放（applyAutoManage 同步体内/卸载兜底共用；remove fire-and-forget）。 */
function disposeGatewayStateSync(ctx, state) {
	disposeGatewayState(ctx, state);
}
/**
* 网关常驻挂载（P5）：open 的 preset 行经 loader.create 自托管拉起 dsh-mcp-client。
*
* 真值表（B3）：
* - preset 无行/不可挂载（config undefined）→ skipped（回退旧直通语义）；
* - preset 行 disabled → skipped（拒绝语义归 gatewayCall）；
* - loader 已有同名 server 行 → skippedOfficial（网关让路，不建第二实例）；
* - mounts 已有同名 → reused；
* - 否则 loader.create({id: gw-mcp-<server>, name, config, disabled:false}) → mounted/errors。
*
* 关意图即拆（WARN-3 补关链路，2026-09-10 现网实证）：
* - toggle 网关行只写 state.json desired 意图（routes.ts 网关分支，不碰 live gw- 行）；
* - 本轮先读 state，对「已挂载 mounts 中 desired=true（关意图）」的行逐个 loader.remove
*   并清 mounts/entryIds 账，记 unmounted；意图链不动（state/pending 由 toggle 侧维护）。
* - 开意图（desired=false/无意图）走正常挂载真值表；关→开即重挂。
*
* 单飞（W3）：syncing guard + 顶层 try/finally；一家失败记 errors 不抛（一家挂不拖全家）。
* preset 选择（W4）：调用方 agent 优先，无则 roots[0]/list[0]（与 cachedPresetRow 同规则）；
* listPresetMcpRows 按 presetId 全量列出行，挂载逐行决策。
*/
async function ensureOpenMounts(deps, presetId) {
	const { ctx, control, state } = deps;
	const out = {
		mounted: [],
		reused: [],
		skipped: [],
		skippedOfficial: [],
		unmounted: [],
		errors: []
	};
	if (state.syncing) return out;
	state.syncing = true;
	try {
		let pid = presetId;
		if (!pid) try {
			const live = ctx.agents.roots()[0] ?? ctx.agents.list()[0];
			pid = live ? ctx.agentPresets.composedPreset(live.ctx) ?? void 0 : void 0;
		} catch {
			pid = void 0;
		}
		if (!pid) {
			state.lastCheck = {
				at: Date.now(),
				ok: true,
				detail: "mounted=0 reused=0 skipped=0 skippedOfficial=0 unmounted=0 errors=0 (no preset)"
			};
			return out;
		}
		const { listPresetMcpRows } = await import("./preset-mcp-Crs1vqgY.mjs");
		const { isMcpEntry, serverNameOf } = await import("./mcp-entry-CPGfHQXX.mjs").then((n) => n.r);
		const { MCP_CLIENT_NAME } = await import("./mcp-convert-DBh-8vB6.mjs").then((n) => n.t);
		const { readState } = await import("./state-Nrn6A6RC.mjs").then((n) => n.c);
		const listRows = deps.listRows ?? (async (c, pid2) => listPresetMcpRows(c, pid2));
		const readIntents = deps.readIntents ?? (async () => {
			const stateFile = await readState().catch(() => void 0);
			return (presetKeyRef.current ? stateFile?.mcp?.[presetKeyRef.current] : void 0) ?? {};
		});
		let rows = [];
		const presetKeyRef = { current: "" };
		try {
			const listed = await listRows(ctx, pid);
			rows = listed.rows;
			presetKeyRef.current = listed.presetKey;
		} catch (error) {
			state.lastCheck = {
				at: Date.now(),
				ok: false,
				detail: `listPreset failed: ${messageOf$1(error)}`
			};
			return out;
		}
		let intents = {};
		try {
			intents = await readIntents();
			for (const [serverName, entryId] of [...state.entryIds]) {
				if (!state.mounts.has(serverName)) {
					state.entryIds.delete(serverName);
					continue;
				}
				const row = rows.find((r) => r.serverName === serverName);
				if (!row) continue;
				if (intents[row.rowId]?.desired !== true) continue;
				try {
					await ctx.loader.remove(entryId);
				} catch (error) {
					const msg = messageOf$1(error);
					if (/not found|cannot resolve|no such|不存在|已失效|already removed/i.test(msg)) {} else {
						ctx.logger.warn?.(`mcp-skill-panel: gateway unmount "${serverName}" failed, retry next round: ${msg}`);
						continue;
					}
				}
				state.entryIds.delete(serverName);
				state.mounts.delete(serverName);
				out.unmounted.push(serverName);
			}
		} catch {}
		const loaderServers = /* @__PURE__ */ new Set();
		try {
			for (const entry of ctx.loader.entries()) {
				if (!isMcpEntry(entry)) continue;
				loaderServers.add(serverNameOf(entry));
			}
		} catch {}
		for (const row of rows) {
			if (intents[row.rowId]?.desired === true) {
				out.skipped.push(row.serverName);
				continue;
			}
			const decision = decideMount(row.serverName, row.config, row.disabled, state.mounts, loaderServers.has(row.serverName));
			if (decision === "skip") {
				out.skipped.push(row.serverName);
				continue;
			}
			if (decision === "skip-official") {
				out.skippedOfficial.push(row.serverName);
				continue;
			}
			if (decision === "reuse") {
				out.reused.push(row.serverName);
				continue;
			}
			const entryId = gatewayEntryId(row.serverName);
			try {
				await ctx.loader.create({
					id: entryId,
					name: MCP_CLIENT_NAME,
					config: { ...row.config },
					disabled: false
				});
				state.mounts.set(row.serverName, Date.now());
				state.entryIds.set(row.serverName, entryId);
				out.mounted.push(row.serverName);
			} catch (error) {
				out.errors.push({
					server: row.serverName,
					error: messageOf$1(error)
				});
				ctx.logger.warn?.(`mcp-skill-panel: gateway mount "${row.serverName}" failed: ${messageOf$1(error)}`);
			}
		}
		const ok = out.errors.length === 0;
		state.lastCheck = {
			at: Date.now(),
			ok,
			detail: `mounted=${out.mounted.length} reused=${out.reused.length} skipped=${out.skipped.length} skippedOfficial=${out.skippedOfficial.length} unmounted=${out.unmounted.length} errors=${out.errors.length}`
		};
		return out;
	} finally {
		state.syncing = false;
	}
}
//#endregion
//#region src/preset.ts
const DISABLE_KEY = "disable-model-invocation";
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 新行分隔符：跟随原文件。 */
function lineSep(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}
/**
* 在组合文件中对 `- id: <rowId>` 行做 `  <key>: <value>` 标记的插入/移除。
* 逐行文本编辑，保留注释与 !!js 表达式原样（loader 的 yaml.dump 会丢注释，故不用）。
*
* 语义（2026-08-27 修复）：value=true 保证标记存在且为 true（已有 false 时反转）；
* value=false 移除标记。此前 value=true 遇到已存在的 `disabled: false` 会原样返回
* （只支持插入/删除不支持反转），导致物化失败后 lastApplied 与文件脱节，
* 下次启动被误判「外部修改」而删掉 state 条目（obsidian 设置丢失事故）。
*/
function setRowFlag(text, rowId, key, value) {
	const nl = lineSep(text);
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`);
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const block = lines.slice(idx, end);
	const flagRe = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(true|false)\\s*$`);
	const flagAt = block.findIndex((line) => flagRe.test(line));
	if (flagAt >= 0) {
		if (value) {
			if (/:\s*false\s*$/.test(block[flagAt])) {
				lines.splice(idx + flagAt, 1, `  ${key}: true`);
				return lines.join(nl);
			}
			return text;
		}
		lines.splice(idx + flagAt, 1);
		return lines.join(nl);
	}
	if (value) {
		lines.splice(idx + 1, 0, `  ${key}: true`);
		return lines.join(nl);
	}
	return text;
}
/**
* 0.6.0：在组合文件中对 `- id: <rowId>` 行做**任意标量键**的设置/删除（通用版 setRowFlag）。
*
* 为什么必须是文本编辑而不是 yaml.dump：预设文件里允许 `!!js` 表达式与注释，
* dump 会丢掉它们（setRowFlag 的注释已记录这条）。
*
* 关键语义：**只改 config: 块内的同名键**，不碰行级键（disabled/name 等）。
* 早先实现曾把 config 块挂到行级，本函数按缩进判别：
*   - config: 行缩进记为 base；
*   - 子键缩进 > base 即认为属于 config 块；
*   - 键是标量（单行 `key: value`）才替换，多行值（`|` / 嵌套 map）保守跳过并报错，
*     避免把用户的复杂配置改坏。
*
* @param set 要写入/覆盖的键（值须已序列化为 YAML 标量文本）
* @param remove 要删除的键
*/
function setRowConfigKeys(text, rowId, set, remove = []) {
	const nl = lineSep(text);
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) throw new Error(`row "- id: ${rowId}" not found in composition file`);
	const childIndent = (/^(\s*)/.exec(lines[idx])?.[1].length ?? 0) + 2;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	let configAt = -1;
	{
		const re = new RegExp(`^\\s{${childIndent}}config:\\s*$`);
		for (let i = idx + 1; i < end; i += 1) if (re.test(lines[i])) {
			configAt = i;
			break;
		}
	}
	/**
	* config 块的**直接子键缩进**（块内非空行取最小缩进）。
	* 教训：早先直接用 `childIndent + 2` 当键缩进并写成 `^\s{N}key:`，而 `\s{N}` 是
	* "恰好 N 个空白后紧跟 key" —— 该写法永远匹配不上真正的键行，导致每次都当新键
	* 插入（自测 ②「同键覆盖幂等」抓到的 bug）。取块内最小缩进才是稳健判定。
	*/
	const configKeyIndent = (from, limit) => {
		let min = -1;
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
			if (indent <= childIndent) break;
			if (min < 0 || indent < min) min = indent;
		}
		return min < 0 ? childIndent + 2 : min;
	};
	/** 在 config 块内按**直接子键**精确命中 `key:` 行（不做深度匹配，避免误伤嵌套同名键）。 */
	const findKey = (key, from, limit, keyIndent) => {
		const re = new RegExp(`^\\s{${keyIndent}}${escapeRegExp(key)}:`);
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
			if (indent <= childIndent) break;
			if (indent === keyIndent && re.test(line)) return i;
		}
		return -1;
	};
	/**
	* 一个键的**值区间**占几行：标题行 + 其后所有更深缩进的续行
	* （块映射 / 块序列 / 块标量的子行都属于这个键）。
	*
	* 2026-09-15 实测事故：早先覆盖时只替换标题行，`env:` 的 4 行块映射被遗留成孤儿 ——
	*   env: { MIMO_API_KEY: ... }      ← 新写的单行 flow
	*     MIMO_API_KEY: !!js "..."      ← 旧子行没人管
	* 整个组合文件就此变成非法 YAML（`bad indentation of a mapping entry (389:7)`），
	* 预设挂载失败 → 所有旧会话 resume 报错、新会话也建不出来。
	* 覆盖/删除都必须连着值区间一起动。
	*/
	const keyValueSpan = (at, limit, keyIndent) => {
		let span = 1;
		let i = at + 1;
		while (i < limit) {
			if (lines[i].trim().length === 0) {
				let j = i;
				while (j < limit && lines[j].trim().length === 0) j += 1;
				if (j >= limit) break;
				if ((/^(\s*)/.exec(lines[j])?.[1].length ?? 0) <= keyIndent) break;
				span += j - i;
				i = j;
				continue;
			}
			if ((/^(\s*)/.exec(lines[i])?.[1].length ?? 0) <= keyIndent) break;
			span += 1;
			i += 1;
		}
		return span;
	};
	/** config 块的最后一个内容行之后（空行不并入，避免把新键插到块外）。 */
	function configBlockEnd(from, limit) {
		let last = from + 1;
		for (let i = from + 1; i < limit; i += 1) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			if ((/^(\s*)/.exec(line)?.[1].length ?? 0) <= childIndent) break;
			last = i + 1;
		}
		return last;
	}
	if (configAt >= 0) for (const key of remove) {
		const blockEnd = configBlockEnd(configAt, end);
		const keyIndent = configKeyIndent(configAt, blockEnd);
		const at = findKey(key, configAt, blockEnd, keyIndent);
		if (at < 0) continue;
		const span = keyValueSpan(at, blockEnd, keyIndent);
		lines.splice(at, span);
		end -= span;
	}
	for (const [key, value] of Object.entries(set)) if (configAt >= 0) {
		const blockEnd = configBlockEnd(configAt, end);
		const keyIndent = configKeyIndent(configAt, blockEnd);
		const at = findKey(key, configAt, blockEnd, keyIndent);
		const line = `${" ".repeat(keyIndent)}${key}: ${value}`;
		if (at >= 0) {
			const span = keyValueSpan(at, blockEnd, keyIndent);
			lines.splice(at, span, line);
			end += 1 - span;
		} else {
			lines.splice(blockEnd, 0, line);
			end += 1;
		}
	} else {
		let lastContent = idx;
		for (let i = idx + 1; i < end; i += 1) if (lines[i].trim().length > 0) lastContent = i;
		lines.splice(lastContent + 1, 0, `${" ".repeat(childIndent)}config:`, `${" ".repeat(childIndent + 2)}${key}: ${value}`);
		end += 2;
		configAt = lastContent + 1;
	}
	return lines.join(nl);
}
/** 允许通过面板编辑的挂载配置键（与 mcp-convert.ts 的挂载形态一致）。 */
const EDITABLE_CONFIG_KEYS = [
	"transport",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
	"toolCallTimeoutMs",
	"failOnStartupError"
];
/**
* 未转义的普通标量可直接裸写的字符集。
* 首字符另有限制：不能是 `- ? : , [ ] { } # & * ! | > ' " % @ \`` 等 YAML 指示符开头
* （如 `--mcp` 会被当成块序列指示符的歧义区），这类一律加引号 ——
* 与预设里既有写法一致（`args: ['serve', '--mcp']`）。
*/
const PLAIN_SCALAR = /^[A-Za-z0-9_./\\:-]+$/;
const SAFE_FIRST = /^[A-Za-z0-9_./\\]/;
/**
* 裸写后会被解析成**非字符串**的标量形态。
*
* 预设组合按 `yaml.JSON_SCHEMA.extend(!!js)` 解析（cordis-plugin-include 的
* entryListSchema），于是 `300` 是 number、`true` 是 boolean、`~` 是 null、
* `.inf` 是 Infinity。env 这类值必须是字符串，裸写会**静默改类型**
* （实测：原始 `MIMO_TIMEOUT: '300'` 被物化成 `300`）。
* JSON_SCHEMA 不认 YAML 1.1 的 `yes/no/on/off`（实测仍为字符串），故无需为其加引号。
*/
const NON_STRING_SCALAR = /^(?:~|true|false|null|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[-+]?0[xX][0-9a-fA-F]+|[-+]?0[oO][0-7]+|[-+]?0[bB][01]+|[-+]?\.(?:inf|nan))$/i;
/** 运行态的 `!!js` 表达式载体（cordis-plugin-include 的 construct 产物）。 */
function isJsExprObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.__jsExpr === "string";
}
/**
* 0.6.0：把配置值序列化成**单行 YAML**（写入预设文件用）。
*
* 保守策略：只在确认安全时才裸写，其余一律单引号包裹（YAML 单引号里 `'` 需写成 `''`）。
* 数组/对象用 flow 风格（与预设里既有的 `args: ['serve', '--mcp']` 一致）。
* `!!js` 表达式写回**标签形态**（与 dsh 自己的 `represent` 一致），不退化成
* `{ __jsExpr: ... }`：两者求值等价（`interpolate` 认 `__jsExpr` 键），但标签形态
* 保住文件原有写法，改配置不会把用户的表达式写成另一种方言。
*/
function configValueToYaml(value) {
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (isJsExprObject(value)) return `!!js ${JSON.stringify(value.__jsExpr)}`;
	if (Array.isArray(value)) return `[${value.map((v) => configValueToYaml(v)).join(", ")}]`;
	if (value !== null && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${configValueToYaml(v)}`).join(", ")} }`;
	const s = String(value ?? "");
	if (s.length > 0 && PLAIN_SCALAR.test(s) && SAFE_FIRST.test(s) && !NON_STRING_SCALAR.test(s)) return s;
	return `'${s.replace(/'/g, "''")}'`;
}
/** 把一组配置键/值转成 setRowConfigKeys 需要的「已序列化标量」形态。 */
function configSetToYaml(set) {
	const out = {};
	for (const [k, v] of Object.entries(set)) out[k] = configValueToYaml(v);
	return out;
}
/** 把配置对象转成用于"是否已物化"比对的稳定文本（键排序，避免顺序抖动导致重复写）。 */
function configKeysToYamlText(config) {
	return Object.keys(config).sort().map((k) => `${k}: ${configValueToYaml(config[k])}`).join("\n");
}
/** SKILL.md frontmatter 的 disable-model-invocation 键注入/移除（kebab-case 是唯一合法形式）。 */
function setSkillFlag(text, value) {
	lineSep(text);
	const has = new RegExp(`^${DISABLE_KEY}:\\s*true\\s*$`, "m").test(text);
	if (value && !has) {
		const m = /^---\s*(\r?\n)/.exec(text);
		if (!m) return text;
		return `---${m[1]}${DISABLE_KEY}: true${m[1]}${text.slice(m[0].length)}`;
	}
	if (!value && has) return text.replace(new RegExp(`^\\s*${DISABLE_KEY}:\\s*true\\s*\\r?\\n?`, "m"), "");
	return text;
}
/** dsh-skill-filesystem 的 skill 名约束：kebab-case（非合法名会被发现层丢弃）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** skill 名是否合法（kebab-case，前端预校验与后端落盘共用）。 */
function isValidSkillName(name) {
	return SKILL_NAME_PATTERN.test(name);
}
/**
* 生成 SKILL.md 文本：frontmatter（name/description）+ 正文。
* description 用 JSON 双引号标量（合法 YAML，冒号/换行安全）；正文原样保留。
*/
function buildSkillMd(name, description, body) {
	const nl = "\n";
	return `---${nl}name: ${name}${nl}description: ${JSON.stringify(description)}${nl}---${nl}${nl}${body.replace(/\s+$/, "")}${nl}`;
}
/** 读取某行当前是否带 disabled: true（true/false/null=无标记）。 */
function rowDisabledState(text, rowId) {
	const lines = text.split(/\r?\n/);
	const rowRe = new RegExp(`^-\\s*id:\\s*${escapeRegExp(rowId)}\\s*$`);
	const idx = lines.findIndex((line) => rowRe.test(line));
	if (idx < 0) return null;
	let end = idx + 1;
	while (end < lines.length && !/^-\s*id:/.test(lines[end])) end += 1;
	const flagLine = lines.slice(idx, end).find((line) => /^\s*disabled:\s*(true|false)\s*$/.test(line));
	if (!flagLine) return null;
	return /:\s*true\s*$/.test(flagLine);
}
/**
* 启动早期物化：把状态文件里的 MCP 启停意图写入预设组合文件。
* 只在「没有任何 agent 在跑」时执行 —— 有会话时写文件会触发
* dsh-agent-presets 的 stamp 重挂（旧实例不 dispose → serverName 冲突事故）。
*/
async function syncPresetFiles(ctx) {
	if (ctx.agents.list().length > 0) return 0;
	const state = await readState();
	const mcp = state.mcp;
	if (!mcp || Object.keys(mcp).length === 0) return 0;
	let materialized = 0;
	for (const [file, rows] of Object.entries(mcp)) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let changed = false;
		const next = {};
		for (const [rowId, entry] of Object.entries(rows)) {
			const cur = rowDisabledState(text, rowId);
			let lastApplied = entry.lastApplied;
			if (cur !== entry.lastApplied) {
				lastApplied = cur;
				ctx.logger.info?.(`mcp-skill-panel: preset row ${rowId} externally modified (disabled ${String(entry.lastApplied)} → ${String(cur)}); keeping desired=${String(entry.desired)}, still materializing config`);
			} else {
				if (cur === true !== entry.desired) try {
					text = setRowFlag(text, rowId, "disabled", entry.desired);
					changed = true;
					materialized += 1;
				} catch {
					continue;
				}
				lastApplied = entry.desired;
			}
			let configAppliedYaml = entry.configAppliedYaml;
			if (entry.config && Object.keys(entry.config).length > 0) {
				const yamlText = configKeysToYamlText(entry.config);
				if (yamlText !== entry.configAppliedYaml) try {
					text = setRowConfigKeys(text, rowId, configSetToYaml(entry.config));
					changed = true;
					materialized += 1;
					configAppliedYaml = yamlText;
				} catch {}
			}
			next[rowId] = {
				desired: entry.desired,
				lastApplied,
				config: entry.config,
				configAppliedYaml
			};
		}
		if (changed) {
			const tmp = `${file}.tmp`;
			await writeFile(tmp, text, "utf8");
			await rename(tmp, file);
		}
		mcp[file] = next;
	}
	await writeState(state);
	return materialized;
}
//#endregion
//#region src/preset-live.ts
/** `dsh-mcp-client` 行的挂载配置形状（只取本插件用到的字段）。 */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** 字符串键值映射（env/headers）；非法或空返回 undefined。 */
function stringMapOf(value) {
	if (!isRecord(value)) return void 0;
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		if (v === void 0 || v === null) continue;
		out[k] = String(v);
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
/** 字符串数组（args）；非法或空返回 undefined。 */
function stringListOf(value) {
	if (!Array.isArray(value)) return void 0;
	const out = value.filter((v) => v !== void 0 && v !== null).map((v) => String(v));
	return out.length > 0 ? out : void 0;
}
/**
* loader 行 options → 挂载配置。**纯函数**，selftest 可直接喂对象覆盖。
*
* 不可挂载（transport 无法归一，或 stdio 缺 command / http 缺 url）时返回
* undefined —— 与 `presetConfigOf` 同判据，调用方据此把该行按「无实例句柄」处理。
* @param options - `entry.options`（或任何同形状对象）。
* @returns 挂载配置，或 undefined。
*/
function configOfEntryOptions(options) {
	if (!isRecord(options)) return void 0;
	const cfg = options.config;
	if (!isRecord(cfg)) return void 0;
	const serverName = cfg.serverName !== void 0 ? String(cfg.serverName) : void 0;
	if (!serverName) return void 0;
	const rawTransport = cfg.transport !== void 0 ? String(cfg.transport) : void 0;
	const transport = rawTransport === "stdio" || rawTransport === "streamable-http" ? rawTransport : typeof cfg.command === "string" && cfg.command.length > 0 ? "stdio" : typeof cfg.url === "string" && cfg.url.length > 0 ? "streamable-http" : void 0;
	if (!transport) return void 0;
	const out = {
		serverName,
		transport
	};
	if (transport === "stdio") {
		if (typeof cfg.command !== "string" || cfg.command.length === 0) return void 0;
		out.command = cfg.command;
		const args = stringListOf(cfg.args);
		if (args) out.args = args;
		const env = stringMapOf(cfg.env);
		if (env) out.env = env;
		if (typeof cfg.cwd === "string" && cfg.cwd.length > 0) out.cwd = cfg.cwd;
	} else {
		if (typeof cfg.url !== "string" || cfg.url.length === 0) return void 0;
		out.url = cfg.url;
		const headers = stringMapOf(cfg.headers);
		if (headers) out.headers = headers;
	}
	const timeout = Number(cfg.toolCallTimeoutMs);
	if (Number.isFinite(timeout) && timeout > 0) out.toolCallTimeoutMs = timeout;
	if (typeof cfg.failOnStartupError === "boolean") out.failOnStartupError = cfg.failOnStartupError;
	return out;
}
/** 行内短 id（state.json 的 row 键）—— `entry.options.id` 优先，回落长 id 末段。 */
function rowIdOfEntry(entry) {
	const raw = entry.options?.id;
	if (typeof raw === "string" && raw.length > 0) return raw;
	return String(entry.id ?? "").split(":").pop() ?? "";
}
/**
* 某 preset 的 standing 挂载。按 presetId 精确命中；无 presetId 或未命中时回落
* 单挂载场景（只有一个 preset 挂着时它就是目标）。
*/
function presetMountOf(presetId) {
	const mounts = standingMounts();
	if (presetId !== void 0 && presetId.length > 0) {
		const hit = mounts.find((m) => String(m.presetId ?? "") === presetId);
		if (hit) return hit;
	}
	return mounts.length === 1 ? mounts[0] : void 0;
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
function livePresetRows(ctx, presetId, agentCtx) {
	let mount = presetMountOf(presetId);
	if (!mount && agentCtx !== void 0) {
		const viaModule = standingMountForAgent(agentCtx);
		if (viaModule?.tree) {
			mount = viaModule;
			captureStandingMount(mount);
		}
	}
	const out = [];
	if (!mount?.tree) return out;
	let entries;
	try {
		const it = mount.tree.entries();
		entries = Array.isArray(it) ? it : [...it];
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!isMcpEntry(entry)) continue;
		const entryId = String(entry.id ?? "");
		if (!entryId) continue;
		const rowId = rowIdOfEntry(entry);
		if (!rowId) continue;
		const config = configOfEntryOptions(entry.options);
		out.push({
			entryId,
			rowId,
			disabled: entry.disabled === true,
			running: entry.fiber !== void 0,
			entry,
			...config ? { config } : {}
		});
	}
	return out;
}
//#endregion
//#region src/preset-mcp.ts
/** 短 rowId 回落 serverName（preset 文本缺 serverName 键时用；覆盖已知例外）。 */
function fallbackServerName(rowId) {
	if (rowId === "mcp-anki") return "anki-mcp";
	return rowId.replace(/^mcp-/, "");
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
function parsePresetMcpText(text) {
	const out = /* @__PURE__ */ new Map();
	const blocks = String(text ?? "").split(/(?=^- id:\s*)/m);
	for (const block of blocks) {
		const idMatch = /^-\s*id:\s*"?([^"\s]+)"?\s*$/m.exec(block);
		if (!idMatch) continue;
		const rowId = idMatch[1];
		if (!rowId.startsWith("mcp-")) continue;
		const sn = /^\s*serverName:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/m.exec(block);
		const tr = /^\s*transport:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/m.exec(block);
		const tm = /^\s*toolCallTimeoutMs:\s*['"]?(\d+)['"]?\s*(?:#.*)?$/m.exec(block);
		const cmd = /^\s*command:\s*['"]?([^'"\n]+?)['"]?\s*(?:#.*)?$/m.exec(block);
		const cwd = /^\s*cwd:\s*['"]?([^'"\n]+?)['"]?\s*(?:#.*)?$/m.exec(block);
		const url = /^\s*url:\s*['"]?([^'"\n\s]+?)['"]?\s*(?:#.*)?$/m.exec(block);
		const fos = /^\s*failOnStartupError:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/m.exec(block);
		const args = parseYamlStringList(block, "args");
		const env = parseYamlStringMap(block, "env");
		const headers = parseYamlStringMap(block, "headers");
		const command = cmd ? processScalar(cmd[1].trim()) : void 0;
		let transport = tr ? normalizeTransportToken(tr[1]) ?? tr[1].toLowerCase() : null;
		if (!transport) {
			if (command !== void 0) transport = "stdio";
			else if (url) transport = "streamable-http";
		}
		const parsed = {
			serverName: sn ? sn[1] : fallbackServerName(rowId),
			transport
		};
		if (tm) {
			const n = Number(tm[1]);
			if (Number.isFinite(n) && n > 0) parsed.toolCallTimeoutMs = n;
		}
		if (command !== void 0) parsed.command = command;
		if (args) parsed.args = args.map((a) => processScalar(a));
		if (env) {
			const outEnv = {};
			for (const [k, v] of Object.entries(env)) outEnv[k] = processScalar(v);
			parsed.env = outEnv;
		}
		if (cwd) parsed.cwd = processScalar(cwd[1].trim());
		if (url) parsed.url = processScalar(url[1].trim());
		if (headers) {
			const outHeaders = {};
			for (const [k, v] of Object.entries(headers)) outHeaders[k] = processScalar(v);
			parsed.headers = outHeaders;
		}
		if (fos) {
			const token = unquoteYamlScalar(fos[1].trim()).toLowerCase();
			if (token === "true") parsed.failOnStartupError = true;
			else if (token === "false") parsed.failOnStartupError = false;
		}
		out.set(rowId, parsed);
	}
	return out;
}
/** transport 显式值归一（mcp-convert.ts:112-113 同规则；未知返回 undefined 交上层原样保留）。 */
function normalizeTransportToken(token) {
	const t = token.toLowerCase();
	if (t === "stdio" || t === "command") return "stdio";
	if (t === "streamable-http" || t === "http" || t === "sse") return "streamable-http";
}
/** 去 YAML 标量外层引号（单/双引号各一层；`!!js` 前缀保留给 evalJsScalar 处理）。 */
function unquoteYamlScalar(value) {
	const v = value.trim().replace(/^!!js\s+/, "");
	if (v.length >= 2 && (v.startsWith("\"") && v.endsWith("\"") || v.startsWith("'") && v.endsWith("'"))) {
		const inner = v.slice(1, -1);
		return v.startsWith("'") ? inner.replace(/''/g, "'") : inner;
	}
	return v;
}
/**
* `!!js "..."` 标量求值（与 loader 加载时语义对齐的子集）：
* 表达式可以是任意 JS（模板字面量/三元/|| 回落，如
* `process.env.X ? `Bearer ${process.env.X}` : ''`），用当前 process.env
* 求值；无 `!!js` 前缀/求值失败返回 undefined（调用方回落原串）。
*
* 信任假设（WARN-1）：预设文件是本地可信配置，与 loader 的 `!!js` 求值信任
* 等级相同（loader 加载时同样求值）。若预设文件来源不可信（远端拉取未审
* 核），不要启用本解析——`new Function` 可执行任意 JS。
* 求值失败（表达式抛错）返回 undefined → 调用方回落原串（原串可能含
* `process.env.X` 字面量，发出后由远端报可见错误，不静默吞错）。
*/
function evalJsScalar(value) {
	const raw = value.trim();
	const m = /^!!js\s+([\s\S]+)$/.exec(raw);
	if (!m) return void 0;
	let expr = m[1].trim();
	if (expr.length >= 2 && expr.startsWith("'") && expr.endsWith("'")) expr = expr.slice(1, -1).replace(/''/g, "'");
	else if (expr.length >= 2 && expr.startsWith("\"") && expr.endsWith("\"")) try {
		expr = JSON.parse(expr);
	} catch {
		return;
	}
	expr = expr.trim();
	if (!expr) return void 0;
	try {
		const out = new Function("process", `return (${expr});`)({ env: process.env });
		if (out === void 0 || out === null) return "";
		return typeof out === "string" ? out : String(out);
	} catch {
		return;
	}
}
/**
* 标量全处理（P1 直读统一入口）：`!!js` 先求值，否则去引号，最后解 `${VAR}`。
* 调用方一律走本函数，不再自行组合 unquote/eval/resolve（防 `!!js` 前缀被
* unquote 提前剥掉导致 eval 失效）。
* WARN-6：`!!js` 求值成功分支跳过二次 `${VAR}` 展开（loader 不二次展开；
* 求值结果里的字面 `${}` 原样保留，不改写密钥）。
*/
function processScalar(raw) {
	const evaluated = evalJsScalar(raw);
	if (evaluated !== void 0) return evaluated;
	return resolveEnvRefsInText(unquoteYamlScalar(raw));
}
/** 文本内 `${VAR}` → process.env 求值；缺失保留占位符（与 resolveServersEnv 同语义）。 */
function resolveEnvRefsInText(value) {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
		const env = process.env[name];
		return env !== void 0 ? env : `\${${name}}`;
	});
}
/**
* 块内 YAML 字符串列表抓取（args 形态）：
* flow 单行 `args: ['a', 'b']` 优先（quote-aware 逗号切分，单/双引号内逗号、
* Windows 反斜杠、CJK 均保留）；无 flow 才按 block 节（`args:` 独占一行 +
* 缩进更深的 `- item` 行）逐行收，直到遇到同级/更浅键。
* 值原串保留（`!!js`/引号/注释均不动，上层 processScalar 统一处理）。
*/
function parseYamlStringList(block, key) {
	const lines = block.split("\n");
	const headAnyRe = new RegExp(`^(\\s*)${key}:(.*)$`);
	let headLine = -1;
	let baseIndent = 0;
	let headRest = "";
	for (let i = 0; i < lines.length; i += 1) {
		const m = headAnyRe.exec(lines[i]);
		if (m) {
			headLine = i;
			baseIndent = m[1].length;
			headRest = stripTrailingComment(m[2].trim());
			break;
		}
	}
	if (headLine < 0) return void 0;
	if (headRest.startsWith("[")) return parseFlowStringList(headRest);
	if (headRest !== "") return void 0;
	const out = [];
	for (let i = headLine + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
		if ((line.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) break;
		const item = /^\s*-\s+(.*?)\s*$/.exec(line);
		if (!item) break;
		out.push(stripTrailingComment(item[1]));
	}
	return out;
}
/**
* flow 单行字符串列表解析（quote-aware）：
* `['-u', 'D:\\a\\b.py']` → [`-u`, `D:\\a\\b.py`]。外层 `[]` 必备；
* 项内单/双引号配对剥离（单引号内 `''` 转义还原），引号内逗号不切分；
* 反斜杠原样保留（Windows 路径）；空项跳过。格式非法返回 undefined。
*/
function parseFlowStringList(rest) {
	const s = rest.trim();
	if (!s.startsWith("[")) return void 0;
	const end = findFlowListEnd(s);
	if (end < 0) return void 0;
	const body = s.slice(1, end);
	const out = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let hasToken = false;
	const push = () => {
		if (!hasToken) return;
		const token = cur.trim();
		hasToken = false;
		cur = "";
		if (token === "") return;
		out.push(token);
	};
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i];
		if (inSingle) {
			if (ch === "'") {
				if (body[i + 1] === "'") {
					cur += "'";
					i += 1;
				} else inSingle = false;
			} else cur += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < body.length) {
				cur += ch + body[i + 1];
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			else cur += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			hasToken = true;
			continue;
		}
		if (ch === ",") {
			push();
			continue;
		}
		if (/\s/.test(ch) && !hasToken) continue;
		hasToken = true;
		cur += ch;
	}
	push();
	return out;
}
/** flow 列表外层 `]` 定位（跳过引号内 `]`；反斜杠转义识别）。 */
function findFlowListEnd(s) {
	let inSingle = false;
	let inDouble = false;
	for (let i = 1; i < s.length; i += 1) {
		const ch = s[i];
		if (inSingle) {
			if (ch === "'") {
				if (s[i + 1] === "'") i += 1;
				else inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			continue;
		}
		if (ch === "]") return i;
	}
	return -1;
}
/**
* 块内 YAML 字符串字典抓取（env/headers 形态）：
* flow 单行 `env: {K: v}` 暂不支持（实块均为 block 形态，遇 flow 返回 undefined
* 交上层缺省；NIT-4 注记）；block 节定位，收 `KEY: value` 行；非标量值跳过。
* 值原串保留（`!!js` 交上层 processScalar 统一求值）。
*/
function parseYamlStringMap(block, key) {
	const lines = block.split("\n");
	const headRe = new RegExp(`^(\\s*)${key}:\\s*(?:#.*)?$`);
	let start = -1;
	let baseIndent = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const m = headRe.exec(lines[i]);
		if (m) {
			start = i;
			baseIndent = m[1].length;
			break;
		}
	}
	if (start < 0) return void 0;
	const out = {};
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (indent <= baseIndent) break;
		const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
		if (!kv) break;
		const rawValue = kv[2];
		const value = stripTrailingComment(rawValue);
		if (value === "") continue;
		const next = lines[i + 1];
		const nextIndent = next !== void 0 && !/^\s*$/.test(next) ? next.match(/^\s*/)?.[0].length ?? 0 : 0;
		if (next !== void 0 && !/^\s*$/.test(next) && nextIndent > indent && !/^\s*-\s+/.test(next)) continue;
		out[kv[1]] = value;
	}
	return out;
}
/** 剥行尾注释：引号外的 ` #` 起为注释；引号内/反引号模板内的 # 保留（WARN-7）。
*
* 跟踪单引号（含 `''` 转义）/双引号（反斜杠转义）/反引号模板（含 `${}` 嵌套
* 的引号不干扰外层反引号状态）。
*/
function stripTrailingComment(raw) {
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (inBacktick) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === "`") {
				inBacktick = false;
				continue;
			}
			if (ch === "$" && raw[i + 1] === "{") {
				let depth = 1;
				i += 2;
				let q = null;
				for (; i < raw.length; i += 1) {
					const c = raw[i];
					if (q) {
						if (c === "\\") {
							i += 1;
							continue;
						}
						if (c === q) q = null;
						continue;
					}
					if (c === "'" || c === "\"" || c === "`") {
						q = c;
						continue;
					}
					if (c === "{") depth += 1;
					else if (c === "}") {
						depth -= 1;
						if (depth === 0) break;
					}
				}
				continue;
			}
			continue;
		}
		if (ch === "`" && !inSingle && !inDouble) {
			inBacktick = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			if (inSingle && raw[i + 1] === "'") {
				i += 1;
				continue;
			}
			inSingle = !inSingle;
			continue;
		}
		if (ch === "\"" && !inSingle) {
			if (!(i > 0 && raw[i - 1] === "\\")) inDouble = !inDouble;
			continue;
		}
		if (ch === "#" && !inSingle && !inDouble && !inBacktick && i > 0 && /\s/.test(raw[i - 1])) return raw.slice(0, i).trimEnd();
	}
	return raw.trim();
}
/** 由 PresetMcpParsed 组装挂载 config（transport 归一失败/缺失时返回 undefined）。 */
function presetConfigOf(parsed) {
	const t = parsed.transport;
	const transport = t === "stdio" || t === "streamable-http" ? t : void 0;
	if (!transport) return void 0;
	const config = {
		serverName: parsed.serverName,
		transport
	};
	if (transport === "stdio") {
		if (parsed.command === void 0) return void 0;
		config.command = parsed.command;
		if (parsed.args && parsed.args.length > 0) config.args = [...parsed.args];
		if (parsed.env && Object.keys(parsed.env).length > 0) config.env = { ...parsed.env };
		if (parsed.cwd !== void 0) config.cwd = parsed.cwd;
	} else {
		if (parsed.url === void 0) return void 0;
		config.url = parsed.url;
		if (parsed.headers && Object.keys(parsed.headers).length > 0) config.headers = { ...parsed.headers };
	}
	if (parsed.toolCallTimeoutMs !== void 0) config.toolCallTimeoutMs = parsed.toolCallTimeoutMs;
	if (parsed.failOnStartupError !== void 0) config.failOnStartupError = parsed.failOnStartupError;
	return config;
}
/**
* 按 serverName 在某 preset 的 standing 行里定位（mcp_call 预设直调用，0.5.6）。
* serverName 大小写敏感精确匹配（与 serverNameOf/config.serverName 同语义）；
* preset 文本缺 serverName 键时按 fallbackServerName 回落（与 listPresetMcpRows
* 同规则，覆盖 mcp-anki→anki-mcp 例外）。若重复取首行（上游保证唯一）。
*/
async function findPresetRowByServerName(ctx, presetId, serverName, agentCtx) {
	const { rows } = await listPresetMcpRowsOrThrow(ctx, presetId, agentCtx);
	return rows.find((r) => r.serverName === serverName);
}
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
async function listPresetMcpRows(ctx, presetId, agentCtx) {
	try {
		const out = await listPresetMcpRowsOrThrow(ctx, presetId, agentCtx);
		return {
			...out,
			presetKey: out.presetPath.length > 0 ? out.presetPath : presetKeyOf(presetId)
		};
	} catch {
		return {
			rows: [],
			presetPath: "",
			presetKey: presetKeyOf(presetId)
		};
	}
}
/**
* 严格版：preset 不可得时**抛错**（"not in compositionInventory" / 文件面读不到文本）。
*
* 与 {@link listPresetMcpRows} 的分工：调用方需要区分「preset 不存在」与
* 「该 preset 恰好没有 MCP 行」时用本函数；面板批量渲染走包装版（不因一个
* 异常 preset 打空整页）。文件面行为与 0.6.0 逐字节一致，selftest 直接覆盖它。
*/
async function listPresetMcpRowsOrThrow(ctx, presetId, agentCtx) {
	const presets = ctx.agentPresets;
	const live = livePresetRows(ctx, presetId, agentCtx);
	const found = (await rawInventory(presets)).find((c) => String(c?.id ?? "") === presetId);
	if (live.length === 0 && !found) throw new Error(`preset "${presetId}" not in compositionInventory`);
	const presetPath = await presetPathOf(presets, presetId);
	if (live.length === 0 && presetPath.length === 0) throw new Error(`preset "${presetId}" has no path`);
	let parsed;
	if (presetPath.length > 0 && typeof presets.read === "function") parsed = parsePresetMcpText(String(await presets.read(presetId)));
	if (live.length > 0) return {
		rows: livePresetRowsToRows(live, parsed, presetPath),
		presetPath
	};
	const rows = [];
	for (const r of await inventoryRows(presets, presetId)) {
		const rowId = r.entryId.split(":").pop() ?? r.entryId;
		const info = parsed?.get(rowId);
		const config = info ? presetConfigOf(info) : void 0;
		rows.push({
			entryId: r.entryId,
			rowId,
			serverName: info?.serverName ?? fallbackServerName(rowId),
			transport: info?.transport ?? null,
			...info?.toolCallTimeoutMs !== void 0 ? { toolCallTimeoutMs: info.toolCallTimeoutMs } : {},
			disabled: r.enabled === false,
			running: r.fiberState !== void 0 && r.fiberState !== null,
			file: presetPath,
			...config ? { config } : {}
		});
	}
	return {
		rows,
		presetPath
	};
}
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
function livePresetRowsToRows(live, parsed, presetPath) {
	const rows = [];
	for (const row of live) {
		const info = parsed?.get(row.rowId);
		const config = row.config ?? (info ? presetConfigOf(info) : void 0);
		rows.push({
			entryId: row.entryId,
			rowId: row.rowId,
			serverName: config?.serverName ?? info?.serverName ?? fallbackServerName(row.rowId),
			transport: config?.transport ?? info?.transport ?? null,
			...config?.toolCallTimeoutMs !== void 0 ? { toolCallTimeoutMs: config.toolCallTimeoutMs } : info?.toolCallTimeoutMs !== void 0 ? { toolCallTimeoutMs: info.toolCallTimeoutMs } : {},
			disabled: row.disabled,
			running: row.running,
			file: presetPath,
			...config ? { config } : {}
		});
	}
	return rows;
}
/**
* state.json `mcp` 段的行来源键。
*
* 0.2.0 起 preset 不再有文件路径（`AgentPreset` 无 `path`、`read()` 已删、
* desktop 的 preset 内联在 `cordis.yml`），故键退化为 preset id。语义未变：
* 该键只回答「这份行集属于哪个来源」，插件本就是「一个 preset 一棵树」的模型。
* @param presetId - preset id。
* @returns `preset:<id>` 形态的稳定键。
*/
function presetKeyOf(presetId) {
	return `preset:${presetId}`;
}
/** compositionInventory 里某 preset 的 MCP 行（entryId/enabled/fiberState 快照）。 */
async function inventoryRows(presets, presetId) {
	let inventory;
	try {
		inventory = await presets.compositionInventory?.();
	} catch {
		return [];
	}
	const found = (Array.isArray(inventory) ? inventory : []).find((c) => String(c?.id ?? "") === presetId);
	const out = [];
	for (const r of found?.rows ?? []) {
		if (String(r?.moduleName ?? "") !== "@deepseek-ai/dsh-mcp-client") continue;
		const entryId = String(r?.entryId ?? "");
		if (!entryId) continue;
		out.push({
			entryId,
			...r?.enabled !== void 0 ? { enabled: r.enabled } : {},
			...r?.fiberState !== void 0 ? { fiberState: r.fiberState } : {}
		});
	}
	return out;
}
/**
* 按长 entryId 反查其所属 preset 行（toggleMcp 预设兜底用）。
*
* 0.7.0：优先在 live standing 树里直接命中该 entryId —— 句柄本身就是行，
* 不必再经 inventory + `read()` + 正则；只有 live 树不可得时才回落
* 「逐 preset 扫 compositionInventory + 读 preset 文件」的旧路径。
*/
async function findPresetRowByEntryId(ctx, entryId, agentCtx) {
	const presets = ctx.agentPresets;
	const candidatePresetIds = [await composedPresetId(ctx, agentCtx), ...await inventoryPresetIds(presets)];
	for (const pid of candidatePresetIds) {
		if (!pid) continue;
		const hit = livePresetRows(ctx, pid, agentCtx).find((r) => r.entryId === entryId);
		if (!hit) continue;
		const presetPath = await presetPathOf(presets, pid);
		const config = hit.config;
		return {
			presetId: pid,
			presetPath,
			presetKey: presetPath.length > 0 ? presetPath : presetKeyOf(pid),
			row: {
				entryId: hit.entryId,
				rowId: hit.rowId,
				serverName: config?.serverName ?? fallbackServerName(hit.rowId),
				transport: config?.transport ?? null,
				...config?.toolCallTimeoutMs !== void 0 ? { toolCallTimeoutMs: config.toolCallTimeoutMs } : {},
				disabled: hit.disabled,
				running: hit.running,
				file: presetPath,
				...config ? { config } : {}
			}
		};
	}
	const inventory = await rawInventory(presets);
	for (const c of inventory) {
		const pid = String(c?.id ?? "");
		if (!pid) continue;
		const hit = (c.rows ?? []).find((r) => String(r?.entryId ?? "") === entryId && String(r?.moduleName ?? "") === "@deepseek-ai/dsh-mcp-client");
		if (!hit) continue;
		const presetPath = await presetPathOf(presets, pid);
		if (!presetPath) continue;
		let parsed;
		try {
			parsed = parsePresetMcpText(String(await presets.read?.(pid)));
		} catch {
			continue;
		}
		const rowId = entryId.split(":").pop() ?? entryId;
		const info = parsed.get(rowId);
		const mountConfig = info ? presetConfigOf(info) : void 0;
		const fiberState = hit?.fiberState;
		return {
			presetId: pid,
			presetPath,
			presetKey: presetPath.length > 0 ? presetPath : presetKeyOf(pid),
			row: {
				entryId,
				rowId,
				serverName: info?.serverName ?? fallbackServerName(rowId),
				transport: info?.transport ?? null,
				...info?.toolCallTimeoutMs !== void 0 ? { toolCallTimeoutMs: info.toolCallTimeoutMs } : {},
				disabled: hit?.enabled === false,
				running: fiberState !== void 0 && fiberState !== null,
				file: presetPath,
				...mountConfig ? { config: mountConfig } : {}
			}
		};
	}
}
/** 当前会话组合的 preset id（拿不到返回 ''）。 */
async function composedPresetId(ctx, agentCtx) {
	if (agentCtx === void 0) return "";
	try {
		return ctx.agentPresets.composedPreset(agentCtx) ?? "";
	} catch {
		return "";
	}
}
async function rawInventory(presets) {
	try {
		const inventory = await presets.compositionInventory?.();
		return Array.isArray(inventory) ? inventory : [];
	} catch {
		return [];
	}
}
/** compositionInventory 里的全部 preset id。 */
async function inventoryPresetIds(presets) {
	return (await rawInventory(presets)).map((c) => String(c?.id ?? "")).filter((id) => id.length > 0);
}
/** 某 preset 的组合文件绝对路径（0.2.0 起不存在，返回 ''）。 */
async function presetPathOf(presets, presetId) {
	try {
		const path = (await presets.resolve?.(presetId))?.path;
		return typeof path === "string" ? path : "";
	} catch {
		return "";
	}
}
//#endregion
//#region src/pending.ts
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
/** 待生效队列（进程内存态；重启后由 state.json.desired + syncPresetFiles 承接）。 */
const pendingMcp = /* @__PURE__ */ new Map();
/**
* 解析待生效意图对应的行句柄：loader 优先，preset 行回落 standing 树（0.5.7）。
* 两者都 miss 才视为行已失效（调用方清队列）。
*/
function resolvePendingEntry(ctx, entryId) {
	try {
		const entry = ctx.loader.resolve(entryId);
		if (entry) return entry;
	} catch {}
	return findStandingEntryById(entryId);
}
/**
* 应用整条待生效队列：对每项 entry.update(desired)；用户启用方向 markUserEnabled
* （清 AI 标记 → 转为「用户打开」语义，回收器不再回收）。成功即从队列清除；
* 失败保留（下个边界重试）。返回实际应用数。调用方负责收尾 single invalidateMcp。
*/
async function applyPendingMcp(deps) {
	const { ctx } = deps;
	let applied = 0;
	for (const [entryId, pending] of [...pendingMcp.entries()]) try {
		const entry = resolvePendingEntry(ctx, entryId);
		if (!entry || !isMcpEntry(entry)) {
			pendingMcp.delete(entryId);
			continue;
		}
		await entry.update({ disabled: pending.disabled });
		if (!pending.disabled && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
		pendingMcp.delete(entryId);
		applied += 1;
		ctx.logger.info?.(`mcp-skill-panel: applied pending toggle ${entryId} → disabled=${pending.disabled}`);
	} catch (error) {
		ctx.logger.warn?.(`mcp-skill-panel: pending apply "${entryId}" failed: ${messageOf$1(error)}`);
	}
	applied += await applyStateResidue(deps, await readState().catch(() => void 0));
	return applied;
}
/**
* state.json 残留补齐（见 applyPendingMcp ②）。只改 live（entry.update），
* 不动 preset 文件与 lastApplied（lastApplied 语义 = 文件上次状态，供物化判定）。
*
* 0.7.0 数据源迁移：**有预设文件时行为不变**（按文件路径取键、读文件判外部改动）；
* 文件不可得时（DSH 0.2.0 起 preset 不再落盘）改用 `preset:<id>` 键，外部改动判据
* 退化为「live 树事实 vs 记录值」—— 此时没有第三方文本可被外部编辑，该判据等价。
*/
async function applyStateResidue(deps, state) {
	const { ctx } = deps;
	const mcp = state?.mcp;
	if (!mcp || Object.keys(mcp).length === 0) return 0;
	let applied = 0;
	let residueCleared = false;
	/** 每个行来源键下的待应用项（有文件时键=文件路径，否则键=`preset:<id>`）。 */
	const buckets = /* @__PURE__ */ new Map();
	for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
		if (!isMcpEntry(entry)) continue;
		if (pendingMcp.has(entry.id)) continue;
		const rowId = String(entry.options.id ?? "");
		if (!rowId) continue;
		const tree = entry.parent?.tree;
		const file = typeof tree?.filename === "string" && tree.filename.length > 0 ? tree.filename : null;
		const key = file ?? presetKeyFor(entry, rowId, mcp);
		if (!key) continue;
		const rowState = mcp[key]?.[rowId];
		if (!rowState || typeof rowState.desired !== "boolean") continue;
		if (rowState.desired === entry.disabled) continue;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				file,
				items: []
			};
			buckets.set(key, bucket);
		}
		bucket.items.push({
			entry,
			rowState
		});
	}
	for (const [key, bucket] of buckets) {
		let text = "";
		if (bucket.file !== null) try {
			text = await readFile(bucket.file, "utf8");
		} catch {
			continue;
		}
		let keyCleared = false;
		for (const { entry, rowState } of bucket.items) {
			const cur = bucket.file !== null ? rowDisabledState(text, String(entry.options.id)) : entry.disabled ?? null;
			if (cur !== rowState.lastApplied) {
				if (bucket.file !== null) {
					rowState.lastApplied = cur;
					keyCleared = true;
					ctx.logger.info?.(`mcp-skill-panel: state-residue ${entry.id}: preset file externally modified, aligning lastApplied`);
					continue;
				}
			}
			try {
				await entry.update({ disabled: rowState.desired });
				if (!rowState.desired && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
				applied += 1;
				ctx.logger.info?.(`mcp-skill-panel: applied state-residue toggle ${entry.id} → disabled=${rowState.desired}`);
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: state-residue apply "${entry.id}" failed: ${messageOf$1(error)}`);
			}
		}
		if (keyCleared) residueCleared = true;
	}
	if (residueCleared) await writeState(state ?? {}).catch(() => void 0);
	return applied;
}
/**
* 无预设文件时的行来源键：优先用行所属 preset 反查 `preset:<id>`；反查不到时
* 在 state 里找「含该 rowId 的 preset: 键」兜底（多 preset 下 rowId 唯一即可命中）。
*/
function presetKeyFor(entry, rowId, mcp) {
	const pid = presetIdOfEntry(entry);
	if (pid.length > 0) {
		const key = presetKeyOf(pid);
		if (mcp[key]) return key;
	}
	for (const key of Object.keys(mcp)) if (key.startsWith("preset:") && mcp[key]?.[rowId]) return key;
	return null;
}
/** 当前待生效项数量（面板/诊断用）。 */
function pendingMcpCount() {
	return pendingMcp.size;
}
//#endregion
//#region src/row-display.ts
/** 行状态徽标判定（纯函数，selftest 表驱动回归）。
* 语义（2026-08-27 发布前独立审查修正）：active/idle 以 **liveTools**（真实注册）
* 为准——displayTools 含 catalog 快照兜底，用它判定 active 会掩盖「scope 解析
* 失败但 catalog 有旧快照」的故障现场（面板显示健康而实际工具未注册）。
* displayTools 仅用于 tools/tokens 数值展示与停用态回填。
*/
function computeStatus(disabled, running, liveTools) {
	if (disabled) return "disabled";
	if (!running) return "failed";
	return liveTools > 0 ? "active" : "idle";
}
/** 展示用读数判定（0.6.0 诚实上报；纯函数，selftest 表驱动回归）。
*
* 与 computeStatus 的区别：这里决定 tools/tokens **显示什么数字**。
* 此前两条路径都写成 `liveTools > 0 ? liveTools : catalogInfo?.tools.length ?? 0`，
* 于是「行启用且在跑、却一个工具都没注册」的故障现场被目录快照伪装成健康
* （2026-09-13 实测 codegraph：缺 `.codegraph` 索引 → 子进程空转零注册，
* 面板却渲染 running=true/tools=4，而 Host 注册表 mcp__* = 0，mcp_call 60s 超时）。
*
* 现在：**启用 + 在跑 + liveTools=0 → unregistered=true 且 tools=0**（不再回落目录快照），
* 目录快照只回落到 `toolList`（工具级禁用 UI 仍可用）。停用行照旧回落快照，
* 保留「该 server 有哪些工具可被 mcp_search 检索」的语义。
*/
function rowDisplay(disabled, running, liveTools, catalogTools) {
	const unregistered = !disabled && running && liveTools <= 0;
	if (unregistered) return {
		displayTools: 0,
		unregistered
	};
	return {
		displayTools: liveTools > 0 ? liveTools : catalogTools,
		unregistered
	};
}
/** 模型面可见性作用域判定（0.6.0 收口；纯函数，selftest 表驱动回归）。
*
* 起因（发布前独立审查 cbc-W1）：`modelVisible` 只扣「AI 临时启用」，**不扣**
* `middleLayerHides === 'all'` —— 而装配过滤在 `gate.on && gate.hideAll` 时把该
* server 的工具**全部**剔除（`filter.ts`）。于是 `'all'` + 本会话 gate 打开时，
* 卡片仍挂「模型可见」，与本次装配结果相反（同类失真本批已在能力摘要表
* `buildSummaryHeader` 上修过，行徽标漏了）。
*
* @param disabled - 该行是否停用（停用行不进装配）。
* @param aiOwned - 该行是否正被 AI 经 dsh_mcp_call 临时启用保活（对模型不可见）。
* @param hideAllActive - 中间层生效且隐藏范围为 `'all'`（等价于 filter.ts 的 `gate.on && gate.hideAll`）。
* @returns `'direct'`（进本次装配）/ `'via-middle-layer'`（不进装配，改经中间层取用）/ `'hidden'`。
*/
function modelVisibleScope(disabled, aiOwned, hideAllActive) {
	if (disabled || aiOwned) return "hidden";
	return hideAllActive ? "via-middle-layer" : "direct";
}
//#endregion
//#region src/model-route.ts
/**
* 挂载可选服务捕获：服务在时填 holder，随作用域卸载时清空。
* @returns holder —— 装配过滤同步读；服务缺失时字段为 undefined。
*/
function installRouteServices(ctx) {
	const holder = {};
	ctx.inject(["sessionProjections"], (scoped) => {
		holder.projections = scoped.sessionProjections;
		return () => {
			holder.projections = void 0;
		};
	});
	ctx.inject(["agentDefaultModel"], (scoped) => {
		holder.defaultModel = scoped.agentDefaultModel;
		return () => {
			holder.defaultModel = void 0;
		};
	});
	ctx.inject(["llm"], (scoped) => {
		holder.llm = scoped.llm;
		return () => {
			holder.llm = void 0;
		};
	});
	return holder;
}
/** 两个字段都是非空字符串才算一条可用路由。 */
function asRoute(value) {
	if (!value) return void 0;
	const provider = value.provider;
	const model = value.model;
	if (typeof provider !== "string" || provider.length === 0) return void 0;
	if (typeof model !== "string" || model.length === 0) return void 0;
	return {
		provider,
		model
	};
}
/**
* 解析该 agent 下一个请求会用的模型路由。
* 三级回退与 dsh-api-session-controller 一致；每步都对异常兜底
* （装配过滤是热路径，任何抛出都会打断整轮提示词装配）。
* @param services - 可选服务 holder（{@link installRouteServices} 产出）。
* @param agent - 本次装配所属 agent；缺省（诊断装配）返回 undefined。
* @returns 解析到的路由，或全部落空时 undefined。
*/
function resolveRoute(services, agent) {
	if (!agent) return void 0;
	try {
		const state = services.projections?.stateOf(agent.session, "modelSelection");
		const pending = asRoute(state?.pending);
		if (pending) return pending;
	} catch {}
	try {
		const logged = asRoute(agent.session.requestHeader()?.config);
		if (logged) return logged;
	} catch {}
	try {
		return asRoute(services.defaultModel?.currentSelection());
	} catch {
		return;
	}
}
/** 一条路由的精确键（provider/model）——按模型的覆盖项用它。 */
function routeKey(route) {
	return `${route.provider}/${route.model}`;
}
/**
* 按路由决定 AI 中间层是否对本次装配生效。
*
* 查表顺序 `provider/model` → `provider` → 总开关；没有任何覆盖项时
* 等价于旧行为（纯总开关），所以升级零配置零行为变化。
* 未解析出路由时保守走总开关 —— 宁可维持既有行为，也不静默改变工具集。
* @param route - {@link resolveRoute} 的结果。
* @param master - 面板总开关（state.json 的 config.autoManage）。
* @param byRoute - 覆盖表（键为 provider 或 provider/model）。
* @returns 生效与否及其依据。
*/
function routeDecision(route, master, byRoute) {
	if (!route) return {
		on: master,
		source: "no-route",
		route: void 0
	};
	if (byRoute) {
		const exact = byRoute[routeKey(route)];
		if (typeof exact === "boolean") return {
			on: exact,
			source: "model",
			route
		};
		const byProvider = byRoute[route.provider];
		if (typeof byProvider === "boolean") return {
			on: byProvider,
			source: "provider",
			route
		};
	}
	return {
		on: master,
		source: "master",
		route
	};
}
/**
* 把 {@link RouteDecision} 投影成面板视图（`autoManageActive` / `/models` 的 `active`）。
*
* 抽出来的理由：`/state`（collect.ts）与 `/models`（routes.ts）两处都要这份投影，
* 各自手写一遍 `decision.route?.provider ?? null` 就有了两套漂移点 —— 面板上「哪条
* 是当前路由」的高亮与实际生效依据必须来自同一个函数。`null`（不是 `undefined`）
* 是刻意的：这两个视图都要过 JSON，`undefined` 字段会整个消失。
* @param decision - `catalogRuntime.decisionFor(agent)` 或 `routeDecision(...)` 的结果。
*/
function activeRouteView(decision) {
	return {
		on: decision.on,
		source: decision.source,
		provider: decision.route?.provider ?? null,
		model: decision.route?.model ?? null
	};
}
/**
* 抓取 provider / 模型目录（`/models` 的唯一数据来源）。
*
* 三条降级路径都是刻意的，且都**不抛**（`/models` 是开放读端点，任何抛都会变成
* 500 把整张卡片打成错误态）：
* - `llm` 缺失（精简组合 / 服务未注册）→ 空目录；
* - `listProviders()` 抛错 → 空目录；
* - 单个 provider 的 `listModels()` 抛错 → **只**该 provider 空模型表，其余照常。
* `listModels` 可能触达 adapter 网络，故第三条是必需的（一个坏 adapter 不该拖垮整页）。
* 结果按 provider 字典序排序：UI 折叠顺序与 selftest 断言都不该受扇出完成顺序影响。
* @param llm - 经 ctx.inject 捕获的 llm 服务引用（直接读 ctx.llm 会抛）。
*/
async function fetchProviderCatalog(llm) {
	if (!llm) return [];
	let list;
	try {
		list = llm.listProviders();
	} catch {
		return [];
	}
	const providers = [];
	await Promise.all(list.map(async (entry) => {
		let models = [];
		try {
			models = await llm.listModels(entry.id);
		} catch {
			models = [];
		}
		providers.push({
			provider: entry.id,
			name: entry.name,
			models: models.map((model) => ({
				id: model.id,
				name: model.name
			}))
		});
	}));
	providers.sort((a, b) => a.provider.localeCompare(b.provider));
	return providers;
}
/**
* 缓存新鲜度判定（纯函数：TTL 命中 / 过期由 selftest 直接断言，不必起 HTTP 服务）。
* @param fetchedAt - 上次**真实抓取**的时间戳；null = 从未抓取过。
* @param now - 当前时间戳。
* @param ttlMs - TTL 毫秒数（端点传 routes.ts 的 `MODELS_TTL_MS`）。
* @returns true = 可直接复用缓存，false = 必须重新抓取。
*/
function modelsCacheFresh(fetchedAt, now, ttlMs) {
	return fetchedAt !== null && now - fetchedAt < ttlMs;
}
//#endregion
//#region src/collect.ts
/** 分域缓存 TTL：事件驱动失效为主，TTL 只是兜底（事件丢失场景） */
const DOMAIN_TTL_MS = 6e4;
/** 已确认的 skill 状态在 collectState 中覆盖 snapshot 旧值的有效期 */
const CONFIRMED_SKILL_TTL_MS = 6e4;
/**
* 最近一次 toggle 确认过的 skill 状态（name → modelInvocable）。
* 服务端轮询用 skills.get 实时读文件确认，早于 snapshot 的发现缓存失效，
* 用它覆盖 collectState 里的陈旧 candidate 值。
*/
const confirmedSkills = /* @__PURE__ */ new Map();
function createDomainCaches() {
	const mcpCache = /* @__PURE__ */ new Map();
	const skillsCache = /* @__PURE__ */ new Map();
	const mcpAggregates = /* @__PURE__ */ new Map();
	const schemasCache = /* @__PURE__ */ new Map();
	return {
		mcpCache,
		skillsCache,
		mcpAggregates,
		schemasCache,
		invalidateMcp: () => {
			mcpCache.clear();
			mcpAggregates.clear();
			schemasCache.clear();
		},
		invalidateSkills: () => skillsCache.clear()
	};
}
function tokenEstimate(parameters) {
	try {
		return Math.max(1, Math.round(JSON.stringify(parameters ?? {}).length / 4));
	} catch {
		return 1;
	}
}
/** 写时清理过期条目（P2-8）：分域缓存 / 聚合 / 已确认 skill 的 Map 长期运行不膨胀。 */
function pruneExpired(map, now) {
	for (const [key, entry] of map) if (now - entry.at >= 6e4) map.delete(key);
}
/**
* 按 scope 共享的 schemas 原始缓存：路径 A（catalog 采集）与路径 B（面板聚合）
* 共用同一份深克隆结果，避免 tools.change 风暴期内重复深克隆。
* key = scopeKey ?? null；TTL 由调用方指定（路径 A 500ms，路径 B 60s）。
*/
function getSchemasView(ctx, caches, scopeKey, ttlMs) {
	const key = scopeKey ?? null;
	const now = Date.now();
	const maxTtl = Math.max(ttlMs, DOMAIN_TTL_MS);
	for (const [k, entry] of caches.schemasCache) if (now - entry.at >= maxTtl) caches.schemasCache.delete(k);
	const hit = caches.schemasCache.get(key);
	if (hit && now - hit.at < ttlMs) return hit.schemas;
	const schemas = scopeKey ? ctx.tools.schemas(scopeKey) : ctx.tools.schemas();
	caches.schemasCache.set(key, {
		at: now,
		schemas
	});
	return schemas;
}
function resolveAgent(ctx, sessionId) {
	if (sessionId) {
		const byId = ctx.agents.get(sessionId);
		if (byId) return byId;
	}
	const roots = ctx.agents.roots();
	if (roots.length > 0) return roots[0];
	return ctx.agents.list()[0];
}
/**
* 进程级共享的 scope key（standing 层）。
*
* 关键坑（2026-08-27 实测）：HTTP 请求路径（routes 的 httpCtx）下既解析不到
* agent（roots/list 空或非目标）也拿不到 agentPresets.standingKeyFor()（该服务
* 视图受限）→ scope key 恒 undefined → schemas 落入空视图，面板聚合全 0
* （filesystem 等「无工具」）。而 apply 早期 ctx 下 standingKeyFor() 可解析
* （快照路径一直正常，lastMcpTools=17）。
* 解法：scope key 在 apply 早期解析一次并缓存（进程级单例），所有路径复用。
*/
let sharedScopeKey;
/** scope key 解析来源（NIT-1：scopeDiag 现场取证用）：'agent' | 'standing' | null。 */
let sharedScopeKeySource = null;
async function resolveCollectScopeKey(ctx, sessionId) {
	if (sharedScopeKey !== void 0) return sharedScopeKey;
	try {
		const agent = resolveAgent(ctx, sessionId);
		if (agent) {
			const key = scopeOf(agent.ctx);
			if (key !== void 0) {
				sharedScopeKey = key;
				sharedScopeKeySource = "agent";
				return key;
			}
		}
	} catch {}
	try {
		const svc = ctx.agentPresets;
		const key = typeof svc.standingKeyFor === "function" ? await svc.standingKeyFor() : void 0;
		if (key !== void 0) {
			sharedScopeKey = key;
			sharedScopeKeySource = "standing";
			return key;
		}
	} catch {}
	return sharedScopeKey;
}
/** scope key 解析来源（/debug scopeDiag 展示用）。 */
function scopeKeySource() {
	return sharedScopeKeySource;
}
function baseView(ctx, agent, cwd) {
	let preset = null;
	try {
		if (agent) preset = ctx.agentPresets.composedPreset(agent.ctx) ?? null;
	} catch {
		preset = null;
	}
	return {
		sessionId: agent ? agent.id : null,
		preset,
		cwd: cwd ?? null
	};
}
/**
* 按 name 去重合并两个 schemas 视图（scoped 优先）。
*
* ⚠️ 2026-08-27 实测结论：`tools.schemas()`（无参全局视图）**不含任何 mcp__ 工具**
* （全部 mcp 工具注册在 scope 层）→ 本合并当前环境恒为 no-op，属**防御性合并**：
* 若未来出现联邦/全局作用域注册的 mcp 工具，此路径才生效。filesystem 等 patch 层
* server 此前「无工具」的真正根因是 HTTP 路径 scope key 解析失败（3872206 共享缓存
* 修复），与全局视图无关——维护时勿按旧注释误判为「全局 realm 有工具」。
* 同名条目 scoped 优先（占位条目会压过全局完整 schema，当前两视图同源不触发）。
*/
function mergeSchemas(scoped, global) {
	if (!global || global.length === 0) return scoped;
	const seen = /* @__PURE__ */ new Set();
	for (const schema of scoped) seen.add(String(schema?.name ?? ""));
	const out = scoped.slice();
	for (const schema of global) {
		const name = String(schema?.name ?? "");
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		out.push(schema);
	}
	return out;
}
function computeAggregate(schemas) {
	const byServer = /* @__PURE__ */ new Map();
	let mcpToolsTotal = 0;
	let mcpTokensTotal = 0;
	for (const schema of schemas) {
		const server = serverOfMcp$1(String(schema.name ?? ""));
		if (!server) continue;
		const entry = byServer.get(server) ?? {
			tools: 0,
			tokens: 0
		};
		entry.tools += 1;
		const est = tokenEstimate(schema.parameters);
		entry.tokens += est;
		byServer.set(server, entry);
		mcpToolsTotal += 1;
		mcpTokensTotal += est;
	}
	return {
		byServer,
		mcpToolsTotal,
		mcpTokensTotal
	};
}
/**
* 按 scope 复用的 MCP 聚合缓存（C 项优化）：tools.schemas 深克隆 300+ 工具是
* collectMcp 最重的一步；聚合结果在 tools/change 事件间隙直接复用，
* TTL 只是事件丢失时的兜底。key = scopeKey（null 表示全局视图）。
*/
function getMcpAggregate(ctx, caches, scopeKey, errors) {
	const key = scopeKey ?? null;
	pruneExpired(caches.mcpAggregates, Date.now());
	const hit = caches.mcpAggregates.get(key);
	if (hit && Date.now() - hit.at < 6e4) return hit.value;
	let schemas = [];
	try {
		schemas = getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS);
		if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, caches, void 0, DOMAIN_TTL_MS));
	} catch (error) {
		errors.push(`tools.schemas: ${messageOf$1(error)}`);
	}
	const value = computeAggregate(schemas);
	caches.mcpAggregates.set(key, {
		at: Date.now(),
		value
	});
	return value;
}
/** 停用态 token 估算缓存（P2-6）：fetchedAt 不变则复用，避免每次面板请求
* 对停用 server（如 cheatengine 173 工具）全量 JSON.stringify。 */
function catalogTokens(runtime, serverName, info) {
	if (!info) return 0;
	const hit = runtime.tokenCache.get(serverName);
	if (hit && hit.fetchedAt === info.fetchedAt) return hit.tokens;
	const tokens = info.tools.reduce((sum, t) => sum + tokenEstimate(t.parameters), 0);
	runtime.tokenCache.set(serverName, {
		fetchedAt: info.fetchedAt,
		tokens
	});
	return tokens;
}
/**
* 行级**工具级启用数**：按禁用集合折算该 server 的工具数与 token 估算。
*
* 口径（2026-09-16 移植裁量 F1）：这是「工具级启用数」而**不是**「实际进入上下文的
* 工具数」—— 与 installToolDisableFilter 同源（同一张表、同一套作用域分派），但
* 不减 server 级可见性（AI 临时启用 / 面板隐藏 server）与 project-mcp 的工作区过滤。
* 面板文案不得越界声明。
*/
function effectiveOf(toolList, toolDisabled, fallbackTools, fallbackTokens) {
	if (!toolList) return {
		toolsEnabled: fallbackTools,
		tokensEnabled: fallbackTokens
	};
	let toolsEnabled = 0;
	let tokensEnabled = 0;
	for (const tool of toolList) {
		if (toolDisabled.has(tool.name)) continue;
		toolsEnabled += 1;
		tokensEnabled += tool.tokens;
	}
	return {
		toolsEnabled,
		tokensEnabled
	};
}
/**
* 全部工具（含 read/edit/bash/skill 等非 MCP 工具）计数 —— 工具预算红线用。
*
* 口径（2026-09-16 移植裁量 F2，覆盖 PR 原文）：**优先取请求面真值** ——
* 会话上一次已落盘请求的装配后工具表（`session.requestHeader()?.tools`，
* EpochHeader.tools = Assembled tool schemas）。它已是全部装配过滤器（工具级禁用 /
* server 级可见性 / project-mcp 工作区）跑完的结果，对 350 这类 provider 上限是
* 正确的比较对象；代价是有一轮延迟（读到的是上一次请求）。
*
* 取不到（冷启动、无会话上下文、诊断装配）时回退**注册表**口径：PR 原式的
* `schemas.length - (mcpToolsTotal - mcpToolsEnabledTotal)`。注册表视图不等于请求面
* （不扣 server 级隐藏与项目工作区过滤），所以是近似值 —— 调用方必须把
* `toolsAllSource` 透出到面板与 API，不得混同。
*/
function toolsAllCounts(agent, schemas, mcpToolsTotal, mcpToolsEnabledTotal) {
	try {
		const tools = agent?.session?.requestHeader()?.tools;
		if (Array.isArray(tools)) return {
			toolsAllTotal: tools.length,
			toolsAllEnabled: tools.length,
			toolsAllSource: "request"
		};
	} catch {}
	return {
		toolsAllTotal: schemas.length,
		toolsAllEnabled: schemas.length - (mcpToolsTotal - mcpToolsEnabledTotal),
		toolsAllSource: "registry"
	};
}
async function collectMcp(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const scopeKey = await resolveCollectScopeKey(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const decision = deps.catalogRuntime.decisionFor(agent);
	const hideAllActive = deps.catalogRuntime.middleLayerHides === "all" && decision.on;
	const { byServer, mcpToolsTotal, mcpTokensTotal } = getMcpAggregate(ctx, deps.caches, scopeKey, errors);
	let schemas = getSchemasView(ctx, deps.caches, scopeKey, DOMAIN_TTL_MS);
	if (scopeKey) schemas = mergeSchemas(schemas, getSchemasView(ctx, deps.caches, void 0, DOMAIN_TTL_MS));
	const toolsByServer = /* @__PURE__ */ new Map();
	let mcpToolsEnabledTotal = 0;
	let mcpTokensEnabledTotal = 0;
	for (const schema of schemas) {
		const name = String(schema?.name ?? "");
		if (!name.startsWith("mcp__")) continue;
		const server = serverOfMcp$1(name);
		if (server === null) continue;
		const tokens = tokenEstimate(schema?.parameters);
		if (!isToolDisabled(name, cwd)) {
			mcpToolsEnabledTotal += 1;
			mcpTokensEnabledTotal += tokens;
		}
		let list = toolsByServer.get(server);
		if (!list) {
			list = [];
			toolsByServer.set(server, list);
		}
		list.push({
			name,
			description: String(schema?.description ?? ""),
			tokens
		});
	}
	for (const list of toolsByServer.values()) list.sort((a, b) => a.name.localeCompare(b.name));
	const { toolsAllTotal, toolsAllEnabled, toolsAllSource } = toolsAllCounts(agent, schemas, mcpToolsTotal, mcpToolsEnabledTotal);
	const mcp = [];
	const state = await readState().catch(() => void 0);
	try {
		for (const entry of ctx.loader.entries()) {
			if (!isMcpEntry(entry)) continue;
			const serverName = serverNameOf(entry);
			const projectWorkspace = projectServerOwner(serverName);
			const agg = byServer.get(serverName);
			const liveTools = agg?.tools ?? 0;
			const running = entry.fiber !== void 0;
			const disabled = entry.disabled;
			const rowFile = (entry.parent?.tree)?.filename;
			const rowDesired = typeof rowFile === "string" && rowFile.length > 0 ? state?.mcp?.[rowFile]?.[entry.options.id]?.desired : void 0;
			const catalogInfo = deps.catalogRuntime.catalog[serverName];
			const disp = rowDisplay(disabled, running, liveTools, catalogInfo?.tools.length ?? 0);
			const displayTools = disp.displayTools;
			const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogTokens(deps.catalogRuntime, serverName, catalogInfo);
			const status = disp.unregistered ? "failed" : computeStatus(disabled, running, liveTools);
			const transportRaw = mcpEntryConfig(entry)?.transport;
			const toolDisabled = disabledToolsOf(serverName, projectWorkspace);
			let toolList = toolsByServer.get(serverName);
			if (!toolList && catalogInfo) toolList = catalogInfo.tools.map((tool) => ({
				name: String(tool.name ?? ""),
				description: String(tool.description ?? ""),
				tokens: tokenEstimate(tool.parameters)
			}));
			const effective = effectiveOf(toolList, toolDisabled, displayTools, displayTokens);
			const aiOwned = deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(serverName) ?? false);
			const scope = modelVisibleScope(disabled, aiOwned, hideAllActive);
			mcp.push({
				entryId: entry.id,
				rowId: entry.options.id,
				serverName,
				transport: transportRaw ? String(transportRaw) : null,
				disabled,
				running,
				tools: displayTools,
				tokens: displayTokens,
				toolsEnabled: effective.toolsEnabled,
				tokensEnabled: effective.tokensEnabled,
				toolList: toolList?.map((tool) => ({
					name: tool.name,
					description: tool.description,
					disabled: toolDisabled.has(tool.name)
				})) ?? null,
				status,
				unregistered: disp.unregistered,
				modelVisible: scope === "direct",
				modelVisibleScope: scope,
				aiOwned,
				desired: rowDesired,
				pending: rowDesired !== void 0 ? rowDesired !== disabled : false,
				workspace: projectWorkspace,
				source: gatewayServerOfEntryId(entry.id) !== null ? "gateway" : "live"
			});
		}
		mcp.sort((a, b) => a.serverName.localeCompare(b.serverName));
	} catch (error) {
		errors.push(`loader.entries: ${messageOf$1(error)}`);
	}
	try {
		const presetId = agent ? ctx.agentPresets.composedPreset(agent.ctx) ?? null : null;
		if (presetId) try {
			const { rows: presetRows, presetKey } = await listPresetMcpRows(ctx, presetId, agent?.ctx);
			const liveServers = new Set(mcp.map((row) => row.serverName));
			for (const pr of presetRows) {
				if (liveServers.has(pr.serverName)) continue;
				const projectWorkspace = projectServerOwner(pr.serverName);
				const agg = byServer.get(pr.serverName);
				const liveTools = agg?.tools ?? 0;
				const rowDesired = state?.mcp?.[presetKey]?.[pr.rowId]?.desired;
				const pendingHit = pendingMcp.get(pr.entryId);
				const pendingFlag = pendingHit ? pendingHit.disabled !== pr.disabled : rowDesired !== void 0 ? rowDesired !== pr.disabled : false;
				const catalogInfo = deps.catalogRuntime.catalog[pr.serverName];
				const disp = rowDisplay(pr.disabled, pr.running, liveTools, catalogInfo?.tools.length ?? 0);
				const displayTools = disp.displayTools;
				const displayTokens = liveTools > 0 ? agg?.tokens ?? 0 : catalogTokens(deps.catalogRuntime, pr.serverName, catalogInfo);
				const status = disp.unregistered ? "failed" : computeStatus(pr.disabled, pr.running, liveTools);
				const toolDisabled = disabledToolsOf(pr.serverName, projectWorkspace);
				let toolList = toolsByServer.get(pr.serverName);
				if (!toolList && catalogInfo) toolList = catalogInfo.tools.map((tool) => ({
					name: String(tool.name ?? ""),
					description: String(tool.description ?? ""),
					tokens: tokenEstimate(tool.parameters)
				}));
				const effective = effectiveOf(toolList, toolDisabled, displayTools, displayTokens);
				const aiOwned = deps.catalogRuntime.autoManage && (deps.controller?.isAiEnabled(pr.serverName) ?? false);
				const scope = modelVisibleScope(pr.disabled, aiOwned, hideAllActive);
				mcp.push({
					entryId: pr.entryId,
					rowId: pr.rowId,
					serverName: pr.serverName,
					transport: pr.transport,
					disabled: pr.disabled,
					running: pr.running,
					tools: displayTools,
					tokens: displayTokens,
					toolsEnabled: effective.toolsEnabled,
					tokensEnabled: effective.tokensEnabled,
					toolList: toolList?.map((tool) => ({
						name: tool.name,
						description: tool.description,
						disabled: toolDisabled.has(tool.name)
					})) ?? null,
					status,
					unregistered: disp.unregistered,
					modelVisible: scope === "direct",
					modelVisibleScope: scope,
					aiOwned,
					desired: rowDesired,
					pending: pendingFlag,
					workspace: projectWorkspace,
					source: "preset"
				});
			}
			mcp.sort((a, b) => a.serverName.localeCompare(b.serverName));
		} catch (error) {
			errors.push(`preset-mcp: ${messageOf$1(error)}`);
		}
	} catch (error) {
		errors.push(`preset-mcp: ${messageOf$1(error)}`);
	}
	return {
		...baseView(ctx, agent, cwd),
		mcp,
		mcpTotal: mcp.length,
		mcpDisabled: mcp.filter((row) => row.disabled).length,
		mcpToolsTotal,
		mcpTokensTotal,
		mcpToolsEnabledTotal,
		mcpTokensEnabledTotal,
		toolsAllTotal,
		toolsAllEnabled,
		toolsAllSource,
		toolBudget: stateToolBudget(state ?? {}) ?? null,
		autoManage: deps.catalogRuntime.autoManage,
		autoManageByRoute: { ...deps.catalogRuntime.autoManageByRoute },
		autoManageByRoutePersisted: stateAutoManageByRoute(state ?? {}),
		autoManageMounted: deps.catalogRuntime.autoManageMounted,
		middleLayerHides: deps.catalogRuntime.middleLayerHides,
		autoManageActive: activeRouteView(decision),
		activeWorkspace: getActiveWorkspace(),
		errors
	};
}
async function collectSkills(deps, sessionId) {
	const { ctx } = deps;
	const errors = [];
	const agent = resolveAgent(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd ?? void 0;
	const skills = [];
	let skillsModelVisible = 0;
	try {
		const snapshot = await ctx.skills.snapshot({
			scope: agent,
			cwd
		});
		for (const summary of snapshot.skills) {
			const confirmed = confirmedSkills.get(summary.name);
			const modelInvocable = confirmed && Date.now() - confirmed.at < CONFIRMED_SKILL_TTL_MS ? confirmed.modelInvocable : summary.invocation?.modelInvocable !== false;
			if (modelInvocable) skillsModelVisible += 1;
			skills.push({
				name: summary.name,
				description: summary.description ?? "",
				source: summary.source ?? "unknown",
				modelInvocable,
				userInvocable: summary.invocation?.userInvocable !== false
			});
		}
	} catch (error) {
		errors.push(`skills.snapshot: ${messageOf$1(error)}`);
	}
	return {
		...baseView(ctx, agent, cwd),
		skills,
		skillsTotal: skills.length,
		skillsModelVisible,
		errors
	};
}
//#endregion
//#region src/routes.ts
/**
* HTTP 路由层：控制动作（toggleMcp/toggleSkill）与全部 /api/mcp-skill-panel/* 端点。
*
* 从 index.ts 拆出（可维护性批次 P1-1），并收敛端点样板（P2-6）：
* defineHandler 统一 method 校验 / 异步错误响应 / {ok:true,...} 包装。
*/
/**
* B4：网关行 serverName → 当前会话 preset 行定位（entryId 映射不到 preset entryId，
* 按 serverName 精确匹配；presetId 取当前会话 composedPreset，无会话返回 undefined）。
*
* 0.7.0：`presetKey` 取代 `presetPath` 作为 state.json 的行来源键（0.2.0 起 preset
* 不再有文件路径）；同时把 agent ctx 透传给行源，让 live 树能经
* `standingMountFor(agentCtx)` 兜底取挂载。
*/
async function findPresetRowByServerNameLike(ctx, serverName) {
	try {
		const agent = resolveAgent(ctx, void 0);
		const presetId = agent ? ctx.agentPresets.composedPreset(agent.ctx) ?? null : null;
		if (!presetId) return void 0;
		const row = await findPresetRowByServerName(ctx, presetId, serverName, agent?.ctx);
		if (!row) return void 0;
		const listed = await listPresetMcpRows(ctx, presetId, agent?.ctx);
		return {
			presetId,
			row,
			presetPath: row.file,
			presetKey: listed.presetKey
		};
	} catch {
		return;
	}
}
const API_PREFIX = "/api/mcp-skill-panel";
/** 旧前缀（0.3.1 及以前为 /api/runtime-inventory），保留兼容 */
const LEGACY_API_PREFIX = "/api/runtime-inventory";
/** skill toggle 后等待 watcher 失效 catalog 的最长时间 */
const SKILL_TOGGLE_CONFIRM_MS = 5e3;
/** 进程级随机令牌：写操作（启停/config）要求客户端在 x-panel-token 头携带；
* 阻断跨源 / DNS-rebinding 对本地控制端点的盲写。GET 只读保持开放。 */
const PANEL_TOKEN = randomBytes(32).toString("hex");
/** readBody 体积上限：防无界 body 累积（本地 DoS 向量）。 */
const MAX_BODY_BYTES = 65536;
/** `/models` 的 provider/模型目录 TTL（ms）。见 modelsCatalog 的取舍注释。 */
const MODELS_TTL_MS = 6e4;
/** `/models` 单次抓取的时间上界（ms）。见 modelsCatalog 的超时注释：本端点是**开放读端点**，
* 不能被一个卡住的 adapter 永久黏住（无超时 + 单飞 = 该 adapter 恢复前对所有调用者不可用）。 */
const MODELS_FETCH_TIMEOUT_MS = 8e3;
function json(res, code, body) {
	res.statusCode = code;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}
function ok(res, data) {
	json(res, 200, {
		ok: true,
		...data
	});
}
/**
* 读请求体（上限 MAX_BODY_BYTES 字节）。
*
* P1-2 修复（2026-09-15）：
*  ① 拼串改走 StringDecoder：原先 `body += String(chunk)`，多字节字符正好跨 chunk 边界时
*     两个半个字符各自被 String(chunk) 解成 U+FFFD（乱码）——任何含中文的 body
*     （例如中文 cwd / 中文 args / skill 描述）在多包到达下都会损坏。
*     长度同理改按字节计（Buffer.byteLength），不再按「解码后字符数」估。
*  ② 超限分支先解绑监听器再 destroy：原先只 destroy，request 上仍挂着 data/end/error
*     三个闭包（闭包持有已 reject 的 promise 与 body 累积串）→ 每个被拒请求泄漏一份。
*     正常结束同样显式解绑（同一 cleanup 路径）。
*/
function readBody(req) {
	return new Promise((resolve, reject) => {
		const decoder = new StringDecoder("utf8");
		let bytes = 0;
		let body = "";
		const onData = (chunk) => {
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > MAX_BODY_BYTES) {
				cleanup();
				req.destroy();
				reject(/* @__PURE__ */ new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
				return;
			}
			body += typeof chunk === "string" ? chunk : decoder.write(chunk);
		};
		const onEnd = () => {
			body += decoder.end();
			cleanup();
			resolve(body);
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
		};
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
	});
}
function queryParam(url, key) {
	const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
	return m ? decodeURIComponent(m[1]) : void 0;
}
/** 写操作 token 校验（x-panel-token === 本进程随机令牌）。 */
function tokenOk(req) {
	return req.headers["x-panel-token"] === PANEL_TOKEN;
}
/** 端点样板：method 校验 + 异步执行 + {ok:true} 包装 + 统一错误码（POST 参数错 400 / GET 服务错 500）。
* guarded=true 时要求 x-panel-token 匹配（写操作鉴权）。 */
function handle(method, run, guarded = false) {
	return (req, res) => {
		if (req.method !== method) {
			json(res, 405, {
				ok: false,
				error: "method-not-allowed"
			});
			return;
		}
		if (guarded && !tokenOk(req)) {
			json(res, 401, {
				ok: false,
				error: "unauthorized"
			});
			return;
		}
		Promise.resolve(run(req)).then((data) => ok(res, data)).catch((error) => json(res, method === "POST" ? 400 : 500, {
			ok: false,
			error: messageOf$1(error)
		}));
	};
}
/**
* 同 path 多 method 路由：webServer 的 exact 路由按 path 唯一（同 path 重复注册
* 会中断后续注册），因此 GET+POST 共存的端点必须合并为单个 handler 内部分发。
* guardPosts=true 时仅 POST 需要 x-panel-token（GET 只读端点始终开放，
* 与 0.4.7+「读端点开放、写操作鉴权」的设计一致；2026-08-27 修复：此前
* guardPosts 对 GET 也生效，/config 读取被锁 → 面板生效时机恒显示默认值）。
*/
function handleAny(entries, guardPosts = false) {
	if (!guardPosts && entries.some((e) => e.method === "POST")) throw new Error("handleAny: POST entries require guardPosts=true");
	return (req, res) => {
		const entry = entries.find((e) => e.method === req.method);
		if (!entry) {
			json(res, 405, {
				ok: false,
				error: "method-not-allowed"
			});
			return;
		}
		handle(entry.method, entry.run, guardPosts && entry.method === "POST")(req, res);
	};
}
async function toggleMcp(deps, entryId, disabled, applyMode) {
	const { ctx } = deps;
	const mode = applyMode ?? stateApplyMode(await readState());
	let entry;
	try {
		entry = ctx.loader.resolve(entryId);
	} catch {
		entry = void 0;
	}
	if (!entry) entry = findStandingEntryById(entryId);
	if (!entry || gatewayServerOfEntryId(entryId) !== null) {
		const gwServer = gatewayServerOfEntryId(entryId);
		const found = (gwServer ? await findPresetRowByServerNameLike(ctx, gwServer).catch(() => void 0) : void 0) ?? await findPresetRowByEntryId(ctx, entryId).catch(() => void 0);
		if (found) {
			const state = await readState();
			state.mcp ??= {};
			const sourceKey = found.presetKey;
			state.mcp[sourceKey] ??= {};
			let fileState = found.row.disabled;
			if (found.presetPath.length > 0) try {
				const { rowDisabledState } = await import("./preset-CAPpfGf6.mjs");
				fileState = rowDisabledState(await readFile(found.presetPath, "utf8"), found.row.rowId);
			} catch {
				fileState = found.row.disabled;
			}
			state.mcp[sourceKey][found.row.rowId] = {
				desired: disabled,
				lastApplied: fileState
			};
			await writeState(state);
			pendingMcp.set(entryId, {
				entryId,
				file: found.presetPath.length > 0 ? found.presetPath : null,
				rowId: found.row.rowId,
				disabled,
				sourceKey
			});
			if (!disabled && deps.controller) deps.controller.markUserEnabled(found.row.serverName);
			return {
				entryId,
				rowId: found.row.rowId,
				serverName: found.row.serverName,
				disabled,
				desired: disabled,
				running: found.row.running,
				persisted: true,
				file: found.presetPath,
				sourceKey,
				applied: false,
				pending: true,
				source: "gateway"
			};
		}
	}
	if (!entry) throw new Error(`entry "${entryId}" is not an MCP row`);
	if (!isMcpEntry(entry)) throw new Error(`entry "${entryId}" is not an MCP row`);
	const rowId = entry.options.id;
	const serverName = serverNameOf(entry);
	const projectWorkspace = projectServerOwner(serverName);
	if (projectWorkspace !== void 0) {
		if (!disabled && deps.controller) deps.controller.markUserEnabled(serverName);
		const state = await readState();
		state.projectMcp ??= {};
		state.projectMcp[projectWorkspace] ??= {};
		state.projectMcp[projectWorkspace][serverName] = disabled;
		await writeState(state);
		await entry.update({ disabled });
		return {
			entryId,
			rowId,
			serverName,
			disabled,
			running: entry.fiber !== void 0,
			persisted: true,
			workspace: projectWorkspace,
			applied: true,
			pending: false
		};
	}
	const presetFile = (entry.parent?.tree)?.filename;
	const presetId = presetFile ? "" : presetIdOfEntry(entry);
	const sourceKey = typeof presetFile === "string" && presetFile.length > 0 ? presetFile : presetId.length > 0 ? presetKeyOf(presetId) : "";
	/** live 行的事实停用态（`entry.disabled` 已求值；文件不可得时的 lastApplied 真值）。 */
	const liveDisabled = entry.disabled === true;
	const deferred = mode === "next-session";
	if (deferred) {
		pendingMcp.set(entryId, {
			entryId,
			file: typeof presetFile === "string" && presetFile.length > 0 ? presetFile : null,
			rowId,
			disabled,
			sourceKey: sourceKey.length > 0 ? sourceKey : null
		});
		if (sourceKey.length > 0) try {
			const st = await readState();
			st.mcp ??= {};
			st.mcp[sourceKey] ??= {};
			let fileState = liveDisabled;
			if (typeof presetFile === "string" && presetFile.length > 0) try {
				fileState = rowDisabledState(await readFile(presetFile, "utf8"), rowId);
			} catch {
				fileState = liveDisabled;
			}
			st.mcp[sourceKey][rowId] = {
				desired: disabled,
				lastApplied: fileState
			};
			await writeState(st);
		} catch (error) {
			ctx.logger.warn?.(`mcp-skill-panel: persist pending intent for "${entryId}" failed: ${messageOf$1(error)}`);
		}
	} else {
		pendingMcp.delete(entryId);
		if (disabled) {
			const presetSnapshot = deps.catalogRuntime.catalog[serverNameOf(entry)];
			if (!presetSnapshot || presetSnapshot.tools.length === 0) try {
				await deps.controller?.fetchInventory(serverNameOf(entry), 1500);
			} catch (error) {
				ctx.logger.warn?.(`mcp-skill-panel: pre-close inventory snapshot for "${serverNameOf(entry)}" failed: ${messageOf$1(error)}`);
			}
		}
		await entry.update({ disabled });
		if (!disabled && deps.controller) deps.controller.markUserEnabled(serverNameOf(entry));
	}
	let persisted = false;
	if (sourceKey.length > 0) {
		let liveFileState = liveDisabled;
		if (typeof presetFile === "string" && presetFile.length > 0) try {
			liveFileState = rowDisabledState(await readFile(presetFile, "utf8"), rowId);
		} catch {
			liveFileState = liveDisabled;
		}
		const state = await readState();
		state.mcp ??= {};
		state.mcp[sourceKey] ??= {};
		state.mcp[sourceKey][rowId] = {
			desired: disabled,
			lastApplied: liveFileState
		};
		await writeState(state);
		persisted = true;
	}
	return {
		entryId,
		rowId,
		serverName,
		disabled,
		running: entry.fiber !== void 0,
		persisted,
		file: typeof presetFile === "string" && presetFile.length > 0 ? presetFile : null,
		sourceKey: sourceKey.length > 0 ? sourceKey : null,
		applied: !deferred,
		pending: deferred
	};
}
async function toggleSkill(deps, skillName, disabled, sessionId) {
	const { ctx } = deps;
	const agent = resolveAgent(ctx, sessionId);
	const cwd = agent?.session?.header?.cwd;
	const def = await ctx.skills.get(skillName, {
		scope: agent,
		cwd
	});
	if (!def?.path) throw new Error(`skill "${skillName}" has no file path (${def?.source ?? "unknown source"})`);
	const text = await readFile(def.path, "utf8");
	const next = setSkillFlag(text, disabled);
	if (next !== text) await writeFile(def.path, next, "utf8");
	const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS;
	let confirmed = false;
	let wait = 80;
	while (Date.now() < deadline) {
		const after = await ctx.skills.get(skillName, {
			scope: agent,
			cwd
		});
		if (after && after.invocation?.modelInvocable === !disabled) {
			confirmed = true;
			break;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await ctx.timeout(Math.min(wait, remaining));
		wait = Math.min(wait * 2, 1e3);
	}
	pruneExpired(confirmedSkills, Date.now());
	if (confirmed) confirmedSkills.set(skillName, {
		modelInvocable: !disabled,
		at: Date.now()
	});
	return {
		name: skillName,
		disabled,
		modelInvocable: !disabled,
		path: def.path,
		confirmed
	};
}
/**
* 路由写文件队列：串行化 appendGlobalPatch / writeProjectMcp 的「读-改-写」。
* 并发 POST（或多会话同时添加）若各自以旧内容为基底写盘，
* 先写者的内容会被后写者整体覆盖丢失 → 全部走同一 Promise 链。
*/
let fileWriteChain = Promise.resolve();
/** 0.6.0：配置合法性校验（UI 预校验与后端落盘共用同一套规则）。 */
function validateRowConfig(config) {
	const transport = config.transport === void 0 ? void 0 : String(config.transport);
	if (transport !== void 0 && transport !== "stdio" && transport !== "streamable-http") throw new Error(`transport 只能是 stdio 或 streamable-http（收到 ${transport}）`);
	const hasCommand = typeof config.command === "string" && config.command.trim().length > 0;
	const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
	if (transport === "streamable-http") {
		if (!hasUrl) throw new Error("streamable-http 需要 url");
	} else if (transport === "stdio" || transport === void 0 && hasCommand) {
		if (!hasCommand) throw new Error("stdio 需要 command");
	} else if (!hasCommand && !hasUrl) throw new Error("需要 command（stdio）或 url（streamable-http）之一");
	if (config.url !== void 0 && !/^https?:\/\//i.test(String(config.url))) throw new Error("url 需以 http:// 或 https:// 开头");
	if (config.args !== void 0 && !Array.isArray(config.args)) throw new Error("args 必须是数组");
	if (config.cwd !== void 0 && (typeof config.cwd !== "string" || config.cwd.length === 0)) throw new Error("cwd 必须是非空字符串");
	if (config.toolCallTimeoutMs !== void 0) {
		const n = Number(config.toolCallTimeoutMs);
		if (!Number.isFinite(n) || n <= 0) throw new Error("toolCallTimeoutMs 必须是正数");
	}
	for (const mapKey of ["env", "headers"]) {
		const value = config[mapKey];
		if (value === void 0) continue;
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${mapKey} 必须是键值对象`);
	}
}
/**
* 0.6.0：把配置意图写进 state.json（运行期唯一安全的写面）。
* 结构：state.mcp[预设文件][行 id].config —— 启动早期由 syncPresetFiles 物化。
*/
async function writeRowConfigIntent(server, described, config) {
	const file = typeof described.file === "string" ? described.file : null;
	const rowId = typeof described.rowId === "string" ? described.rowId : null;
	if (!file || !rowId) throw new Error(`无法定位该行的预设文件/行 id（server=${server}）`);
	const state = await readState();
	state.mcp ??= {};
	state.mcp[file] ??= {};
	const prev = state.mcp[file][rowId];
	let fileState = prev?.lastApplied ?? null;
	try {
		fileState = rowDisabledState(await readFile(file, "utf8"), rowId);
	} catch {}
	state.mcp[file][rowId] = {
		desired: prev?.desired ?? false,
		lastApplied: fileState,
		config
	};
	await writeState(state);
	return {
		file,
		rowId,
		config
	};
}
let rowConfigApplyHook = null;
/** 由 index.ts 在 apply 里注入（热改 live entry 的 config）。 */
function setRowConfigApplyHook(hook) {
	rowConfigApplyHook = hook;
}
async function applyRowConfigToLive(server, config) {
	if (!rowConfigApplyHook) return {
		ok: false,
		error: "热应用不可用（钩子未注入）"
	};
	return rowConfigApplyHook(server, config);
}
/** 0.6.0：描述某个 standing 行的**全量挂载配置**与运行态（只读；/debug/rowConfig 与配置编辑共用）。 */
async function describeRow(server) {
	const entry = findStandingEntryByServer(server);
	const out = {
		server,
		standing: standingDiag(),
		entryFound: entry !== void 0
	};
	if (!entry) return out;
	const cfg = entry.options.config ?? {};
	const keep = [
		"serverName",
		"transport",
		"command",
		"args",
		"env",
		"cwd",
		"url",
		"headers",
		"toolCallTimeoutMs",
		"failOnStartupError"
	];
	const safe = {};
	for (const k of keep) if (cfg[k] !== void 0) safe[k] = cfg[k];
	out.entryId = String(entry.id);
	out.rowId = entry.options.id ?? null;
	out.disabled = entry.disabled === true;
	out.running = entry.fiber !== void 0;
	out.config = safe;
	out.configKeys = Object.keys(cfg);
	out.file = (entry.parent?.tree)?.filename ?? null;
	if (typeof out.file === "string" && out.file.length > 0) try {
		const text = await readFile(out.file, "utf8");
		out.fileHasCwd = /^\s*cwd:\s*/m.test(text) ? "file-has-cwd-line" : "no-cwd-in-file";
	} catch (error) {
		out.fileError = messageOf$1(error);
	}
	return out;
}
/**
* GET 回传脱敏占位（P1-1，2026-09-15）。
*
* 问题：/mcp/rowConfig 与 /debug/rowConfig 的 GET 经 describeRow 回传 **求值后** 的
* env/headers（里面通常就是 token / API key），而这两个 GET 端点按设计**不要求**
* x-panel-token（「读端点开放、写操作鉴权」）——于是任何本地页面/脚本一发起 GET
* 就能把 secrets 原样取走，写侧却要令牌，防线是反的。
*
* 边界：脱敏**只发生在 GET/POST 响应体的组装处**，describeRow 内部仍返回真值
* （POST 的「live 现值 → set/unset」合并必须基于真值，否则改 cwd 会把 env 一并
* 写成占位符）；存储、live 配置、意图落盘一律不动，POST 写侧照收真值。
*/
const MASKED_VALUE = "***MASKED***";
const MASK_KEYS = ["env", "headers"];
/** 浅拷 + 置换敏感段：键名保留（面板要能看出「有哪些 key」），值一律换成固定占位。 */
function maskSecrets(config) {
	const out = { ...config };
	for (const key of MASK_KEYS) {
		const value = out[key];
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const masked = {};
		for (const name of Object.keys(value)) masked[name] = MASKED_VALUE;
		out[key] = masked;
	}
	return out;
}
/**
* F3b（2026-09-15）哨兵：**占位符即「保留原值」**。
*
* 问题：F3 让 GET 回传把 env/headers 的值换成 MASKED_VALUE，而面板 client
* （views.tsx RowConfigModal）是「读回显 → 进文本框 → 整体 POST 回写」结构：
* 用户打开弹窗只改 cwd 就点保存，也会把占位符当真值写回 → 真 token 被抹掉。
*
* 修法（纯后端，client 不动）：写侧把占位符解释成"这一条保持 live 现值"——
*   · 占位值 + live 有对应键 → 恢复 live 真值；
*   · 占位值 + live 无对应键 → **丢弃该条**（绝不把占位符本身存进去）；
*   · 非占位值 → 照收（真轮换 token 必须生效）；被 unset 删掉的键不会出现在 next 里。
* next[key] 非对象（字符串/数组/null）原样放过，交给 validateRowConfig 判错。
*/
function unmaskEcho(next, live) {
	const out = { ...next };
	for (const key of MASK_KEYS) {
		const incoming = out[key];
		if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) continue;
		const base = live[key];
		const liveMap = base !== null && typeof base === "object" && !Array.isArray(base) ? base : {};
		const merged = {};
		for (const name of Object.keys(incoming)) {
			const value = incoming[name];
			if (value !== MASKED_VALUE) {
				merged[name] = value;
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(liveMap, name)) merged[name] = liveMap[name];
		}
		out[key] = merged;
	}
	return out;
}
/** describeRow 回传体的脱敏包装（GET 回传与 POST 的 before/after/willWrite 回显共用）。 */
function maskDescribed(described) {
	const config = described.config;
	if (config === null || typeof config !== "object" || Array.isArray(config)) return described;
	return {
		...described,
		config: maskSecrets(config)
	};
}
/**
* 定位 profile 的用户 patch 层（<profile>/cordis.patch.yml）。
* 根树 backing 文件是 <profile>/cordis.yml（每次启动重置为 []），
* patch 与其同目录；从任一 root 树 entry 的 tree.filename 反推。
*/
function profilePatchPath(ctx) {
	for (const entry of ctx.loader.entries()) {
		const file = (entry.parent?.tree)?.filename;
		if (typeof file === "string" && basename(file) === "cordis.yml") return join(dirname(file), "cordis.patch.yml");
	}
	throw new Error("无法定位 profile 补丁文件 cordis.patch.yml（未找到 cordis.yml 根树；请确认 profile 已正常挂载后重试）");
}
/** 已存在检查：loader 存活行、standing 行或 patch 文本里已有同 id。 */
function existingRowIds(ctx, patchText) {
	const ids = /* @__PURE__ */ new Set();
	for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
		if (!isMcpEntry(entry)) continue;
		ids.add(String(entry.options.id));
	}
	for (const line of patchText.split(/\r?\n/)) {
		const m = /^\s*-?\s*id:\s*([^\s]+)\s*$/.exec(line);
		if (m) ids.add(m[1]);
	}
	return ids;
}
/** 追加 `- insert:` patch 块到 profile cordis.patch.yml（串行排队 + 原子写 + 跟随原换行风格）。 */
function appendGlobalPatch(ctx, yamlBlock) {
	const run = fileWriteChain.then(async () => {
		const file = profilePatchPath(ctx);
		const existing = await readFile(file, "utf8").catch(() => "");
		const sep = existing.includes("\r\n") ? "\r\n" : "\n";
		const next = (existing.length > 0 && !existing.endsWith("\n") ? existing + sep : existing) + yamlBlock.replace(/\r?\n/g, sep);
		await writeFile(`${file}.tmp`, next, "utf8");
		await rename(`${file}.tmp`, file);
		return { file };
	});
	fileWriteChain = run.catch(() => void 0);
	return run;
}
/** 把 servers 合并写入 <workspace>/.dsh/mcps/mcp.json（新建 server 覆盖同名旧值；读-改-写串行化）。 */
function writeProjectMcp(workspace, servers) {
	const run = fileWriteChain.then(async () => {
		const mcpsDir = join(workspace, ".dsh", "mcps");
		const file = join(mcpsDir, "mcp.json");
		await mkdir(mcpsDir, { recursive: true });
		let existing = {};
		try {
			const parsed = JSON.parse(await readFile(file, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
		} catch {}
		let map = {};
		if (existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)) map = existing.mcpServers;
		for (const [name, server] of Object.entries(servers)) map[name] = server;
		const payload = {
			...existing,
			mcpServers: map
		};
		await writeFile(`${file}.tmp`, JSON.stringify(payload, null, 2), "utf8");
		await rename(`${file}.tmp`, file);
		return { file };
	});
	fileWriteChain = run.catch(() => void 0);
	return run;
}
/** 全局添加：写入 profile patch + 立即挂载到 loader（粘贴即用，重启由 patch 承接）。 */
async function addGlobalMcp(ctx, servers) {
	const file = profilePatchPath(ctx);
	const existingIds = existingRowIds(ctx, await readFile(file, "utf8").catch(() => ""));
	const toAdd = /* @__PURE__ */ new Map();
	const skipped = [];
	for (const row of serversToRows(servers)) {
		if (existingIds.has(row.id)) {
			skipped.push(String(row.config.serverName));
			continue;
		}
		toAdd.set(row.id, row);
	}
	const rows = [...toAdd.values()];
	if (rows.length === 0) return {
		file,
		added: 0,
		skipped
	};
	const mounted = [];
	for (const row of rows) try {
		await ctx.loader.create(row);
		mounted.push(row);
	} catch (error) {
		skipped.push(String(row.config.serverName));
		ctx.logger.warn?.(`mcp-skill-panel: 全局 MCP "${row.config.serverName}" 挂载失败: ${messageOf$1(error)}`);
	}
	if (mounted.length === 0) return {
		file,
		added: 0,
		skipped
	};
	await appendGlobalPatch(ctx, serversToPatchYaml(serversFromRows(mounted)));
	return {
		file,
		added: mounted.length,
		skipped
	};
}
/** 从已挂载行重建 McpServers（落盘 patch 用；避免把未挂载成功的行写进去）。 */
function serversFromRows(rows) {
	const servers = {};
	for (const row of rows) {
		const config = row.config;
		servers[config.serverName] = config;
	}
	return servers;
}
async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
/**
* 解析 skill 的项目根：与 dsh-skill-filesystem 的 findProjectRoot 一致 ——
* 从 cwd 向上找最近含 .git 的目录，找不到退化为 cwd 本身。
* （skill 的项目发现走这个规则，MCP 的工作空间规则是裸 cwd，两者不同。）
*/
async function resolveSkillProjectRoot(cwd) {
	let current = cwd;
	for (;;) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = parse(current).root;
		if (current === parent) return cwd;
		current = dirname(current);
	}
}
/** 添加 skill：name/description/body → <root>/skills/<name>/SKILL.md（存在即拒绝）。 */
async function addSkill(name, description, body, target, workspace) {
	if (!isValidSkillName(name)) throw new Error(`技能名 "${name}" 需为 kebab-case（小写字母/数字/连字符）`);
	if (description.trim().length === 0) throw new Error("描述不能为空");
	if (body.trim().length === 0) throw new Error("指令（正文）不能为空");
	let base;
	if (target === "global") base = join(homedir(), ".dsh", "skills");
	else {
		if (typeof workspace !== "string" || workspace.length === 0) throw new Error("project 目标需要 workspace（当前会话工作空间）");
		base = join(await resolveSkillProjectRoot(workspace), ".dsh", "skills");
	}
	const dir = join(base, name);
	if (await pathExists(dir)) throw new Error(`技能已存在：${dir}`);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	try {
		await writeFile(file, buildSkillMd(name, description, body), {
			encoding: "utf8",
			flag: "wx"
		});
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`技能已存在：${dir}`);
		throw error;
	}
	return { path: file };
}
/** 上一次真实抓取的目录 + 在飞的抓取（单飞）。进程级：目录与面板一样是进程全局读数。 */
const modelsCache = {
	fetchedAt: null,
	providers: null,
	inflight: null
};
/** 清空目录缓存（**仅供自测**：TTL 命中 / 失效 / 超时三条路径在 Node 侧的唯一入口）。 */
function __resetModelsCache() {
	modelsCache.fetchedAt = null;
	modelsCache.providers = null;
	modelsCache.inflight = null;
}
/** 超时哨兵：`Promise.race` 无法把「超时」与「抓取真的返回空目录」区分开，故用唯一对象标记。 */
const MODELS_FETCH_TIMEOUT = Symbol("modelsFetchTimeout");
/** 抓取时间上界的 promise：到点用哨兵 resolve（**不取消**那次真实抓取，见 modelsCatalog）。 */
function fetchDeadline(ms) {
	return new Promise((resolve) => {
		setTimeout(() => resolve(MODELS_FETCH_TIMEOUT), ms).unref?.();
	});
}
/** 发起一次真实抓取并登记为在飞（单飞）。返回登记进 `modelsCache.inflight` 的那个 promise。 */
function startModelsFetch(llm) {
	const fetch = fetchProviderCatalog(llm).then((providers) => {
		modelsCache.providers = providers;
		modelsCache.fetchedAt = Date.now();
		return providers;
	});
	let inflight;
	inflight = fetch.finally(() => {
		if (modelsCache.inflight === inflight) modelsCache.inflight = null;
	});
	modelsCache.inflight = inflight;
	return inflight;
}
/**
* 取 provider/模型目录，带 TTL 缓存与单飞。
*
* 取舍（为什么必须缓存）：`listModels` 是逐个 provider 打到 adapter 的调用，可能
* 触达网络；而 `/models` 与其它读端点一样是**无鉴权 GET**（本仓「读端点开放、
* 写操作鉴权」的设计，见 handleAny 注释）。TTL 缓存把这条开放端点的扇出上界锁死
* 成**每 60s 至多一次**完整抓取 —— 这就是对「无鉴权读端点会放大到 adapter」的
* 缓解手段；单飞再保证并发请求共享同一个在飞 promise，不会因并发而乘上扇出。
*
* `cached` 的语义：本次响应**直接取自**已完成的 TTL 缓存（没有参与任何抓取）。
* 与别人共享在飞抓取的并发请求同样是 `false` —— 它们确实不是从缓存拿到的。
*
* 时间上界（为什么必须有）：单飞把「一个 adapter 卡住」从「一次慢响应」放大成「端点对外
* 不可用」—— `inflight` 一旦被一个**永不 settle** 的 `listModels` 钉住，之后每个 `/models`
* 请求都 await 同一个 pending promise（对外表现为「宿主 llm 服务未提供 provider 目录」，
* 连报错都没有）。故单次抓取套 `Promise.race` 上界 `MODELS_FETCH_TIMEOUT_MS`：
* 超时只改**本次请求**的返回（空目录 + `cached:false`），不写缓存、不动 `fetchedAt`，
* 并清掉 `inflight` 让下一个请求能重新发起抓取；迟到的真实结果照常写缓存。
*
* @param llm - 经 ctx.inject 捕获的 llm 服务引用（缺失时降级为空目录，不抛）。
* @param timeoutMs - 抓取时间上界（ms），**仅供自测注入**（默认 `MODELS_FETCH_TIMEOUT_MS`；
* 生产调用点不传，避免把一个「测试用的口子」变成第二个配置面）。
*/
async function modelsCatalog(llm, timeoutMs = MODELS_FETCH_TIMEOUT_MS) {
	const now = Date.now();
	if (modelsCache.providers !== null && modelsCacheFresh(modelsCache.fetchedAt, now, MODELS_TTL_MS)) return {
		providers: modelsCache.providers,
		cached: true,
		fetchedAt: modelsCache.fetchedAt
	};
	const inflight = modelsCache.inflight ?? startModelsFetch(llm);
	const raced = await Promise.race([inflight, fetchDeadline(timeoutMs)]);
	if (raced === MODELS_FETCH_TIMEOUT) {
		if (modelsCache.inflight === inflight) modelsCache.inflight = null;
		return {
			providers: [],
			cached: false,
			fetchedAt: modelsCache.fetchedAt
		};
	}
	return {
		providers: raced,
		cached: false,
		fetchedAt: modelsCache.fetchedAt
	};
}
function makeRoutes(ctx, caches, catalogRuntime, config = {}, controller, triggerSnapshot) {
	const deps = {
		ctx,
		caches,
		catalogRuntime,
		controller
	};
	const { mcpCache, skillsCache, invalidateMcp, invalidateSkills } = caches;
	const cachedMcp = (sessionId) => {
		const key = sessionId ?? "*";
		pruneExpired(mcpCache, Date.now());
		const hit = mcpCache.get(key);
		if (hit && Date.now() - hit.at < 6e4) return hit.promise;
		const promise = collectMcp(deps, sessionId).catch((error) => {
			mcpCache.delete(key);
			throw error;
		});
		mcpCache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	const cachedSkills = (sessionId) => {
		const key = sessionId ?? "*";
		pruneExpired(skillsCache, Date.now());
		const hit = skillsCache.get(key);
		if (hit && Date.now() - hit.at < 6e4) return hit.promise;
		const promise = collectSkills(deps, sessionId).catch((error) => {
			skillsCache.delete(key);
			throw error;
		});
		skillsCache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	const routes = [
		{
			kind: "exact",
			path: `${API_PREFIX}/state`,
			handler: handle("GET", async (req) => {
				const url = req.url ?? "";
				const sessionId = queryParam(url, "session");
				const part = queryParam(url, "part") ?? "all";
				if (part === "mcp") return { state: await cachedMcp(sessionId) };
				if (part === "skills") return { state: await cachedSkills(sessionId) };
				const [mcp, skills] = await Promise.all([cachedMcp(sessionId), cachedSkills(sessionId)]);
				return { state: {
					...mcp,
					...skills,
					errors: [...mcp.errors, ...skills.errors]
				} };
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (!parsed.entryId) throw new Error("entryId is required");
				const applyMode = stateApplyMode(await readState());
				const result = await toggleMcp(deps, parsed.entryId, Boolean(parsed.disabled), applyMode);
				invalidateMcp();
				return result;
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toggleBatch`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				const toggles = Array.isArray(parsed.toggles) ? parsed.toggles : [];
				if (toggles.length === 0) throw new Error("toggles array is required (non-empty)");
				const applyMode = stateApplyMode(await readState());
				const results = [];
				let failed = 0;
				for (const item of toggles) {
					if (!item?.entryId) throw new Error("entryId is required in every toggle item");
					try {
						results.push(await toggleMcp(deps, item.entryId, Boolean(item.disabled), applyMode));
					} catch (error) {
						failed += 1;
						results.push({
							entryId: item.entryId,
							ok: false,
							error: messageOf$1(error)
						});
					}
				}
				invalidateMcp();
				return {
					results,
					count: results.length,
					failed
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/applyPending`,
			handler: handle("POST", async (req) => {
				if (JSON.parse(await readBody(req) || "{}").confirm !== true) throw new Error("applyPending 需要显式确认：请求体须带 { \"confirm\": true }（该操作会让当前会话下一轮 100% miss 前缀缓存，费率约为 hit 的 5–12.5 倍）。这是「用户已知晓费用」的强制生效出口，不接受静默调用。");
				const applied = await applyPendingMcp(deps);
				invalidateMcp();
				return {
					applied,
					confirmed: true
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/skill/toggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (!parsed.name) throw new Error("name is required");
				const result = await toggleSkill(deps, parsed.name, Boolean(parsed.disabled), parsed.session);
				invalidateSkills();
				return result;
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/skill/add`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) throw new Error("name is required");
				if (typeof parsed.description !== "string") throw new Error("description is required");
				if (typeof parsed.body !== "string") throw new Error("body is required");
				const target = parsed.target === "project" ? "project" : "global";
				let workspace = typeof parsed.workspace === "string" && parsed.workspace.length > 0 ? parsed.workspace : void 0;
				if (!workspace) workspace = resolveAgent(ctx, void 0)?.session?.header?.cwd;
				const result = await addSkill(parsed.name, parsed.description, parsed.body, target, workspace);
				const agent = resolveAgent(ctx, void 0);
				const cwd = agent?.session?.header?.cwd;
				const deadline = Date.now() + SKILL_TOGGLE_CONFIRM_MS;
				let confirmed = false;
				let wait = 80;
				while (Date.now() < deadline) {
					if (await ctx.skills.get(parsed.name, {
						scope: agent,
						cwd
					}).catch(() => void 0)) {
						confirmed = true;
						break;
					}
					const remaining = deadline - Date.now();
					if (remaining <= 0) break;
					await ctx.timeout(Math.min(wait, remaining));
					wait = Math.min(wait * 2, 1e3);
				}
				pruneExpired(confirmedSkills, Date.now());
				if (confirmed) confirmedSkills.set(parsed.name, {
					modelInvocable: true,
					at: Date.now()
				});
				invalidateSkills();
				return {
					target,
					...result,
					confirmed
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/config`,
			handler: handleAny([{
				method: "GET",
				run: async () => {
					const state = await readState();
					return {
						autoManage: catalogRuntime.autoManage,
						autoManageByRoute: stateAutoManageByRoute(state),
						autoManageMounted: catalogRuntime.autoManageMounted,
						middleLayerHides: stateMiddleLayerHides(state),
						applyMode: stateApplyMode(state),
						configAutoManage: config.autoManage ?? null,
						toolBudget: stateToolBudget(state) ?? null
					};
				}
			}, {
				method: "POST",
				run: async (req) => {
					const parsed = JSON.parse(await readBody(req) || "{}");
					const state = await readState();
					state.config ??= {};
					if (typeof parsed.autoManage === "boolean") state.config.autoManage = parsed.autoManage;
					if (parsed.routeOverride && typeof parsed.routeOverride.key === "string" && parsed.routeOverride.key.length > 0) {
						const table = state.config.autoManageByRoute ??= {};
						const value = parsed.routeOverride.value;
						if (typeof value === "boolean") table[parsed.routeOverride.key] = value;
						else delete table[parsed.routeOverride.key];
						if (Object.keys(table).length === 0) delete state.config.autoManageByRoute;
					}
					if (parsed.middleLayerHides === "disabled" || parsed.middleLayerHides === "all") state.config.middleLayerHides = parsed.middleLayerHides;
					if (parsed.applyMode === "immediate" || parsed.applyMode === "next-session") state.config.applyMode = parsed.applyMode;
					if (parsed.toolBudget === null) delete state.config.toolBudget;
					else if (typeof parsed.toolBudget === "number" && Number.isFinite(parsed.toolBudget) && parsed.toolBudget > 0) state.config.toolBudget = Math.round(parsed.toolBudget);
					await writeState(state);
					if (typeof parsed.autoManage === "boolean" || parsed.routeOverride !== void 0 || parsed.middleLayerHides !== void 0) {
						const master = typeof state.config.autoManage === "boolean" ? state.config.autoManage : catalogRuntime.autoManage;
						catalogRuntime.applyAutoManage(master, stateAutoManageByRoute(state), stateMiddleLayerHides(state));
					}
					invalidateMcp();
					return {
						autoManage: catalogRuntime.autoManage,
						autoManageByRoute: stateAutoManageByRoute(state),
						autoManageMounted: catalogRuntime.autoManageMounted,
						middleLayerHides: stateMiddleLayerHides(state),
						applyMode: stateApplyMode(state),
						toolBudget: stateToolBudget(state) ?? null
					};
				}
			}], true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/models`,
			handler: handle("GET", async (req) => {
				const session = queryParam(req.url ?? "", "session") ?? null;
				const catalog = await modelsCatalog(catalogRuntime.routeServices.llm);
				const state = await readState();
				return {
					providers: catalog.providers,
					autoManage: catalogRuntime.autoManage,
					autoManageByRoute: stateAutoManageByRoute(state),
					autoManageMounted: catalogRuntime.autoManageMounted,
					active: activeRouteView(catalogRuntime.decisionFor(resolveAgent(ctx, session ?? void 0))),
					session,
					cached: catalog.cached,
					fetchedAt: catalog.fetchedAt
				};
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/token`,
			handler: handle("GET", async () => ({ token: PANEL_TOKEN }))
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug`,
			handler: handle("GET", async () => {
				const catalog = {};
				for (const [server, info] of Object.entries(catalogRuntime.catalog)) catalog[server] = {
					tools: info.tools.length,
					fetchedAt: info.fetchedAt,
					source: info.source
				};
				let gateway;
				let controller;
				let inventory;
				try {
					const { gatewayStateForDebug, controllerStatusForDebug, inventoryTraceForDebug } = await import("./index.js");
					gateway = gatewayStateForDebug();
					controller = controllerStatusForDebug();
					inventory = inventoryTraceForDebug();
				} catch {
					gateway = void 0;
					controller = void 0;
				}
				let reaper;
				let counters;
				try {
					const { reaperDiagnostics, controllerCounters } = await import("./mcpcall-BuW-CWJy.mjs");
					reaper = reaperDiagnostics();
					counters = controllerCounters();
				} catch {
					reaper = void 0;
					counters = void 0;
				}
				const scopeDiag = { error: null };
				try {
					const scopeKey = await resolveCollectScopeKey(ctx, void 0);
					const scoped = scopeKey ? getSchemasView(ctx, caches, scopeKey, DOMAIN_TTL_MS) : [];
					const globalView = getSchemasView(ctx, caches, void 0, DOMAIN_TTL_MS);
					const mcpNames = (scopeKey ? mergeSchemas(scoped, globalView) : scoped).map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					const scopedMcp = scoped.map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					const globalMcp = globalView.map((s) => String(s?.name ?? "")).filter((name) => name.startsWith("mcp__"));
					scopeDiag.scopeKeyType = scopeKey ? typeof scopeKey : null;
					scopeDiag.scopeKeySource = scopeKeySource();
					scopeDiag.scopedTotal = scoped.length;
					scopeDiag.scopedMcpTools = scopedMcp.length;
					scopeDiag.globalTotal = globalView.length;
					scopeDiag.globalMcpTools = globalMcp.length;
					scopeDiag.mergedMcpTools = mcpNames.length;
					scopeDiag.scopedMcpSample = scopedMcp.slice(0, 20);
					scopeDiag.globalMcpSample = globalMcp.slice(0, 20);
				} catch (error) {
					scopeDiag.error = messageOf$1(error);
				}
				return {
					diag: catalogRuntime.diag,
					catalog,
					scopeDiag,
					standingDiag: standingDiag(),
					...controller ? { controllerStatus: controller } : {},
					...inventory !== void 0 ? { inventoryTrace: inventory } : {},
					...reaper !== void 0 ? { reaper } : {},
					...counters !== void 0 ? { counters } : {},
					...gateway ? { gateway } : {}
				};
			})
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/rowConfig`,
			handler: handleAny([{
				method: "GET",
				run: async (req) => {
					const server = (new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("server") ?? "").trim();
					if (!server) throw new Error("server is required");
					return {
						...maskDescribed(await describeRow(server)),
						editableKeys: EDITABLE_CONFIG_KEYS
					};
				}
			}, {
				method: "POST",
				run: async (req) => {
					const body = JSON.parse(await readBody(req) || "{}");
					const server = String(body.server ?? "").trim();
					if (!server) throw new Error("server is required");
					const described = await describeRow(server);
					if (described.entryFound !== true) throw new Error(`standing 行未找到：${server}`);
					const badKeys = [...Object.keys(body.set ?? {}), ...body.unset ?? []].filter((k) => !EDITABLE_CONFIG_KEYS.includes(k));
					if (badKeys.length > 0) throw new Error(`不允许的配置键：${badKeys.join(", ")}`);
					const live = described.config ?? {};
					let nextConfig = { ...live };
					for (const key of body.unset ?? []) delete nextConfig[key];
					for (const [key, value] of Object.entries(body.set ?? {})) nextConfig[key] = value;
					nextConfig = unmaskEcho(nextConfig, live);
					validateRowConfig(nextConfig);
					await writeRowConfigIntent(server, described, nextConfig);
					const applied = body.apply === false ? {
						ok: false,
						error: "skipped (apply:false)"
					} : await applyRowConfigToLive(server, nextConfig);
					invalidateMcp();
					return {
						ok: true,
						server,
						applied,
						after: maskDescribed(await describeRow(server))
					};
				}
			}], true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug/rowConfig`,
			handler: handleAny([{
				method: "GET",
				run: async (req) => {
					const server = (new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("server") ?? "").trim();
					if (!server) throw new Error("server is required");
					return maskDescribed(await describeRow(server));
				}
			}, {
				method: "POST",
				run: async (req) => {
					const body = JSON.parse(await readBody(req) || "{}");
					const server = String(body.server ?? "").trim();
					if (!server) throw new Error("server is required");
					const entry = findStandingEntryByServer(server);
					if (!entry) throw new Error(`standing 行未找到：${server}`);
					const before = await describeRow(server);
					const live = entry.options.config ?? {};
					let next = { ...live };
					for (const key of body.unset ?? []) delete next[key];
					for (const [key, value] of Object.entries(body.set ?? {})) next[key] = value;
					next = unmaskEcho(next, live);
					const allowed = [
						"serverName",
						"transport",
						"command",
						"args",
						"env",
						"cwd",
						"url",
						"headers",
						"toolCallTimeoutMs",
						"failOnStartupError"
					];
					const rejected = Object.keys(next).filter((k) => !allowed.includes(k));
					if (rejected.length > 0) throw new Error(`不允许的配置键：${rejected.join(", ")}`);
					if (body.update === false) return {
						dryRun: true,
						before: maskDescribed(before),
						willWrite: maskSecrets(next)
					};
					let updateError = null;
					try {
						await entry.update({ config: next });
					} catch (error) {
						updateError = messageOf$1(error);
					}
					await new Promise((resolve) => setTimeout(resolve, 1200));
					return {
						updateError,
						before: maskDescribed(before),
						after: maskDescribed(await describeRow(server))
					};
				}
			}], true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/debug/collect`,
			handler: handle("POST", async () => {
				try {
					const { ensureOpenMountsForDebug } = await import("./index.js");
					await ensureOpenMountsForDebug().catch(() => void 0);
				} catch {}
				await triggerSnapshot();
				return { diag: catalogRuntime.diag };
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toolToggle`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.serverName !== "string" || parsed.serverName.length === 0) throw new Error("serverName is required");
				if (typeof parsed.toolName !== "string" || parsed.toolName.length === 0) throw new Error("toolName is required");
				await setToolDisabled(parsed.serverName, parsed.toolName, Boolean(parsed.disabled));
				invalidateMcp();
				return {
					serverName: parsed.serverName,
					toolName: parsed.toolName,
					disabled: Boolean(parsed.disabled),
					disabledTools: [...disabledToolsOf(parsed.serverName)]
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/toolBulk`,
			handler: handleAny([{
				method: "POST",
				run: async (req) => {
					const parsed = JSON.parse(await readBody(req) || "{}");
					if (typeof parsed.serverName !== "string" || parsed.serverName.length === 0) throw new Error("serverName is required");
					if (typeof parsed.disabled !== "boolean") throw new Error("disabled (boolean) is required");
					const serverName = parsed.serverName;
					const row = (await cachedMcp(parsed.session)).mcp.find((item) => item.serverName === serverName);
					if (!row) throw new Error(`unknown MCP server: ${serverName}`);
					const known = row.toolList ?? [];
					if (known.length === 0) throw new Error(`no tool catalog for ${serverName} (enable it once so its tools can be discovered)`);
					const resolved = resolveToolBulkTargets(known.map((tool) => tool.name), parsed.toolNames);
					if ("error" in resolved) throw new Error(resolved.error);
					const changed = resolved.targets.length === 0 ? 0 : await setToolsDisabledBulk(serverName, resolved.targets, parsed.disabled);
					invalidateMcp();
					const disabledTools = [...disabledToolsOf(serverName)];
					return {
						serverName,
						disabled: parsed.disabled,
						disabledTools,
						disabledCount: disabledTools.length,
						changed,
						ignoredToolNames: resolved.ignored
					};
				}
			}], true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/preview`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.json !== "string" || parsed.json.trim().length === 0) throw new Error("json is required");
				const { servers, errors, warnings } = parseMcpServersJson(parsed.json);
				if (errors.length > 0) throw new Error(errors.join("；"));
				if (Object.keys(servers).length === 0) throw new Error("未解析出任何 MCP server");
				return {
					names: Object.keys(servers),
					yaml: serversToPatchYaml(servers),
					warnings
				};
			}, true)
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/mcp/add`,
			handler: handle("POST", async (req) => {
				const parsed = JSON.parse(await readBody(req) || "{}");
				if (typeof parsed.json !== "string" || parsed.json.trim().length === 0) throw new Error("json is required");
				const target = parsed.target === "project" ? "project" : "global";
				const { servers, errors, warnings } = parseMcpServersJson(parsed.json);
				if (errors.length > 0) throw new Error(`转换失败：${errors.join("；")}`);
				if (Object.keys(servers).length === 0) throw new Error("没有可添加的 MCP server");
				if (target === "global") {
					const result = await addGlobalMcp(ctx, servers);
					if (result.added === 0) throw new Error(`全部跳过（已存在或挂载失败）：${result.skipped.join("、") || "未知原因"}`);
					invalidateMcp();
					return {
						target,
						...result,
						warnings
					};
				}
				let workspace = typeof parsed.workspace === "string" && parsed.workspace.length > 0 ? parsed.workspace : void 0;
				if (!workspace) workspace = getActiveWorkspace() ?? resolveAgent(ctx, void 0)?.session?.header?.cwd;
				if (typeof workspace !== "string" || workspace.length === 0) throw new Error("project 目标需要 workspace（当前会话工作空间）");
				const written = await writeProjectMcp(workspace, servers);
				await remountWorkspace(ctx, workspace);
				invalidateMcp();
				return {
					target: "project",
					...written,
					workspace,
					added: Object.keys(servers).length,
					warnings
				};
			}, true)
		}
	];
	return [...routes, ...routes.map((route) => ({
		...route,
		path: route.path.replace(API_PREFIX, LEGACY_API_PREFIX)
	}))];
}
//#endregion
//#region src/index.ts
/**
* dsh-mcp-skill-panel — Host 半区入口
*
* 设置页「MCP 与技能管理面板」的数据与控制面：
* - MCP 页：枚举 loader 预设子树中的 mcp-* 行 + tools.schemas(scope) 聚合工具数/token，
*   启停 = loader entry.update({disabled})（实时生效）。
* - Skill 页：skills.snapshot/get 枚举目录，启停 = SKILL.md frontmatter
*   `disable-model-invocation: true` 注入/移除（watcher 实时失效 catalog）。
*
* 本文件只保留：Config / catalog 采集 / 中间层装配 / 生命周期。数据收集与路由见
* collect.ts / routes.ts，状态持久化见 state.ts / preset.ts，控制层见 mcpcall.ts。
*
* Phase A 实测结论（2026-08-15，动态探针验证）：
* - ctx.loader.entries() 枚举全部行（含嵌套预设行，id 如 include:agent-presets:mcp-cheatengine）
* - loader.resolve() 需要完整嵌套 id；entry.update({disabled}) 实时 dispose/restart
* - 预设树（PresetTree）write() 是 no-op → loader.update 不写盘
* - tools.schemas(scope) 必须传 scopeOf(agent.ctx)（agent 对象/standingKey 会落回全局视图）
* - skill 文件经 skills.get(name, {scope, cwd}).path 定位；改 frontmatter 由
*   dsh-skill-filesystem 的 chokidar watcher 实时失效
*
* MCP 持久化（v0.1.1 修复，2026-08-15）：
* 运行期禁止写 agent.cordis.yml —— dsh-agent-presets 的 ensureStanding 用
* {mtimeMs, size} stamp 检测预设文件变化，变化时删除 standing 记录并重挂，
* 但旧 standing 的 fiber/scope 不 dispose → 旧 mcp-client 实例的 serverName
* 仍占用 → 新挂载全部 "already in use" → 会话创建/resume 失败（实测事故）。
* 持久化改为：toggle 只写插件自己的状态文件（~/.dsh/dsh-mcp-skill-panel/state.json），
* 插件 apply 时（启动早期、standing 未挂载）再物化到预设文件 —— 此时写文件安全。
*/
let debugGatewayState = null;
function gatewayStateForDebug() {
	if (!debugGatewayState) return {
		mounted: [],
		lastCheck: null
	};
	return {
		mounted: [...debugGatewayState.mounts.keys()].sort(),
		lastCheck: debugGatewayState.lastCheck
	};
}
/**
* 0.5.8：/debug 只读曝光「临时启用控制器」的内部状态。
*
* 取证教训（0.5.7 首次实测「拉起后是否自动回收」）：当时只有「最终没关」这一个
* 事实，看不到 aiEnabled 集合是否真的收下了这个 server，也看不到回收器每轮的
* 判定输入，导致一轮实验不可判。此函数与 `reaperDiagnostics()` 一起把那条链
* 全部落成读数：`aiOwned`（回收器唯一作用域）+ 每轮 keepAliveMs/候选/跳过原因。
*/
let debugControllerStatus = null;
function controllerStatusForDebug() {
	if (!debugControllerStatus) return { aiOwned: [] };
	const now = Date.now();
	return { aiOwned: debugControllerStatus().map((row) => ({
		...row,
		idleMs: now - row.lastUsed
	})) };
}
/** 0.6.3：能力表采集的逐阶段痕迹（/debug 的 inventoryTrace）。 */
/**
* agent-presets 模块解析诊断（selftest / 装机排障；不参与任何逻辑判断）。
*
* 回答「本插件解析到的是哪一份实例」——`livePresetMounts()` 的挂载表是包内
* **模块私有** Set，解析错实例的后果是静默空表（面板 MCP 行全空），不是报错。
*/
function agentPresetApiForDebug() {
	return {
		specifier: presetApiDiag.specifier,
		resolvedPath: presetApiDiag.resolvedPath,
		base: presetApiDiag.base,
		errors: [...presetApiDiag.errors]
	};
}
function inventoryTraceForDebug() {
	return inventoryTraceDiag();
}
/** P5（W3）：/debug/collect 先挂载后快照的挂载入口（无 control 闭包时 no-op）。 */
let debugEnsureOpenMounts = null;
function ensureOpenMountsForDebug() {
	if (!debugEnsureOpenMounts) return Promise.resolve(void 0);
	return debugEnsureOpenMounts();
}
const name = "runtime-inventory";
const inject = [
	"fs",
	"skills",
	"tools",
	"agents",
	"agentPresets",
	"loader",
	"systemPrompt",
	"timer"
];
const Config = Schema.object({
	autoManage: Schema.boolean().description("MCP 中间层控制（停用的 MCP 经 dsh_mcp_search/dsh_mcp_call 按需调用）").default(false),
	keepAliveMs: Schema.number().min(1e3).description("MCP 保活空闲回收窗口（ms）").default(3e4),
	searchLimitDefault: Schema.number().min(1).description("dsh_mcp_search 缺省 top-K").default(8),
	searchLimitMax: Schema.number().min(1).description("dsh_mcp_search top-K 上限").default(10),
	serverSummary: Schema.dict(Schema.string()).description("MCP 能力摘要表（serverName → 一句话）")
});
/** 私有 catalog 持久化目录（与 state.ts 同目录 ~/.dsh/dsh-mcp-skill-panel）。 */
const CATALOG_DIR = join(homedir(), ".dsh", "dsh-mcp-skill-panel");
/** mcp_call 注册/调用的默认超时（读 entry config toolCallTimeoutMs，缺省回退）。 */
const DEFAULT_TOOL_TIMEOUT_MS = 6e4;
/** tools/change 后增量快照的去抖窗口。 */
const CATALOG_SNAPSHOT_DEBOUNCE_MS = 150;
/** catalog 持久化写盘防抖（P1-3）：tools/change 风暴期合并写盘。 */
const CATALOG_PERSIST_DEBOUNCE_MS = 300;
/** 从 loader entries 反查某 serverName 对应的 mcp 行（serverName 取自 config）。 */
function findMcpEntry(ctx, serverName) {
	for (const entry of ctx.loader.entries()) {
		if (!isMcpEntry(entry)) continue;
		if (serverNameOf(entry) === serverName) return entry;
	}
	return findStandingEntryByServer(serverName);
}
/** server 自己的注册/调用超时阈值。 */
function serverTimeoutMs(ctx, serverName) {
	const entry = findMcpEntry(ctx, serverName);
	if (!entry) return DEFAULT_TOOL_TIMEOUT_MS;
	const t = mcpEntryConfig(entry)?.toolCallTimeoutMs;
	return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_TOOL_TIMEOUT_MS;
}
function sameToolList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i].name !== b[i].name || a[i].description !== b[i].description) return false;
	return true;
}
/** 原子写回 catalog.json；失败保留 dirty 标记以在下次重试。
* P1-3：写盘后 CATALOG_PERSIST_DEBOUNCE_MS 内的新变更延迟合并（ctx.timeout 绑 ctx，
* 卸载自动清理）；正在写盘时置 dirty 排队（finally 补一次）。 */
async function persistCatalog(next, runtime) {
	if (runtime.persisting) {
		runtime.dirty = true;
		return;
	}
	if (!runtime.dirty) return;
	const ctx = next();
	if (runtime.lastPersistAt !== null && Date.now() - runtime.lastPersistAt < CATALOG_PERSIST_DEBOUNCE_MS) {
		runtime.persistTimer?.();
		runtime.persistTimer = ctx.timeout(() => {
			runtime.persistTimer = void 0;
			persistCatalog(next, runtime);
		}, CATALOG_PERSIST_DEBOUNCE_MS);
		return;
	}
	runtime.persisting = true;
	try {
		await saveCatalog(CATALOG_DIR, runtime.catalog);
		runtime.dirty = false;
		runtime.lastPersistAt = Date.now();
	} catch (error) {
		ctx.logger.warn(`mcp-skill-panel: catalog persist failed: ${messageOf$1(error)}`);
	} finally {
		runtime.persisting = false;
		if (runtime.dirty) persistCatalog(next, runtime);
	}
}
/**
* 解析 scope 并取 schema 视图（preset 层共享，任一 standing 即可）。
*
* 关键坑（v0.4.1 + 2026-08-27）：HTTP/apply ctx 下 agents/standingKeyFor 视图
* 受限（roots/list 空或服务不可解析）。统一走 collect.resolveCollectScopeKey 的
* 进程级缓存：apply 早期预热一次，快照与面板路径共用同一 standing scope key。
*/
async function resolveScopeSchemas(ctx, caches) {
	const scopeKey = await resolveCollectScopeKey(ctx, void 0);
	if (scopeKey === void 0) return [];
	return getSchemasView(ctx, caches, scopeKey, 500);
}
/** 对所有当前 enabled 的 mcp server 重新快照。 */
async function snapshotEnabled(ctx, runtime, caches) {
	runtime.diag.snapshots += 1;
	if (!runtime.loaded) {
		runtime.diag.lastAt = Date.now();
		runtime.diag.lastError = "skipped: catalog not loaded yet";
		return;
	}
	try {
		const next = { ...runtime.catalog };
		let changed = false;
		let rootsCount = 0;
		let listCount = 0;
		try {
			rootsCount = ctx.agents.roots().length;
			listCount = ctx.agents.list().length;
		} catch {
			rootsCount = -1;
			listCount = -1;
		}
		runtime.diag.lastAgentRoots = rootsCount;
		runtime.diag.lastAgentList = listCount;
		const schemas = await resolveScopeSchemas(ctx, caches);
		runtime.diag.lastSchemasTotal = schemas.length;
		let mcpTools = 0;
		for (const schema of schemas) if (String(schema.name ?? "").startsWith("mcp__")) mcpTools += 1;
		runtime.diag.lastMcpTools = mcpTools;
		runtime.diag.lastScope = mcpTools > 0;
		const rowsByName = /* @__PURE__ */ new Map();
		for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
			if (!isMcpEntry(entry)) continue;
			if (!rowsByName.has(serverNameOf(entry))) rowsByName.set(serverNameOf(entry), entry);
		}
		for (const [serverName, entry] of rowsByName) {
			if (entry.disabled) continue;
			let tools;
			try {
				tools = snapshotFromSchemas(schemas, serverName);
			} catch {
				continue;
			}
			const prev = next[serverName];
			if (prev && prev.source === "live" && sameToolList(prev.tools, tools)) continue;
			if (tools.length === 0) continue;
			next[serverName] = {
				tools,
				fetchedAt: Date.now(),
				source: "live"
			};
			changed = true;
		}
		const alive = /* @__PURE__ */ new Set();
		for (const entry of [...ctx.loader.entries(), ...standingMcpEntries()]) {
			if (!isMcpEntry(entry)) continue;
			alive.add(serverNameOf(entry));
		}
		if (alive.size > 0) {
			for (const key of Object.keys(next)) if (!alive.has(key)) {
				delete next[key];
				changed = true;
			}
		}
		runtime.catalog = next;
		if (changed) {
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
		}
		runtime.diag.lastAt = Date.now();
		runtime.diag.lastError = null;
	} catch (error) {
		runtime.diag.lastError = messageOf$1(error);
		runtime.diag.lastAt = Date.now();
	}
}
/** 构建控制层依赖（McpControlCtx）：封闭 catalog/loader/state 的 IO。 */
function buildMcpControl(ctx, runtime, config, caches) {
	const presetRowCache = /* @__PURE__ */ new Map();
	const cachedPresetRow = async (agent, serverName) => {
		try {
			const live = agent ?? ctx.agents.roots()[0] ?? ctx.agents.list()[0];
			const presetId = live ? ctx.agentPresets.composedPreset(live.ctx) ?? null : null;
			if (!presetId) return void 0;
			const key = `${presetId}\0${serverName}`;
			const hit = presetRowCache.get(key);
			if (hit && Date.now() - hit.at < 6e4) return hit.row;
			const row = await findPresetRowByServerName(ctx, presetId, serverName);
			presetRowCache.set(key, {
				at: Date.now(),
				row
			});
			if (presetRowCache.size > 500) {
				const oldest = presetRowCache.keys().next();
				if (!oldest.done) presetRowCache.delete(oldest.value);
			}
			return row;
		} catch {
			return;
		}
	};
	return {
		keepAliveMs: config.keepAliveMs ?? 3e4,
		searchLimitDefault: config.searchLimitDefault ?? 8,
		searchLimitMax: config.searchLimitMax ?? 10,
		serverSummary: config.serverSummary ?? {},
		getCatalog: () => runtime.catalog,
		setCatalog: (catalog) => {
			runtime.catalog = catalog;
		},
		persistCatalog: () => persistCatalog(() => ctx, runtime),
		resolveEntry: (serverName) => findMcpEntry(ctx, serverName),
		serverTimeoutMs: (serverName) => serverTimeoutMs(ctx, serverName),
		resolvePresetRow: async (serverName, agent) => cachedPresetRow(agent, serverName),
		resolvePresetConfig: async (serverName, agent) => {
			try {
				return (await cachedPresetRow(agent, serverName))?.config;
			} catch {
				return;
			}
		},
		presetTimeoutMs: async (serverName) => {
			try {
				return (await cachedPresetRow(void 0, serverName))?.toolCallTimeoutMs;
			} catch {
				return;
			}
		},
		setAiOwner: (entryId, at) => setStateAiOwner(entryId, at),
		clearAiOwner: (entryId) => clearStateAiOwner(entryId),
		snapshotEnabled: () => snapshotEnabled(ctx, runtime, caches),
		requestSnapshot: () => snapshotEnabled(ctx, runtime, caches),
		/**
		* 0.6.0：按需采集能力表（mcp_search 命中「已安装但无快照」的关闭行时）。
		* 行此刻已被调用方临时拉起，这里只负责采 schema 快照 + 落 catalog.json。
		*/
		collectInventory: async (serverName) => {
			const tools = snapshotFromSchemas(await resolveScopeSchemas(ctx, caches), serverName);
			if (tools.length === 0) return null;
			runtime.catalog = {
				...runtime.catalog,
				[serverName]: {
					tools,
					fetchedAt: Date.now(),
					source: "live"
				}
			};
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
			return {
				tools: tools.length,
				joined: false
			};
		},
		/** 0.6.0：已安装的 MCP server 清单（含用户关闭的，来自 standing 树）。 */
		installedInventory: () => installedMcpRows().map((row) => ({
			server: row.serverName,
			open: row.open
		})),
		/**
		* P3b（G3 / 评审风险 7）：中间层隐藏范围的**当下值**（函数式读取，非快照 ——
		* /config 可动态切换）。能力摘要表按它换口径，否则摘要会宣称 server
		* 「已打开并对模型可见」，与 hideAll 下本次装配的实际可见性直接矛盾。
		*/
		middleLayerHides: () => runtime.middleLayerHides,
		/**
		* 0.6.2：由调用方（命中视图）采到的 schema 落 catalog —— **首选**采集路径。
		* 0.6.1 的采空 bug 正是口径不一致所致（见 mcpcall.ts collectInventory 注释），
		* 这里只做过滤与落盘，采集口径由调用方给定。
		*/
		storeInventory: async (serverName, schemas) => {
			const tools = snapshotFromSchemas(schemas, serverName);
			if (tools.length === 0) return null;
			runtime.catalog = {
				...runtime.catalog,
				[serverName]: {
					tools,
					fetchedAt: Date.now(),
					source: "live"
				}
			};
			runtime.dirty = true;
			persistCatalog(() => ctx, runtime);
			return {
				tools: tools.length,
				joined: false
			};
		}
	};
}
/**
* 中间层是否需要挂载（P3b；评审 §3-G 第 5 条 / §3-I）。
*
* 挂载条件不是「总开关 on」而是「有任何模型可能用到」：总开关关 + `grok: true`
* 也必须挂 —— 控制工具注册表是进程级的一份，不挂的话覆盖项永远无法生效
* （被覆盖的模型会看到 dsh_mcp_search，但 preset 关态行拉不起来）。
*
* G2 一致性不变量（由 selftest 穷举 master × 覆盖表 × 模型验证）：
* 任一会话 `routeDecision(...).on === true` ⇒ 本函数必为 true。
* 两者读的是同一份输入（master + 覆盖表），所以只要挂载不失败就不会出现
* 「gate 打开但网关没挂」；挂载失败时 applyAutoManage 会把覆盖表清空兜住。
* @param master - 总开关（state.json 的 config.autoManage）。
* @param byRoute - 覆盖表（键为 provider 或 provider/model）。
* @returns 是否需要挂载中间层。
*/
function autoManageNeeded(master, byRoute) {
	return master || Object.values(byRoute).some((value) => value === true);
}
function apply(ctx, config = {}) {
	(async () => {
		try {
			await ensureAgentPresetApi(ctx);
		} catch (error) {
			ctx.logger.warn(`mcp-skill-panel: agent-presets 读取面解析失败: ${messageOf$1(error)}`);
		}
	})();
	loadDisabledTools().catch((error) => {
		ctx.logger.warn(`mcp-skill-panel: 加载工具级禁用表失败: ${messageOf$1(error)}`);
	});
	rebuildOwnersFromState(ctx).catch((error) => {
		ctx.logger.warn(`mcp-skill-panel: 重建项目 MCP owner 映射失败: ${messageOf$1(error)}`);
	});
	syncPresetFiles(ctx).then((count) => {
		if (count > 0) ctx.logger.info(`runtime-inventory: materialized ${count} MCP row state(s) into preset composition`);
	}, (error) => {
		ctx.logger.warn(`runtime-inventory: preset sync skipped: ${messageOf$1(error)}`);
	});
	setRowConfigApplyHook(async (server, nextConfig) => {
		const entry = findStandingEntryByServer(server);
		if (!entry) return {
			ok: false,
			error: `standing 行未找到：${server}`
		};
		try {
			await entry.update({ config: nextConfig });
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: messageOf$1(error)
			};
		}
	});
	const catalogRuntime = {
		catalog: {},
		dirty: false,
		persisting: false,
		loaded: false,
		autoManage: false,
		autoManageByRoute: {},
		middleLayerHides: "disabled",
		autoManageMounted: false,
		applyAutoManage: () => {},
		decisionFor: () => ({
			on: false,
			source: "master",
			route: void 0
		}),
		routeServices: {},
		lastPersistAt: null,
		persistTimer: void 0,
		tokenCache: /* @__PURE__ */ new Map(),
		diag: {
			toolsChangeEvents: 0,
			snapshots: 0,
			lastError: null,
			lastAt: null,
			lastMcpTools: null,
			lastSchemasTotal: null,
			lastScope: null,
			lastAgentRoots: null,
			lastAgentList: null,
			loadedAt: null,
			loadedServers: null,
			get routeServices() {
				const holder = catalogRuntime.routeServices;
				return {
					projections: holder.projections !== void 0,
					defaultModel: holder.defaultModel !== void 0,
					llm: holder.llm !== void 0
				};
			},
			get middleware() {
				return {
					mounted: catalogRuntime.autoManageMounted,
					master: catalogRuntime.autoManage,
					byRoute: { ...catalogRuntime.autoManageByRoute },
					hides: catalogRuntime.middleLayerHides
				};
			}
		}
	};
	loadCatalog(CATALOG_DIR).then((catalog) => {
		catalogRuntime.catalog = catalog;
		catalogRuntime.loaded = true;
		catalogRuntime.diag.loadedAt = Date.now();
		catalogRuntime.diag.loadedServers = Object.keys(catalog).length;
	}, () => {
		catalogRuntime.catalog = {};
		catalogRuntime.loaded = true;
		catalogRuntime.diag.loadedAt = Date.now();
		catalogRuntime.diag.loadedServers = 0;
	});
	const caches = createDomainCaches();
	ctx.effect(() => {
		const offTools = ctx.root.on("tools/change", caches.invalidateMcp);
		const offLoader = ctx.root.on("loader/partial-dispose", caches.invalidateMcp);
		const offSkills = ctx.root.on("skills/change", caches.invalidateSkills);
		return () => {
			offTools();
			offLoader();
			offSkills();
		};
	}, "runtime-inventory: cache invalidation");
	ctx.effect(() => {
		let scheduled = false;
		return ctx.root.on("tools/change", () => {
			catalogRuntime.diag.toolsChangeEvents += 1;
			if (scheduled) return;
			scheduled = true;
			ctx.timeout(() => {
				scheduled = false;
				snapshotEnabled(ctx, catalogRuntime, caches);
			}, CATALOG_SNAPSHOT_DEBOUNCE_MS);
		});
	}, "mcp-skill-panel: catalog snapshot");
	snapshotEnabled(ctx, catalogRuntime, caches).catch(() => {});
	const disposeProjectMcp = installProjectMcp(ctx);
	ctx.effect(() => () => disposeProjectMcp(), "mcp-skill-panel: project mcp teardown");
	const disposeToolFilter = installToolDisableFilter(ctx);
	ctx.effect(() => () => disposeToolFilter(), "mcp-skill-panel: tool disable teardown");
	const control = buildMcpControl(ctx, catalogRuntime, config, caches);
	const controller = createMcpCallController(ctx, control);
	const buildVisibility = () => {
		const map = /* @__PURE__ */ new Map();
		const put = (entry) => {
			if (!isMcpEntry(entry)) return;
			const serverName = serverNameOf(entry);
			const visible = !entry.disabled && !controller.isAiEnabled(serverName);
			const prev = map.get(serverName);
			map.set(serverName, prev === void 0 ? visible : prev && visible);
		};
		for (const entry of ctx.loader.entries()) put(entry);
		for (const entry of standingMcpEntries()) put(entry);
		return map;
	};
	const routeServices = installRouteServices(ctx);
	catalogRuntime.routeServices = routeServices;
	catalogRuntime.decisionFor = (agent) => routeDecision(resolveRoute(routeServices, agent), catalogRuntime.autoManage, catalogRuntime.autoManageByRoute);
	const gateFor = (agent) => ({
		on: catalogRuntime.decisionFor(agent).on,
		hideAll: catalogRuntime.middleLayerHides === "all"
	});
	let autoDisposers = [];
	const gatewayState = createGatewayState();
	debugGatewayState = gatewayState;
	debugControllerStatus = () => controller.status();
	debugEnsureOpenMounts = () => ensureOpenMounts({
		ctx,
		control,
		state: gatewayState
	});
	catalogRuntime.applyAutoManage = (on, byRoute, hides) => {
		for (const d of autoDisposers) d();
		autoDisposers = [];
		disposeGatewayStateSync(ctx, gatewayState);
		catalogRuntime.autoManage = on;
		if (byRoute !== void 0) catalogRuntime.autoManageByRoute = byRoute;
		if (hides !== void 0) catalogRuntime.middleLayerHides = hides;
		const needed = autoManageNeeded(on, catalogRuntime.autoManageByRoute);
		catalogRuntime.autoManageMounted = false;
		if (!needed) return;
		const disposers = [];
		try {
			disposers.push(installMcpVisibilityFilter(ctx, buildVisibility, gateFor));
			disposers.push(installMcpControlTools(ctx, control, controller));
			const offReaper = controller.startIdleReaper();
			disposers.push(() => offReaper());
		} catch (error) {
			for (const d of disposers) d();
			catalogRuntime.autoManage = false;
			catalogRuntime.autoManageByRoute = {};
			ctx.logger.warn(`mcp-skill-panel: autoManage enable failed: ${messageOf$1(error)}`);
			return;
		}
		autoDisposers = disposers;
		catalogRuntime.autoManageMounted = true;
		ensureOpenMounts({
			ctx,
			control,
			state: gatewayState
		}).catch((error) => {
			ctx.logger.warn(`mcp-skill-panel: gateway ensureOpenMounts failed: ${messageOf$1(error)}`);
		});
	};
	ctx.effect(() => () => {
		for (const d of autoDisposers) d();
		disposeGatewayStateSync(ctx, gatewayState);
	}, "mcp-skill-panel: autoManage teardown");
	catalogRuntime.applyAutoManage(Boolean(config.autoManage), {}, "disabled");
	let appliedKey = JSON.stringify([
		Boolean(config.autoManage),
		{},
		"disabled"
	]);
	readState().then((state) => {
		const master = typeof state.config?.autoManage === "boolean" ? state.config.autoManage : Boolean(config.autoManage);
		const byRoute = stateAutoManageByRoute(state);
		const hides = stateMiddleLayerHides(state);
		const key = JSON.stringify([
			master,
			byRoute,
			hides
		]);
		if (key === appliedKey) return;
		appliedKey = key;
		catalogRuntime.applyAutoManage(master, byRoute, hides);
		const overrides = Object.keys(byRoute).length;
		ctx.logger.info(`mcp-skill-panel: autoManage = ${master}, hides = ${hides}${overrides > 0 ? ` (+${overrides} per-model override(s))` : ""} (from panel state)`);
	});
	ctx.effect(() => {
		let guard = false;
		return ctx.root.on("agent/session-start", () => {
			if (guard) return;
			guard = true;
			applyPendingMcp({
				ctx,
				controller
			}).then((count) => {
				if (count > 0) {
					caches.invalidateMcp();
					ctx.logger.info(`runtime-inventory: applied ${count} pending MCP change(s) at session boundary`);
				}
			}).catch((error) => {
				ctx.logger.warn(`runtime-inventory: session-boundary apply failed: ${messageOf$1(error)}`);
			}).finally(() => {
				guard = false;
			});
		});
	}, "runtime-inventory: session-boundary apply");
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => {
			const disposers = makeRoutes(httpCtx, caches, catalogRuntime, config, controller, () => snapshotEnabled(httpCtx, catalogRuntime, caches)).map((route) => httpCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "runtime-inventory: routes");
	});
}
//#endregion
export { CONTROL_TOOL_NAMES, Config, GATEWAY_ENTRY_PREFIX, MCP_CALL_TOOL, MCP_SEARCH_TOOL, __resetModelsCache, presetKeyOf as a, activeRouteView, agentPresetApiForDebug, apply, applyPendingMcp, autoManageNeeded, buildSkillMd, buildSummaryHeader, configSetToYaml as c, checkChildVisible, computeStatus, controllerStatusForDebug, createGatewayState, controllerCounters as d, decideMount, disabledToolsOf, disposeGatewayState, disposeGatewayStateSync, ensureOpenMounts, ensureOpenMountsForDebug, createMcpCallController as f, fetchProviderCatalog, findPresetRowByServerName, gatewayCall, gatewayEntryId, gatewayServerOfEntryId, gatewayStateForDebug, reaperDiagnostics as h, livePresetRowsToRows as i, inject, installMcpVisibilityFilter, installProjectMcp, inventoryTraceForDebug, isToolDisabled, isValidSkillName, isolateChildScope, configValueToYaml as l, loadDisabledTools, inventoryTraceDiag as m, mergeSchemas, modelsCacheFresh, modelsCatalog, msgOf, listPresetMcpRows as n, name, normalizeArguments, normalizeToolName, EDITABLE_CONFIG_KEYS as o, installMcpControlTools as p, parsePresetMcpText, pendingMcp, pendingMcpCount, presetConfigOf, projectServerName, projectServerOwner, listPresetMcpRowsOrThrow as r, readState, remountWorkspace, resolveRoute, resolveToolBulkTargets, routeDecision, routeKey, rowDisabledState, rowDisplay, configKeysToYamlText as s, scanWorkspaceMcp, setRowFlag, setSkillFlag, setToolDisabled, setToolsDisabledBulk, stateAutoManageByRoute, stateMiddleLayerHides, stateToolBudget, syncPresetFiles, findPresetRowByEntryId as t, setRowConfigKeys as u, writeState };
