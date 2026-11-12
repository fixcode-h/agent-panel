import { t } from '../i18n.ts'
import type { HookEventName, HooksData } from './defs.ts'

/**
 * 面板自带的钩子（ADR 0049）：可以开关、看说明、改几个参数，不能删、不能改逻辑。开关可以按项目单独设（覆盖全局）。
 * 从 hook-defs.ts 拆出来：第四期加了一批守卫，清单和参数说明放在一起好对照
 */

/** 内置钩子的参数：list 一行一项（命令前缀、路径通配），number 一个数 */
export interface BuiltinParam {
  key: string
  kind: 'list' | 'number'
  label: () => string
  hint: () => string
  default: string[] | number
}

/**
 * 档位（借鉴 ECC 的钩子档位，设计稿 designs/ECC借鉴-配置安全扫描与钩子档位-设计稿.md §2）：
 * 每个内置钩子写「从哪一档开始开」，选档位就是一次把所有内置钩子摆成那一档的样子。
 * 精简只留关掉会出错、会闯祸的；标准再加省 token、提节奏的提醒（就是原来的默认值）；严格全开，适合弱模型、重要项目
 */
export const HOOK_TIERS = ['minimal', 'standard', 'strict'] as const
export type HookTier = (typeof HOOK_TIERS)[number]
export const DEFAULT_TIER: HookTier = 'standard'

export interface BuiltinHook {
  id: string
  event: HookEventName
  name: () => string
  description: () => string
  /** 从哪一档开始开 */
  tier: HookTier
  /** 标准档下开不开（由 tier 推出来，和档位是同一个事实源） */
  defaultOn: boolean
  params?: BuiltinParam[]
}

/** 这一档开不开这个钩子 */
export const tierOn = (tier: HookTier, h: Pick<BuiltinHook, 'tier'>) =>
  HOOK_TIERS.indexOf(h.tier) <= HOOK_TIERS.indexOf(tier)

const extraCommands = (hint: () => string): BuiltinParam => ({
  key: 'extra',
  kind: 'list',
  label: () => t('另外拦下的命令'),
  hint,
  default: [],
})

