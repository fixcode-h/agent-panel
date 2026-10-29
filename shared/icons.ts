import { t } from './i18n.ts'

/** Agent 可选图标的 id 和含义；图标组件在 web/src/lib/agent-icons.ts 里对应 */
export const AGENT_ICON_IDS = [
  ['bot', t('通用')],
  ['brain', t('规划')],
  ['workflow', t('调度')],
  ['code', t('编码')],
  ['layout', t('前端')],
  ['database', t('后端')],
  ['palette', t('设计')],
  ['test', t('测试')],
  ['bug', t('排错')],
  ['shield', t('审查')],
  ['search', t('调研')],
  ['doc', t('文档')],
  ['wrench', t('运维')],
  ['rocket', t('发布')],
  ['wand', t('优化')],
  ['sparkles', t('创意')],
  ['eye', t('走查')],
  ['languages', t('翻译')],
] as const
