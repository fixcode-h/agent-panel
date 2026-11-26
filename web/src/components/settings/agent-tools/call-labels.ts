/**
 * 调用记录里各种值的叫法：决定、调用类别、命令类别、钩子来源。写成函数：t() 要在切换界面语言之后再取
 */
import { t } from '@shared/i18n'
import { BUILTIN_HOOKS } from '@shared/hooks/builtins'
import { CAPABILITIES } from '@shared/capability-router/capabilities'
import type { CallKind, CallRecord, CommandCategory, GatewayDecision } from '@shared/tool-gateway/types'
import type { VerifyOutcome, VerifyRun } from '@shared/tool-gateway/verify/types'
import { routeText } from '@/components/ui/route-badge'

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

/** 校验结论的颜色：通过绿、报错和没通过红、超时和没跑起来黄（检查本身出了问题） */
export const VERIFY_TONE: Record<VerifyOutcome, Tone> = {
  ok: 'success',
  errors: 'danger',
  failed: 'danger',
  timeout: 'warning',
  spawn: 'warning',
}

/** 面板替 Agent 跑的校验（ADR 0086）：「校验 · lua-check · 1 处报错 / 通过 / 超时 / 没跑起来」 */
export function verifyLabel(v: VerifyRun): string {
  const result = {
    ok: () => t('通过'),
    errors: () => t('{n} 处报错', { n: v.errors }),
    failed: () => t('没通过'),
    timeout: () => t('超时'),
    spawn: () => t('没跑起来'),
  }[v.outcome]()
  return t('校验 · {tool} · {result}', { tool: v.tool, result })
}

/** 「实际走的」那一格：拒绝写是谁拒绝的，改道的写改走了哪个能力、哪几条路，其余写这次调用实际在哪执行 */
export function actualRoute(r: CallRecord): string {
  if (r.verify?.trigger === 'auto') return t('面板自己跑（改完自动校验）')
  if (r.decision === 'serve' && r.wouldRoute) return t('面板改用 {to} 代答', { to: r.wouldRoute.to })
  if (r.decision === 'redirect' && r.wouldRoute) return t('没执行，让 Agent 改用 {to}', { to: r.wouldRoute.to })
  if (r.decision === 'deny') return t('守卫：{name}', { name: r.denyBy ? hookLabel(r.denyBy) : t('拒绝') })
  if ((r.decision === 'rewrite' || r.decision === 'serve') && r.route)
    return t('面板改走 {cap} · {via}', { cap: r.route.capability, via: routeText(r.route) })
  if (r.kind === 'panel') return t('面板工具')
  // 经面板代理的外部工具（ADR 0085）写出服务和工具：Agent 调的那一格只看得到 more_tools
  if (r.kind === 'mcp' && r.mcp?.proxied)
    return t('面板代理 {server} · {tool}', { server: r.mcp.server, tool: r.mcp.tool })
  if (r.kind === 'mcp') return t('外部 MCP')
  return t('CLI 自带')
}

export const msText = (ms: number | undefined) =>
  ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
