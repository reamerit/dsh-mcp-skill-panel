# `ctx.agents.roots()` 在 DSH 0.2.2-rc.2 被删除（v0.7.3）

## 事故

在 dsh `0.2.2-rc.2` 的 web profile 上安装/升级本插件，插件**整棵子树装载失败**，
设置页没有 MCP / Skill 面板。宿主报错原文：

```
ctx.agents.roots is not a function
```

0.7.2 在 0.2.0-rc.2 上装过、能跑，所以这是宿主再次演进引入的回归，不是安装通道问题
（pnpm 安装本身 exit=0，包也在 `node_modules` 里）。

## 根因

- `@deepseek-ai/dsh-agent` 的 `AgentRegistry` 公开读取面被收窄成 `get(id)` / `list()`：
  - `0.1.2-rc.1`：`lib/types/index.d.ts:365` 有 `roots(): Agent[]`；
  - `0.2.2-rc.2`：同名文件只剩 `get` / `list`，整个宿主 `lib/**` 里搜不到任何 `roots(`。
- 插件在 `apply` 期就把 `roots()` 当入口用（不是可选降级路径）：
  `collect.ts` 的 `resolveAgent`、`gateway.ts` 的 `ensureOpenMounts`、
  `index.ts` 的采集诊断与 `cachedPresetRow`。第一个调用点直接抛 `TypeError`，
  `apply` 中断 → 行 `include:runtime-inventory` 装载失败。
- 为什么之前没被发现：0.7.0 的适配只覆盖了 `agentPresets` 服务的删改（`standingKeyFor` 移除、
  包拆成 `dsh-agent-preset` + `dsh-agent-preset-registry`），`agents` 服务没动过。

## 决策

新增 `src/agents-compat.ts` 作为**唯一**一处 `roots()` 调用点：

- 旧宿主（≤ 0.2.1）：`roots()` 在场就原样沿用，0.1.x / 0.2.0 行为逐字节不变；
- 新宿主（0.2.2+）：`roots()` 不存在 → 用 `SessionHeader` 的**持久**判据从 `list()` 里挑顶层：
  - `origin === 'subagent'` → 排除。`SessionHeader` 的原注释明确「`parentSession` 的存在
    本身不能判定子代理，要用 `origin`」（普通 fork 也带 `parentSession`），故不认 `parentSession`；
  - `delegationDepth > 0` → 排除（顶层缺省 =0，子代理 = 父层 +1）；
- 降级方向只允许更宽松：过滤结果为空 → **回落整张 `list()`**，与旧写法
  `roots()[0] ?? list()[0]` 完全同义；服务缺失 / `list()` 抛错 → `[]`，不抛。
- 四个调用点统一改走 `rootAgents(ctx)` / `firstRootAgent(ctx)`。

## Alternatives

- **只给 `roots` 打 typeof 守卫、缺失时直接 `list()[0]`** —— 最小改动，但 `list()` 含子代理：
  多会话下会把「子代理的 preset / cwd」当成用户的当前会话，面板显示错会话，静默错。
- **用 `header.parentSession` 判顶层** —— 普通 fork 也带该字段，会把 fork 出去的会话误判为子代理。
- **在 `apply` 里 try/catch 吞掉并整体降级** —— `TypeError` 发生在 `resolveAgent`/`ensureOpenMounts`
  这类请求期路径上，吞掉只会让面板静默退化成空清单，问题更难查。

## Consequences

- 宿主 `agents` 服务若再次改名，只需要改 `agents-compat.ts` 一处；其余模块不再直接触碰服务面。
- 顶层判定以**持久 lineage** 近似旧的**运行时 ownership**：极端情况下（子代理会话在 resume 后
  成为顶层）两者可能不同，但过滤只影响「挑哪个 agent」，仍带 `list()` 兜底，不会失去 agent。
- 已验证：`0.2.2-rc.2` 上 `include:runtime-inventory` 为 `fiberPhase: active`，
  `GET /api/mcp-skill-panel/state` 返回真实会话/preset/cwd；`agents-compat` 六个分支
  （旧 roots 优先、新宿主过滤、fork 保留、header 缺失兜底、roots 抛错、list 抛错）全部自测通过。
