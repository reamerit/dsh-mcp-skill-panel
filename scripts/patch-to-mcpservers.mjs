/**
 * 从某个 profile 的 cordis.patch.yml 里抽出 @deepseek-ai/dsh-mcp-client 行，
 * 转成标准 mcpServers JSON（即 claude code / codex 的 .mcp.json 形态），
 * 供项目级 <workspace>/.dsh/mcps/mcp.json 使用。
 *
 * 为什么解析真 YAML 而不是手敲 JSON：patch 里的 env/headers 是 loader 的 `!!js`
 * 表达式（`!!js (process.env.X || '')`），手抄容易把语义抄错（比如把 `|| ''`
 * 丢掉、或把模板字面量写成普通字符串）。这里把 `!!js` 反解成 `${VAR}` 占位 ——
 * 正是项目级 mcp.json 的占位符约定（mcp-convert.ts:resolveServersEnv 挂载时解析）。
 *
 * 用法：node scripts/patch-to-mcpservers.mjs <cordis.patch.yml> [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const yaml = require('js-yaml')

const [patchPath, outPath] = process.argv.slice(2)
if (!patchPath) {
  console.error('用法: node scripts/patch-to-mcpservers.mjs <cordis.patch.yml> [out.json]')
  process.exit(2)
}

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/**
 * `!!js` 标量：拿原文，供下面反解成 `${VAR}` 占位。
 * 注意 tag 必须写 js-yaml 规范化后的全名 —— 写 `!!js` 会报
 * `unknown tag !<tag:yaml.org,2002:js>`（js-yaml 把 `!!x` 展开成全 URI）。
 */
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (text) => text !== null && text !== undefined,
  construct: (text) => ({ __js: text }),
})

/** 反解一个 `!!js` 表达式体 → 可移植字符串；解不出就原样回报，绝不静默丢值。 */
function fromJsExpression(expr) {
  const text = String(expr).trim()
  // 形如 `process.env.GITLAB_TOKEN` / `(process.env.X || '')`
  const bare = /^\(?\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\|\s*'([^']*)')?\s*\)?$/.exec(text)
  if (bare) return { value: `\${${bare[1]}}`, note: null }
  // 形如 `` `...${process.env.X}...` ``（模板字面量）
  if (text.startsWith('`') && text.endsWith('`')) {
    const inner = text.slice(1, -1)
    const rewritten = inner.replace(/\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
    if (!rewritten.includes('process.env')) return { value: rewritten, note: null }
    return { value: text, note: '模板字面量含无法反解的表达式，原样保留' }
  }
  return { value: text, note: `无法反解成 \${VAR} 占位，原样保留：${text}` }
}

/** 深度遍历：把 `!!js` 标记反解掉。 */
function resolveJs(node, path, notes) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    if ('__js' in node) {
      const { value, note } = fromJsExpression(node.__js)
      if (note) notes.push(`${path}: ${note}`)
      return value
    }
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveJs(v, `${path}.${k}`, notes)
    return out
  }
  if (Array.isArray(node)) return node.map((v, i) => resolveJs(v, `${path}[${i}]`, notes))
  return node
}

const doc = yaml.load(readFileSync(patchPath, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })

const notes = []
const servers = {}
let scanned = 0
for (const entry of Array.isArray(doc) ? doc : []) {
  const rows = entry?.insert
  for (const row of Array.isArray(rows) ? rows : []) {
    scanned += 1
    if (row?.name !== MCP_CLIENT) continue
    const cfg = resolveJs(row.config ?? {}, `row ${row.id ?? '?'}.config`, notes)
    const serverName = cfg.serverName ?? String(row.id ?? '').replace(/^mcp-/, '')
    if (!serverName) {
      notes.push(`row ${row.id ?? '?'}: 缺 serverName，跳过`)
      continue
    }
    // 保持标准 mcpServers 形态（不含 dsh 专有的 transport 字段）。
    // 传输方式由 parser 按「有 command → stdio / 有 url → http」推断，与惯例一致。
    const server = {}
    for (const key of ['command', 'args', 'env', 'cwd', 'url', 'headers']) {
      if (cfg[key] !== undefined) server[key] = cfg[key]
    }
    servers[serverName] = server
  }
}

const result = { mcpServers: servers }
const json = JSON.stringify(result, null, 2) + '\n'

if (outPath) writeFileSync(outPath, json, 'utf8')

console.log(`patch 行总数 ${scanned}，其中 dsh-mcp-client 行 ${Object.keys(servers).length}`)
console.log(`server 列表: ${Object.keys(servers).join(', ')}`)
if (notes.length > 0) {
  console.log('\n注意：')
  for (const n of notes) console.log('  - ' + n)
}
console.log('\n--- 产出 JSON ---')
console.log(outPath ? `已写入 ${outPath}` : json)
