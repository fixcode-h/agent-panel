import { t } from './i18n.ts'
import type { HookEventName, HooksData } from './hook-defs.ts'

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

export interface BuiltinHook {
  id: string
  event: HookEventName
  name: () => string
  description: () => string
  defaultOn: boolean
  params?: BuiltinParam[]
}

const extraCommands = (hint: () => string): BuiltinParam => ({
  key: 'extra',
  kind: 'list',
  label: () => t('另外拦下的命令'),
  hint,
  default: [],
})

export const BUILTIN_HOOKS: BuiltinHook[] = [
  {
    id: 'keep-going',
    event: 'turn.beforeEnd',
    name: () => t('没做完不收尾'),
    description: () =>
      t(
        '计划没做完、子对话请求收尾还没处理、子对话做完了却没请父对话收尾、没列计划却做了一半就要结束时，在同一轮里拦住让它接着做（Chat 页一问一答不拦）',
      ),
    defaultOn: true,
  },
  {
    id: 'restore-plan',
    event: 'context.restored',
    name: () => t('压缩后补回计划'),
    description: () => t('压缩上下文之后，把当前计划和进度、派单的目标、在等什么补给模型，免得它忘了做到哪'),
    defaultOn: true,
  },
  {
    id: 'read-only-guard',
    event: 'tool.before',
    name: () => t('只读身份守卫'),
    description: () => t('调研、评审、排查分析这类只读的角色，以及只统筹不动手的父对话，要改文件时直接拒绝并说明原因'),
    defaultOn: true,
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
    defaultOn: true,
  },
  {
    id: 'bug-diagnosis-guard',
    event: 'tool.before',
    name: () => t('Bug 先诊断守卫'),
    description: () =>
      t('父对话派来的 Bug：诊断报告还没被用户确认就改文件、或者改到确认方案以外的文件时拒绝，免得改完收尾时才被打回'),
    defaultOn: true,
  },
  {
    id: 'danger-guard',
    event: 'tool.before',
    name: () => t('危险命令守卫'),
    description: () =>
      t(
        '拦下不可挽回的命令：递归删除根目录、家目录、项目、面板数据目录，原分支上 reset --hard / clean / 撤销整个工作区，强推，删主干分支',
      ),
    defaultOn: true,
    params: [extraCommands(() => t('另外当成危险命令拦下的命令前缀，一行一个，例如 docker system prune'))],
  },
  {
    id: 'long-command-guard',
    event: 'tool.before',
    name: () => t('长命令转后台'),
    description: () =>
      t(
        '完整测试、端到端、界面检查、开发服务器这类长命令放在前台跑时拒绝，让它交给面板的后台命令，执行中发来的消息不用等它跑完',
      ),
    defaultOn: true,
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
    id: 'test-scope-guard',
    event: 'tool.before',
    name: () => t('测试步骤归属守卫'),
    description: () => t('项目里设成「合回后由父对话跑」的测试步骤，子对话在独立分支里跑时拒绝'),
    defaultOn: true,
  },
  {
    id: 'secret-guard',
    event: 'tool.before',
    name: () => t('凭据守卫'),
    description: () =>
      t('往项目文件里写像是真实密钥、令牌、私钥的内容时拒绝，让它改成从环境变量读；本机的 .env 这类文件放行'),
    defaultOn: true,
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
    defaultOn: true,
  },
  {
    id: 'temp-file-guard',
    event: 'tool.before',
    name: () => t('临时文件位置守卫'),
    description: () => t('往盘符根目录、面板的数据目录里写文件时拒绝，说明临时文件该放到项目的 .tmp/ 或系统临时目录'),
    defaultOn: false,
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
    id: 'push-lessons',
    event: 'tool.after',
    name: () => t('改文件后推送教训'),
    description: () => t('第一次改到某个文件时，把项目教训里管这个文件的几条补给模型'),
    defaultOn: false,
  },
]

/** 开关：这个项目单独设过的优先，其次全局（只记改过默认值的），都没有用默认值 */
export const builtinOn = (data: Pick<HooksData, 'builtins' | 'projects'>, h: BuiltinHook, projectId = '') =>
  (projectId ? data.projects[projectId]?.[h.id] : undefined) ?? data.builtins[h.id] ?? h.defaultOn

/** 参数：设置里改过的，没改过用默认值 */
export function builtinParam(data: Pick<HooksData, 'params'>, h: BuiltinHook, key: string): string[] | number {
  const def = h.params?.find((p) => p.key === key)
  const v = data.params[h.id]?.[key]
  if (!def) return []
  if (def.kind === 'number') return typeof v === 'number' ? v : (def.default as number)
  return Array.isArray(v) ? v : (def.default as string[])
}

export const builtinList = (data: Pick<HooksData, 'params'>, id: string, key: string): string[] => {
  const h = BUILTIN_HOOKS.find((x) => x.id === id)
  const v = h ? builtinParam(data, h, key) : []
  return Array.isArray(v) ? v : []
}