const DEFS: Omit<BuiltinHook, 'defaultOn'>[] = [
  {
    id: 'keep-going',
    event: 'turn.beforeEnd',
    name: () => t('没做完不收尾'),
    description: () =>
      t(
        '计划没做完、子对话请求收尾还没处理、子对话做完了却没请父对话收尾、没列计划却做了一半就要结束时，在同一轮里拦住让它接着做（Chat 页一问一答不拦）',
      ),
    tier: 'minimal',
  },
  {
    id: 'restore-plan',
    event: 'context.restored',
    name: () => t('压缩后补回计划'),
    description: () => t('压缩上下文之后，把当前计划和进度、派单的目标、在等什么补给模型，免得它忘了做到哪'),
    tier: 'minimal',
  },
  {
    id: 'read-only-guard',
    event: 'tool.before',
    name: () => t('只读身份守卫'),
    description: () =>
      t(
        '调研、评审、排查分析这类只读的角色，以及只统筹不动手的父对话，要改文件时直接拒绝并说明原因；项目 .tmp/ 和系统临时目录里的临时文件放行',
      ),
    tier: 'minimal',
    params: [extraCommands(() => t('只读角色另外不许跑的命令前缀，一行一个，例如 make deploy'))],
  },
  {
    id: 'push-guard',
    event: 'tool.before',
    name: () => t('推送授权守卫'),
    description: () =>
      t(
        '按项目的「推送到远端」设置和这个对话的授权拦 git push、合并 PR：没授权先让它调 ask_push，用户拒绝过、项目不推送、子对话和子任务都直接拒绝并说明原因',
      ),
    tier: 'minimal',
  },
  {
    id: 'bug-diagnosis-guard',
    event: 'tool.before',
    name: () => t('Bug 先诊断守卫'),
    description: () =>
      t('父对话派来的 Bug：诊断报告还没被用户确认就改文件、或者改到确认方案以外的文件时拒绝，免得改完收尾时才被打回'),
    tier: 'minimal',
  },
  {
    id: 'danger-guard',
    event: 'tool.before',
    name: () => t('危险命令守卫'),
    description: () =>
      t(
        '拦下不可挽回的命令：递归删除根目录、家目录、项目、面板数据目录，原分支上 reset --hard / clean / 撤销整个工作区，强推，删主干分支',
      ),
    tier: 'minimal',
    params: [extraCommands(() => t('另外当成危险命令拦下的命令前缀，一行一个，例如 docker system prune'))],
  },
  {
    id: 'long-command-guard',
    event: 'tool.before',
    name: () => t('长命令转后台'),
    description: () =>
      t(
        '完整测试、端到端、界面检查、开发服务器、UE 编译打包、整份装依赖、项目测试步骤里标了合并时编译或超时 3 分钟以上的命令、从项目根起的全项目 grep -r 这类长命令放在前台跑时拒绝，让它交给面板的后台命令：执行中发来的消息不用等它跑完，跑完只推回错误、警告和结尾，完整日志存文件',
      ),
    tier: 'standard',
    params: [
      {
        key: 'extra',
        kind: 'list',
        label: () => t('另外算长命令的命令前缀'),
        hint: () => t('一行一个，例如 npm run build、cargo test'),
        default: [],
      },
    ],
  },
  {
    id: 'big-read-guard',
    event: 'tool.before',
    name: () => t('读大文件前拦一下'),
    description: () =>
      t(
        '整份读超过大小的文本文件（读文件工具不带分段参数，或单独一条 cat / Get-Content）时拒绝一次，让它先搜再按行读、只读结尾，或派子任务去读；同一个文件再读一次就放行',
      ),
    tier: 'standard',
    params: [
      {
        key: 'kb',
        kind: 'number',
        label: () => t('超过多少 KB 算大文件'),
        hint: () => t('默认 64；0 表示不拦'),
        default: 64,
      },
    ],
  },
  {
    id: 'test-scope-guard',
    event: 'tool.before',
    name: () => t('测试步骤归属守卫'),
    description: () => t('项目里设成「合回后由父对话跑」的测试步骤，子对话在独立分支里跑时拒绝'),
    tier: 'minimal',
  },
  {
    id: 'secret-guard',
    event: 'tool.before',
    name: () => t('凭据守卫'),
    description: () =>
      t('往项目文件里写像是真实密钥、令牌、私钥的内容时拒绝，让它改成从环境变量读；本机的 .env 这类文件放行'),
    tier: 'minimal',
    params: [
      {
        key: 'allow',
        kind: 'list',
        label: () => t('可以写凭据的文件'),
        hint: () => t('相对项目根的路径通配，一行一个；.env、.env.* 已经放行'),
        default: [],
      },
    ],
  },
  {
    id: 'worktree-guard',
    event: 'tool.before',
    name: () => t('独立分支越界守卫'),
    description: () => t('子对话在自己的独立分支里，要改分支目录以外的文件（比如原仓库里的）时拒绝'),
    tier: 'minimal',
  },
  {
    id: 'temp-file-guard',
    event: 'tool.before',
    name: () => t('临时文件位置守卫'),
    description: () => t('往盘符根目录、面板的数据目录里写文件时拒绝，说明临时文件该放到项目的 .tmp/ 或系统临时目录'),
    tier: 'strict',
    params: [
      {
        key: 'allow',
        kind: 'list',
        label: () => t('另外允许写的目录'),
        hint: () => t('绝对路径，一行一个'),
        default: [],
      },
    ],
  },
  {
    id: 'read-before-edit',
    event: 'tool.before',
    name: () => t('改之前先看过'),
    description: () =>
      t(
        '要改一个已有的文件，这个对话（压缩之后算起）却没读过、没搜到过它时拦一次，让它先看要改的位置；同一个文件再改一次就放行。改文件工具和 sed -i 都算',
      ),
    tier: 'strict',
  },
  {
    id: 'check-config-guard',
    event: 'tool.before',
    name: () => t('不许改检查配置'),
    description: () =>
      t(
        '要改 lint、格式化、tsconfig、测试框架这类检查配置时拦一次，让它先改代码、别为了通过去放宽检查；确实要改的说明原因后再改一次就放行',
      ),
    tier: 'strict',
    params: [
      {
        key: 'extra',
        kind: 'list',
        label: () => t('另外算检查配置的文件'),
        hint: () => t('相对项目根的路径通配，一行一个，例如 scripts/file-caps.json；不带目录的按文件名匹配'),
        default: [],
      },
    ],
  },
  {
    id: 'loop-hint',
    event: 'tool.after',
    name: () => t('原地打转提醒'),
    description: () =>
      t(
        '同一条命令连续失败几次时，补一句让它换个思路或者说明卡在哪（要 CLI 报得出失败：Claude Code、Pi、Command Code）',
      ),
    tier: 'strict',
    params: [
      {
        key: 'times',
        kind: 'number',
        label: () => t('连续失败几次提醒'),
        hint: () => t('1 到 100，默认 3'),
        default: 3,
      },
    ],
  },
  {
    id: 'big-output-hint',
    event: 'tool.after',
    name: () => t('大输出提醒'),
    description: () =>
      t(
        '一次命令输出、读文件的结果超过字数时补一句：下次先重定向到文件再搜，长命令放后台，大日志派子任务去读（结果已经进了上下文，这句只管下一次；每次调用最多提醒两次）',
      ),
    tier: 'standard',
    params: [
      {
        key: 'chars',
        kind: 'number',
        label: () => t('超过多少字提醒'),
        hint: () => t('默认 20000；0 表示不提醒'),
        default: 20000,
      },
    ],
  },
  {
    id: 'plan-pace',
    event: 'tool.after',
    name: () => t('计划没跟上提醒'),
    description: () =>
      t(
        '项目里的对话改文件、跑命令时，计划没有进行中的步骤，或者进行中的那一步动手多次还没更新，补一句让它先用 set_plan 标完成、标下一步（同一步提醒几次可以设置）',
      ),
    tier: 'standard',
    params: [
      {
        key: 'calls',
        kind: 'number',
        label: () => t('动手几次没更新就提醒'),
        hint: () => t('1 到 100，默认 20；超过 3 分钟没更新时，到三分之一就提醒'),
        default: 20,
      },
      {
        key: 'times',
        kind: 'number',
        label: () => t('同一步最多提醒几次'),
        hint: () => t('1 到 100，默认 1；提醒过后再动手到上面的次数才提醒下一次'),
        default: 1,
      },
    ],
  },
  {
    id: 'verify-before-end',
    event: 'turn.beforeEnd',
    name: () => t('改完没验证'),
    description: () =>
      t('这条消息以来改过文件，之后却一条命令都没跑就要结束时，拦一次让它跑一下检查（或说明为什么不用跑）'),
    tier: 'strict',
  },
  {
    id: 'push-lessons',
    event: 'tool.after',
    name: () => t('改文件后推送教训'),
    description: () => t('第一次改到某个文件时，把项目教训里管这个文件的几条补给模型'),
    tier: 'strict',
  },
]

