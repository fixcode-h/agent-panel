/**
 * 调用记录里各种值的叫法：决定、调用类别、命令类别、钩子来源。写成函数：t() 要在切换界面语言之后再取
 */
import { t } from '@shared/i18n'
import { BUILTIN_HOOKS } from '@shared/hooks/builtins'
import { CAPABILITIES } from '@shared/capability-router/capabilities'
import type { CallKind, CallRecord, CommandCategory, GatewayDecision } from '@shared/tool-gateway/types'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export const DECISION_LOOKS: Record<GatewayDecision, { label: () => string; tone: Tone }> = {
  pass: { label: () => t('放行'), tone: 'neutral' },
  rewrite: { label: () => t('改写'), tone: 'accent' },
  serve: { label: () => t('代答'), tone: 'accent' },
  redirect: { label: () => t('改用'), tone: 'warning' },
  deny: { label: () => t('拒绝'), tone: 'danger' },
}

export const KIND_LABEL: Record<CallKind, () => string> = {
  read: () => t('读文件'),
  edit: () => t('改文件'),
  shell: () => t('命令'),
  mcp: () => 'MCP',
  panel: () => t('面板工具'),
  other: () => t('其他'),
}

export const CATEGORY_LABEL: Record<CommandCategory, () => string> = {
  search: () => t('搜索'),
  lint: () => t('检查'),
  test: () => t('测试'),
  build: () => t('编译'),
  vcs: () => t('版本管理'),
  read: () => t('读文件'),
  long: () => t('长命令'),
}

export const capabilityLabel = (id: string) => CAPABILITIES.find((c) => c.id === id)?.label() ?? id

/** builtin:<id> 换成内置钩子的名字；用户钩子、插件钩子原样 */
export function hookLabel(id: string) {
  const b = id.startsWith('builtin:') ? BUILTIN_HOOKS.find((h) => `builtin:${h.id}` === id) : undefined
  return b ? b.name() : id
}

/** 「实际走的」那一格：拒绝写是谁拒绝的，其余写这次调用实际在哪执行 */
export function actualRoute(r: CallRecord): string {
  if (r.decision === 'deny') return t('守卫：{name}', { name: r.denyBy ? hookLabel(r.denyBy) : t('拒绝') })
  if (r.kind === 'panel') return t('面板工具')
  // 经面板代理的外部工具（ADR 0085）写出服务和工具：Agent 调的那一格只看得到 more_tools
  if (r.kind === 'mcp' && r.mcp?.proxied)
    return t('面板代理 {server} · {tool}', { server: r.mcp.server, tool: r.mcp.tool })
  if (r.kind === 'mcp') return t('外部 MCP')
  return t('CLI 自带')
}

export const msText = (ms: number | undefined) =>
  ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
