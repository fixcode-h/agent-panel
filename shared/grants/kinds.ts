import { t } from '../i18n.ts'
import { BUILTIN_HOOKS } from '../hooks/builtins.ts'
import { REVIEW_GATE } from '../hooks/override.ts'

/**
 * 授权类型注册表（用户 2026-11-24：所有授权卡统一加「本对话不再询问」，按类型记，同一个对话里同一类放行过就不再问）。
 *
 * 卡片上的「同一类」就是请求带的规则键（TaskRequest.rule，记进 task.allowRules），键的前缀决定它是哪一种授权：
 * - command: / file: / tool:：CLI 的权限请求（shared/allow-rules.ts 生成）；
 * - plugin:<插件 id>:<键>：插件工具的确认（插件接口 17，server/exec/plugin-confirm.ts）；
 * - gate:<门禁>：门禁拦下后请用户放行（request_override，ADR 0070，server/hooks/overrides.ts）；
 * - ctool:<范围>:<id>：运行自建工具（ADR 0082，server/custom-tools/agent.ts）。
 * 推送授权卡（ask_push）本来就是「这个对话里只问一次」，不走规则键，只在设置里列出来说明。
 *
 * 这里只管「某一类卡上给不给『本对话不再询问』」：设置 →「授权卡」里能逐类开关（settings.grantRemember 记和默认不同的），
 * 默认按 remember。关掉只影响之后弹出的卡，已经放行过的对话照旧（对话里记着放行记录）。
 * 新加一种授权：规则键用一个新前缀，在 BASE 里加一条；门禁类的从内置钩子清单自动列出，不用另登记
 */

export interface GrantKind {
  /** 设置里按它记开关：command、file、tool、plugin、push、gate:<门禁 id>、gate:hook */
  id: string
  /** 分组：CLI 权限、插件、门禁放行、其他 */
  group: 'cli' | 'plugin' | 'gate' | 'other'
  name: () => string
  /** 「同一类」怎么算，设置里显示 */
  scope: () => string
  /** 默认给不给「本对话不再询问」 */
  remember: boolean
  /** 不能在设置里改（写原因）：推送授权卡本来就记住回答 */
  fixed?: () => string
  /**
   * 工作流能不能在定义里自带这一类授权（WorkflowFields.grants，用户 2026-11-25）：插件自己定的一类操作可以，
   * CLI 的命令、改文件和门禁放行不行（那些要用户在对话里当场看）
   */
  presettable?: boolean
}

/** 门禁放行的规则键 */
export const gateRule = (gate: string) => (gate.trim() ? `gate:${gate.trim()}` : '')

/**
 * 默认不给「本对话不再询问」的门禁：拦的是删库、泄露凭据这类一次就收不回的事，每次都该让人看一眼。
 * 用户在设置里可以打开（用户的指令优先，ADR 0070）
 */
const RISKY_GATES = new Set(['danger-guard', 'secret-guard']) // 模块状态：常量，加载后不改

const BASE: GrantKind[] = [
  {
    id: 'command',
    group: 'cli',
    name: () => t('运行命令'),
    scope: () => t('同一个程序（git、npm 这类带上子命令）；删除、提权和带管道、串联的命令每次都问'),
    remember: true,
  },
  {
    id: 'file',
    group: 'cli',
    name: () => t('改文件'),
    scope: () => t('同一个目录（含子目录）里的文件'),
    remember: true,
  },
  { id: 'tool', group: 'cli', name: () => t('使用工具'), scope: () => t('同一个工具'), remember: true },
  {
    id: 'plugin',
    group: 'plugin',
    name: () => t('插件操作'),
    scope: () => t('插件自己定的一类（例如同一篇文档、同一种资源操作）；插件没给的每次都问'),
    remember: true,
    presettable: true,
  },
  {
    id: 'ctool',
    group: 'other',
    name: () => t('自建工具'),
    scope: () =>
      t('同一个工具（项目的和全局的分开算）；默认不弹卡，只有设了「运行前先问我」的工具和还没保存的草稿试跑才问'),
    remember: true,
    presettable: true,
  },
  {
    id: 'push',
    group: 'other',
    name: () => t('推送到远端'),
    scope: () => t('整个对话'),
    remember: true,
    fixed: () => t('推送授权卡本来就只问一次，回答会记住'),
  },
]

/** 门禁类：能拦下操作的内置钩子（工具前守卫、收尾前检查），加上用户自己的钩子和评审门禁 */
function gateKinds(): GrantKind[] {
  const hooks = BUILTIN_HOOKS.filter((h) => h.event === 'tool.before' || h.event === 'turn.beforeEnd').map(
    (h): GrantKind => ({
      id: `gate:${h.id}`,
      group: 'gate',
      name: h.name,
      scope: () => t('这个门禁拦下的所有操作'),
      remember: !RISKY_GATES.has(h.id),
    }),
  )
  return [
    ...hooks,
    {
      id: 'gate:hook',
      group: 'gate',
      name: () => t('我的钩子'),
      scope: () => t('同一个钩子拦下的所有操作'),
      remember: true,
    },
    {
      id: `gate:${REVIEW_GATE}`,
      group: 'gate',
      name: () => t('评审门禁'),
      scope: () => t('子对话收尾时的评审要求'),
      remember: true,
    },
  ]
}

/** 设置页列出的全部授权类型（按分组顺序） */
export const grantKinds = (): GrantKind[] => [...BASE, ...gateKinds()]

/** 规则键是哪一类授权：用户钩子的门禁（gate:hook:<名>）合成一类 */
export function grantKindOf(rule: string): string {
  const [kind, ...rest] = rule.split(':')
  if (kind !== 'gate') return kind
  return rest[0] === 'hook' ? 'gate:hook' : `gate:${rest.join(':')}`
}

/** 这条规则的卡上给不给「本对话不再询问」：设置里改过的按设置，没改过按注册表的默认，不认识的类型给 */
export function rememberOn(rule: string | undefined, prefs: Readonly<Record<string, boolean>> | undefined): boolean {
  if (!rule) return false
  const id = grantKindOf(rule)
  const set = prefs?.[id]
  if (set !== undefined) return set
  return grantKinds().find((k) => k.id === id)?.remember ?? true
}

/** 工作流能不能自带这条授权 */
export const canPreset = (rule: string) => !!grantKinds().find((k) => k.id === grantKindOf(rule))?.presettable