export const BUILTIN_HOOKS: BuiltinHook[] = DEFS.map((h) => ({ ...h, defaultOn: tierOn(DEFAULT_TIER, h) }))

type OnData = Pick<HooksData, 'builtins' | 'projects'> & Partial<Pick<HooksData, 'tier' | 'projectTiers'>>

/**
 * 开关，按这个顺序取：这个项目单独设的 → 这个项目选的档位 → 全局单独设的 → 全局档位。
 * 项目选了档位就是「这个项目按这一档」，全局逐个改过的不再带进来
 */
export function builtinOn(data: OnData, h: BuiltinHook, projectId = '') {
  const mine = projectId ? data.projects[projectId]?.[h.id] : undefined
  if (mine !== undefined) return mine
  const pt = projectId ? data.projectTiers?.[projectId] : undefined
  if (pt) return tierOn(pt, h)
  return data.builtins[h.id] ?? tierOn(data.tier ?? DEFAULT_TIER, h)
}

/** 不看逐个改过的开关时，这一层按档位该是什么：项目层看项目档位，没选跟全局 */
export function tierDefault(data: OnData, h: BuiltinHook, projectId = '') {
  const pt = projectId ? data.projectTiers?.[projectId] : undefined
  if (pt) return tierOn(pt, h)
  return projectId ? builtinOn(data, h) : tierOn(data.tier ?? DEFAULT_TIER, h)
}

/** 这一层逐个改过、和档位不一样的内置钩子有几个（界面上写「标准（改过 2 个）」） */
export function tierChanged(data: OnData, projectId = '') {
  return BUILTIN_HOOKS.filter((h) => {
    const set = projectId ? data.projects[projectId]?.[h.id] : data.builtins[h.id]
    if (set === undefined) return false
    return set !== (projectId ? tierDefault(data, h, projectId) : tierOn(data.tier ?? DEFAULT_TIER, h))
  }).length
}

/** 参数：设置里改过的，没改过用默认值 */
export function builtinParam(data: Pick<HooksData, 'params'>, h: BuiltinHook, key: string): string[] | number {
  const def = h.params?.find((p) => p.key === key)
  const v = data.params[h.id]?.[key]
  if (!def) return []
  if (def.kind === 'number') return typeof v === 'number' ? v : (def.default as number)
  return Array.isArray(v) ? v : (def.default as string[])
}

export const builtinNumber = (data: Pick<HooksData, 'params'>, id: string, key: string): number => {
  const h = BUILTIN_HOOKS.find((x) => x.id === id)
  const v = h ? builtinParam(data, h, key) : 0
  return typeof v === 'number' ? v : 0
}

export const builtinList = (data: Pick<HooksData, 'params'>, id: string, key: string): string[] => {
  const h = BUILTIN_HOOKS.find((x) => x.id === id)
  const v = h ? builtinParam(data, h, key) : []
  return Array.isArray(v) ? v : []
}
