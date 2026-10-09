/**
 * 预设文本工具的**独立入口**（供 selftest 导入）。
 *
 * 为什么不直接从 index.ts 导入：index 会连带加载 `@deepseek-ai/*` 宿主包
 * （dsh-agent-presets 等），而仓库 devDependencies 里那份不完整 → 自测直接
 * ERR_MODULE_NOT_FOUND。本入口只 re-export 纯文本函数，零宿主依赖。
 */
export {
  setRowFlag,
  setRowConfigKeys,
  rowDisabledState,
  configValueToYaml,
  configSetToYaml,
  configKeysToYamlText,
  EDITABLE_CONFIG_KEYS,
} from './preset'

// 0.7.0 数据源迁移的纯映射：live 树行 → 面板行（0.2.0 唯一可用面）。
// 与上面同理必须零宿主依赖 —— 该函数只做字段搬运，不 import 任何宿主包。
export { livePresetRowsToRows, presetKeyOf } from './preset-mcp'
