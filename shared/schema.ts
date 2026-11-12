import { LearnedNote } from './experience.ts'
import { Submitted } from './submitted.ts'
import { z } from 'zod'
import { FirstTokenStats } from './first-token-stats.ts'
import { t } from './i18n.ts'
import { ProjectCliTrust } from './cli/trust.ts'
import { EndTurnRecord } from './turn-end.ts'
import { ConvBudget, TaskRuntimeFields } from './tasks/runtime-schema.ts'
import { RolePlugins } from './role-plugins.ts'
import { ModelOverride } from './tasks/run.ts'
import { ContextParts, ContextSnapshot } from './context-breakdown.ts'
import type { ProjectProposal } from './projects/init.ts'
import { AskQuestion, TaskRequest } from './tasks/request.ts'
import { UserAction } from './user-action.ts'
import { FlowRun, WorkflowKind } from './tasks/flow-schema.ts'
import { StopReason } from './stop-reason.ts'
import { TaskBug } from './bug/task-bug.ts'
import { WrapRequest } from './wrap-request-schema.ts'
import { BuildAsk } from './build-ask.ts'
import { PanelKind } from './panel-kind.ts'
import { PlanItem, PlanStatus, PlanStep, PlanWait, TaskPlan } from './plan/schema.ts'
import { FileFormat } from './settings-schema.ts'

/** 全局设置（含文件格式、外观、CLI 设置）拆在 settings-schema.ts，进程面板的结构拆在 process-schema.ts：从这里原样转出，引用处不用改 */
export * from './settings-schema.ts'
export * from './process-schema.ts'

/** 参数的值：单选、文本是字符串，多选是字符串数组，开关是布尔，数字是数字 */
export const ParamValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(30)])
export type ParamValue = z.infer<typeof ParamValue>
export type ParamValues = Record<string, ParamValue>

/**
 * 参数的显示条件：前面某个参数取这些值时才成立。
 * values 为空表示「有值」（开关打开、多选选了、文本不空）；not 取反（不是这些值 / 没有值）。
 * 开关的取值写 'true' / 'false'。
 */
export const ParamCond = z.object({
  key: z.string().trim().min(1).max(40),
  values: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  not: z.boolean().default(false),
})
export type ParamCond = z.infer<typeof ParamCond>

/**
 * Agent 向外暴露的参数：角色设定里用 {{key}} 引用、用 {{#if key=值}}…{{/if}} 分支，
 * 同一个 Agent 换个参数就能走不同的做法。对话时用默认值，没有默认值（ask）的先问用户；
 * 工作流节点上可以直接改。
 */
export const AgentParam = z.object({
  key: z
    .string()
    .trim()
    .min(1, t('参数名不能为空'))
    .max(40)
    .regex(/^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*$/, t('参数名只能用字母、数字、下划线、横线和中文')),
  /** 显示的名字；为空显示 key */
  label: z.string().trim().max(40).default(''),
  /** select 单选下拉；multi 多选；bool 开关；text 文本；number 数字 */
  type: z.enum(['select', 'multi', 'bool', 'text', 'number']).default('select'),
  /** 单选、多选的选项 */
  options: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  default: ParamValue.optional(),
  /** 没有默认值：对话开始前问用户选，工作流节点上必须填 */
  ask: z.boolean().default(false),
  description: z.string().trim().max(200).default(''),
  /** 只在前面的参数满足条件时显示和生效；不满足时这个参数不用问、按空值处理 */
  when: ParamCond.optional(),
  /**
   * 选项跟着前面的参数变：前面那个参数取 map 里的某个值时，只能选对应的这些选项。
   * map 里没列的取值不限制；某个取值对应空数组表示这时这个参数不适用（同 when 不满足）。
   */
  optionsBy: z
    .object({
      key: z.string().trim().min(1).max(40),
      map: z.record(z.string().max(60), z.array(z.string().trim().min(1).max(60)).max(30)),
    })
    .optional(),
})
export type AgentParam = z.infer<typeof AgentParam>

/**
 * 高级角色挂载的一个能力（基本角色）。mode 是这个能力在这个高级角色里怎么用：
 * auto 由高级角色按 rule 和通用判据自己选；inline 就地（use_capability 加载说明自己做）；
 * subtask 派成子任务；parent 子对话里点名时转交父对话创建（同 runIn: parent）。
 * mode 不能超出基本角色自己允许的用法（modes / independent），超出时按 mountMode 收紧。
 */
export const AgentMount = z.object({
  agentId: z.string().min(1),
  mode: z.enum(['auto', 'inline', 'subtask', 'parent']).catch('auto').default('auto'),
  /** 就地用时把全文直接放进提示词（常用的主能力），免得每次都要 use_capability */
  preload: z.boolean().default(false),
  /** auto 时补一句「什么时候就地、什么时候派出」，进能力索引 */
  rule: z.string().trim().max(300).default(''),
  /** 挂载时给这个能力定的参数取值（对话、节点上选的和项目里的取值仍然优先） */
  params: z.record(z.string(), ParamValue).default({}),
})
export type AgentMount = z.infer<typeof AgentMount>

/**
 * Agent：一个可复用的「CLI + 模型 + 角色设定」组合。
 * 主 / 子 Agent 不在这里区分，而是在工作流里指定。
 */
export const AgentInput = z.object({
  name: z.string().trim().min(1, t('名称不能为空')).max(40),
  description: z.string().trim().max(200).default(''),
  /** 为空表示使用设置里的默认 CLI */
  cli: z.string().default(''),
  /** 具体模型名；@high / @medium / @low 表示档位；为空用 CLI 的默认模型 */
  model: z.string().trim().default(''),
  /** 思考强度；为空时跟随档位或 CLI 的默认设置 */
  effort: z.string().trim().default(''),
  /** 所属分类；为空表示未分类 */
  categoryId: z.string().default(''),
  /** 卡片上显示的图标，可选值见 web/src/lib/agent-icons.ts */
  icon: z.string().default('bot'),
  /** 角色设定 / 系统提示词（Markdown），执行时会拼在任务前面；可以用 {{参数}} 和条件分支 */
  instructions: z.string().max(50000).default(''),
  /** 引入的其他 Agent：它们的角色设定一起交给这个 Agent（按引入顺序，循环引用会跳过） */
  includes: z.array(z.string()).max(20).default([]),
  /** 向外暴露的参数 */
  params: z.array(AgentParam).max(30).default([]),
  /** 要用的 Skill（名字）：执行时提示 Agent 优先用这些 Skill */
  skills: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** 常用的开场要求：对话输入框上方显示成快捷按钮 */
  starters: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  /** 全局标签的 id */
  tags: z.array(z.string()).max(20).default([]),
  /** 权限模式，取值见 shared/clis.ts 里各 CLI 的 permissions；为空跟随 CLI 设置 */
  permission: z.string().default(''),
  /** 追加给 CLI 的参数，例如 --add-dir ../shared */
  extraArgs: z.array(z.string()).default([]),
  /** 这个角色执行时额外加载的 CLI 插件来源（见 shared/role-plugins.ts） */
  plugins: RolePlugins,
  enabled: z.boolean().default(true),
  /** 通用 Agent：工作流里任何 Agent 执行时都可以把子任务派给它（编排工具 spawn_agents 里列出来） */
  common: z.boolean().default(false),
  /** 可以创建子对话、把用户消息分派给子对话（只有项目顶层对话里生效，子对话不能再分派） */
  canDelegate: z.boolean().default(false),
  /** 可以启动工作流（start_workflow，ADR 0044）：只对项目里能分派子对话的父对话生效，子对话一律不能 */
  canPlan: z.boolean().default(false),
  /**
   * 在哪类对话里能启动：any 任意对话（默认）；parent 只在父对话里执行。
   * 子对话点名 parent 的角色时不在这里跑，而是转交父对话创建这个子任务（见 ADR 0019）。
   * catch：旧数据没有这个字段时按 any 读，不能因为加字段读不进来。
   */
  runIn: z.enum(['any', 'parent']).catch('any').default('any'),
  /**
   * 角色的层：basic 基本角色（专注一个能力，派成子任务、当工作流节点、被高级角色挂载）；
   * advanced 高级角色（父对话、子对话的负责人：挂载若干基本角色，自己决定就地做还是派出）。
   * 旧数据没有这个字段：按 roleKind（shared/agents/role.ts）从能力开关和挂载推导，不迁移
   */
  kind: z.enum(['basic', 'advanced']).optional().catch(undefined),
  /**
   * 用在哪种对话：agent 项目里的对话、子对话、工作流节点、子任务；chat 只在 Chat 页（没有项目的顶层对话）。
   * 建好不能改（换类别就复制一份）；没写（旧数据）按 agent 算，用 scopeOf 读（ADR 0038）
   */
  scope: z.enum(['agent', 'chat']).optional().catch(undefined),
  /** 基本角色：一句话说明什么时候该用它（进高级角色的能力索引，模型据此决定调不调） */
  when: z.string().trim().max(200).default(''),
  /** 基本角色允许的用法：inline 就地（use_capability 加载进当前对话）、subtask 派成子任务 */
  modes: z
    .array(z.enum(['inline', 'subtask']))
    .max(2)
    .catch(['inline', 'subtask'])
    .default(['inline', 'subtask']),
  /** 必须在独立上下文里做（评审）：不能就地用，只能派出 */
  independent: z.boolean().default(false),
  /** 高级角色挂载的基本角色（见 AgentMount），按顺序列进能力索引 */
  mounts: z.array(AgentMount).max(16).default([]),
  /**
   * 内置高级角色的挂载由用户接管：挂哪些、说明、预加载都按用户的，启动同步不再按内置定义改写（用户 2026-10-29 定的）。
   * 没接管（undefined / false）时挂载跟内置定义走，只保留用户改过的用法和参数取值；「恢复默认挂载」就是清掉它
   */
  mountsCustom: z.boolean().optional(),
  /**
   * 父对话就地微改动：off 不改文件（只分诊、派单）；tiny 允许过了 begin_inline_edit 护栏的微小改动。
   * 只对项目里的顶层对话生效（见 shared/inline-edit.ts）
   */
  inlineEdit: z.enum(['off', 'tiny']).catch('off').default('off'),
  /** 用户是否确认过能力开关：升级时为旧内置 Agent 补一次默认能力，之后不再覆盖用户的选择 */
  capsSet: z.boolean().default(false),
  /** 已经做过的一次性升级（见 shared/builtin/core.ts 的 DEFAULT_CHANGES）：做过的不再做，用户之后改回去的值不会被覆盖 */
  upgrades: z.array(z.string().max(80)).max(50).optional(),
  /** 从内置模板建出来的 Agent 记下来源（builtin:<key>），再次添加内置工作流时复用，不重复建 */
  origin: z.string().max(80).default(''),
})
export type AgentInput = z.infer<typeof AgentInput>

/** 角色分层字段的默认值：新建角色、AI 起草角色、复制内置角色时补齐（kind 不写，按 roleKind 推导） */
export const roleLayerDefaults = (): Pick<AgentInput, 'when' | 'modes' | 'independent' | 'mounts' | 'inlineEdit'> => ({
  when: '',
  modes: ['inline', 'subtask'],
  independent: false,
  mounts: [],
  inlineEdit: 'off',
})

const Meta = z.object({ id: z.string(), createdAt: z.string(), updatedAt: z.string() })

export const Agent = AgentInput.extend(Meta.shape)
export type Agent = z.infer<typeof Agent>

/**
 * 以前自带的「默认 Agent」的 id。它其实就是「不带角色、直接用 CLI」，现在去掉了：
 * 旧数据里引用它的地方读出来一律当成空字符串（不用角色），见 dropLegacyAgent。
 */
export const LEGACY_DEFAULT_AGENT_ID = 'default-agent'

/** 不用角色时的运行配置模板：CLI、模型、思考强度跟随默认 CLI，没有角色设定 */
export const defaultAgent = (): Agent => {
  const at = new Date(0).toISOString()
  return {
    ...AgentInput.parse({ name: t('无角色'), icon: 'sparkles' }),
    id: '',
    createdAt: at,
    updatedAt: at,
  }
}

const AGENT_REF_KEYS = new Set(['agentId', 'mainAgentId', 'defaultAgentId']) // 模块状态：常量，加载后不改

/**
 * 已经不存在的角色 id → 现在该用的 id（空字符串表示不用角色）。读旧数据时按它改写引用：
 * 默认 Agent 固定在这里；合并后被删掉的内置副本由服务端启动时登记（见 setAgentAliases）。
 */
const agentAliases = new Map<string, string>([[LEGACY_DEFAULT_AGENT_ID, '']]) // 模块状态：配置副本，重启时重读

/** 登记被删掉的角色该转到哪个角色：之后读到的工作流、项目、对话里的引用都会改过去 */
export function setAgentAliases(map: Record<string, string>) {
  for (const [from, to] of Object.entries(map)) if (from && from !== to) agentAliases.set(from, to)
}

/** 这个角色 id 现在该用哪个（没登记过的原样返回） */
export const aliasAgent = (id: string) => agentAliases.get(id) ?? id

/** 旧数据里指向已去掉的角色的引用改成现在的（默认 Agent 改成空字符串，不用角色）；工作流成员里转成空的直接去掉 */
function dropLegacyAgent(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(dropLegacyAgent)
    return arr.some((x, i) => x !== v[i]) ? arr : v
  }
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [k, x] of Object.entries(o)) {
    let next = x
    if (AGENT_REF_KEYS.has(k) && typeof x === 'string' && agentAliases.has(x)) next = agentAliases.get(x)
    else if (k === 'members' && Array.isArray(x))
      next = dropLegacyAgent(
        x.filter((m) => {
          const id = (m as { agentId?: unknown })?.agentId
          return typeof id !== 'string' || agentAliases.get(id) !== ''
        }),
      )
    else if (x && typeof x === 'object') next = dropLegacyAgent(x)
    if (next !== x) (out ??= { ...o })[k] = next
  }
  return out ?? o
}

/** 对话的 CLI 会话按角色 id 记：角色换了 id，会话跟着搬过去，接着原来的会话聊 */
function moveSessions(v: unknown) {
  const t = v as { sessions?: unknown }
  if (!t?.sessions || typeof t.sessions !== 'object') return v
  const cur = t.sessions as Record<string, unknown>
  if (!Object.keys(cur).some((k) => agentAliases.has(k))) return v
  const sessions: Record<string, unknown> = {}
  for (const [k, id] of Object.entries(cur)) {
    const to = aliasAgent(k)
    if (!(to in sessions) || to === k) sessions[to] = id
  }
  return { ...t, sessions }
}

/** Agent 和工作流的分类，例如「开发」「测试」「文档」，只用于组织列表；两边的分类各管各的 */
export const CategoryInput = z.object({
  name: z.string().trim().min(1, t('分类名不能为空')).max(20),
  scope: z.enum(['agent', 'workflow']).default('agent'),
})
export type CategoryInput = z.infer<typeof CategoryInput>

export const Category = CategoryInput.extend(Meta.shape)
export type Category = z.infer<typeof Category>

/** 全局标签：Agent 和工作流共用，在设置里管理 */
export const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const
export const TagInput = z.object({
  name: z.string().trim().min(1, t('标签名不能为空')).max(20),
  color: z.enum(TAG_COLORS).default('gray'),
  description: z.string().trim().max(200).default(''),
})
export type TagInput = z.infer<typeof TagInput>

export const Tag = TagInput.extend(Meta.shape)
export type Tag = z.infer<typeof Tag>

/** 工作流节点用的模型档位：只能是默认 CLI 的高 / 中 / 低三档，思考强度也用档位的 */
export const NodeTier = z.enum(['', 'high', 'medium', 'low'])
export type NodeTier = z.infer<typeof NodeTier>

/** 工作流里的一个子 Agent，以及它在这个工作流中负责的内容 */
export const WorkflowMember = z.object({
  agentId: z.string(),
  responsibility: z.string().trim().max(200).default(''),
})
export type WorkflowMember = z.infer<typeof WorkflowMember>

/**
 * 引用一个流程：sub 是同一工作流里的另一个流程（按 id），workflow 是另一个工作流（执行它的主流程）。
 * 节点的开始 / 验收 / 结束入口和「流程节点」都用它。
 */
export const FlowRef = z.object({
  kind: z.enum(['sub', 'workflow']),
  id: z.string().min(1),
})
export type FlowRef = z.infer<typeof FlowRef>

/** 节点上可以挂的三个流程入口 */
export const NodeHooks = z.object({
  /** 开始前执行，结果作为这个节点的初始资料 */
  start: FlowRef.nullable().default(null),
  /** 节点完成后执行验收；不通过就把意见交回节点继续完善 */
  review: FlowRef.nullable().default(null),
  /** 验收通过后执行，结果并入这个节点的输出 */
  end: FlowRef.nullable().default(null),
  /** 验收最多几轮，超过仍不通过时节点失败 */
  maxRounds: z.number().int().min(1).max(10).default(3),
  /** 完成后等用户确认：用户看过结果点「通过」才往下走，退回时带着意见让节点继续完善 */
  confirm: z.boolean().optional(),
})
export type NodeHooks = z.infer<typeof NodeHooks>

/**
 * 节点里的一个执行步骤：按顺序串行执行，每一步一条执行记录、一个独立的 CLI 会话。
 * 旧的单执行者节点没有 steps，读取时用 nodeSteps() 合成一步。
 */
export const NodeStep = z.object({
  /** 稳定 id：新步骤是 st_xxx；旧节点合成的一步用节点 id，保证旧会话键不变 */
  id: z.string().min(1).max(40),
  /** 显示名；为空时用 Agent 或流程的名字 */
  title: z.string().trim().max(60).default(''),
  /** agent：由 Agent 执行；flow：执行引用的流程 */
  kind: z.enum(['agent', 'flow']).default('agent'),
  agentId: z.string().default(''),
  flow: FlowRef.nullable().default(null),
  tier: NodeTier.default(''),
  params: z.record(z.string(), ParamValue).default({}),
  instructions: z.string().max(20000).default(''),
  /** 失败后自动重试几次（CLI 断线、偶发错误）；0 不重试 */
  retries: z.number().int().min(0).max(5).default(0),
  /** 这一步完成后等用户确认 */
  confirm: z.boolean().optional(),
  /** 这一步完成后执行验收；不通过就把意见交回这一步继续完善 */
  review: FlowRef.nullable().default(null),
  /** 验收最多几轮，超过仍不通过时整个节点失败 */
  maxRounds: z.number().int().min(1).max(10).default(3),
})
export type NodeStep = z.infer<typeof NodeStep>

/** 流程里的一个节点：交给某个 Agent 完成的一件事，或者执行另一个流程 */
export const FlowNode = z.object({
  id: z.string().min(1),
  title: z.string().trim().max(60).default(''),
  /** agent：由 Agent 执行；flow：执行引用的流程 */
  kind: z.enum(['agent', 'flow']).default('agent'),
  /** 执行的 Agent；为空表示由主 Agent 执行 */
  agentId: z.string().default(''),
  /** kind 为 flow 时执行的流程 */
  flow: FlowRef.nullable().default(null),
  /** 用默认 CLI 的哪一档模型；为空时按 Agent 设的档位（Agent 不是档位时用中档） */
  tier: NodeTier.default(''),
  /** Agent 参数在这个节点上的值；没写的用 Agent 的默认值 */
  params: z.record(z.string(), ParamValue).default({}),
  /** 失败后自动重试几次（CLI 断线、偶发错误）；0 不重试 */
  retries: z.number().int().min(0).max(5).default(0),
  /** 这个节点要做什么、产出什么（Markdown） */
  instructions: z.string().max(20000).default(''),
  /** 按顺序执行的步骤；为空表示旧的单执行者节点 */
  steps: z.array(NodeStep).max(20).default([]),
  x: z.number().default(0),
  y: z.number().default(0),
  hooks: NodeHooks.default({ start: null, review: null, end: null, maxRounds: 3 }),
})
export type FlowNode = z.infer<typeof FlowNode>

/**
 * 连线：from 执行完才会执行 to；START / END 表示流程的开始和结束。
 * when 是条件：pass / fail 时只在 from 的结论是「通过」/「不通过」时走这条线，没走的分支整段跳过
 */
export const FlowEdge = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.enum(['', 'pass', 'fail']).optional(),
})
export type FlowEdge = z.infer<typeof FlowEdge>

export const START = 'start'
export const END = 'end'

/**
 * 流程：节点和连线组成的有向图，自由摆放。从「开始」出发，一个节点的上游全部完成后才执行它，
 * 没有依赖关系的节点同时执行。一个工作流可以有多个流程，其中一个是主流程（任务从这里开始），
 * 其余是子流程，供节点的开始 / 验收 / 结束入口或流程节点调用。
 */
export const Flow = z.object({
  id: z.string().min(1),
  name: z.string().trim().max(40).default(''),
  description: z.string().trim().max(200).default(''),
  nodes: z.array(FlowNode).max(100).default([]),
  edges: z.array(FlowEdge).max(400).default([]),
  /** 开始、结束两个端点在画布上的位置 */
  startPos: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  endPos: z.object({ x: z.number(), y: z.number() }).default({ x: 600, y: 0 }),
})
export type Flow = z.infer<typeof Flow>

const rid = () => Math.random().toString(36).slice(2, 10)

/**
 * 旧版的「阶段」流程（阶段依次执行、阶段内并行）转换成连线：
 * 每个阶段的节点连到下一阶段的所有节点，位置按阶段排成列。
 */
export function stagesToFlow(stages: { title?: string; nodes?: Record<string, unknown>[] }[]) {
  const cols = stages.filter((s) => s.nodes?.length)
  const nodes: Record<string, unknown>[] = []
  const edges: { id: string; from: string; to: string }[] = []
  let prev: string[] = [START]
  const COL = 300
  const ROW = 150
  cols.forEach((c, ci) => {
    const ids: string[] = []
    c.nodes!.forEach((n, ni) => {
      const id = String(n.id ?? `nd_${rid()}`)
      ids.push(id)
      nodes.push({
        ...n,
        id,
        x: 240 + ci * COL,
        y: (ni - (c.nodes!.length - 1) / 2) * ROW,
      })
      for (const p of prev) edges.push({ id: `e_${rid()}`, from: p, to: id })
    })
    prev = ids
  })
  for (const p of prev) if (p !== START || !cols.length) edges.push({ id: `e_${rid()}`, from: p, to: END })
  return {
    id: 'main',
    name: t('主流程'),
    nodes,
    edges: cols.length ? edges : [],
    startPos: { x: 0, y: 0 },
    endPos: { x: 240 + cols.length * COL, y: 0 },
    description: '',
  }
}

/** 读旧数据时把阶段转换成流程 */
function migrateWorkflow(raw: unknown) {
  const v = dropLegacyAgent(raw)
  if (!v || typeof v !== 'object') return v
  const w = v as Record<string, unknown>
  if (Array.isArray(w.flows) && w.flows.length) return w
  const stages = Array.isArray(w.stages) ? (w.stages as { nodes?: Record<string, unknown>[] }[]) : []
  const { stages: _, ...rest } = w
  return { ...rest, flows: [stagesToFlow(stages)], entryFlowId: 'main' }
}

/**
 * 工作流对外暴露的配置项：项目设置里按它渲染表单，值存在项目的 workflowParams 里。
 * target 决定值作用到哪里，新建对话时解析成快照写进任务，之后改工作流不影响已开始的对话。
 */
export const WorkflowExpose = z.object({
  key: z
    .string()
    .trim()
    .min(1, t('配置项名不能为空'))
    .max(40)
    .regex(/^[A-Za-z_][\w-]*$/, t('配置项名只能用字母、数字、下划线和横线')),
  label: z.string().trim().max(40).default(''),
  type: z.enum(['select', 'multi', 'bool', 'text']).default('select'),
  options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** 默认值；多选是字符串数组，开关是布尔 */
  default: ParamValue.optional(),
  /**
   * skill：替换技能槽（targetId 是槽名，例如 projectStructure）；
   * agent：覆盖 Agent 的参数（targetId 是参数 key）；node：覆盖节点的参数；document：注入工作流说明
   */
  target: z.enum(['skill', 'agent', 'node', 'document']).default('skill'),
  /** skill 时是槽名，agent / node 时是目标 id，document 时是注入位置的小标题 */
  targetId: z.string().trim().max(80).default(''),
  description: z.string().trim().max(200).default(''),
})
export type WorkflowExpose = z.infer<typeof WorkflowExpose>

/**
 * 工作流：用流程图编排节点的执行顺序，由父对话启动成一次工作流运行（shared/flow/run.ts）。
 * 没有主 Agent（workflow-runs 设计 D1）：节点按连线执行，没指定角色的节点用默认执行角色。
 */
export const WorkflowFields = z.object({
  name: z.string().trim().min(1, t('名称不能为空')).max(40),
  description: z.string().trim().max(200).default(''),
  /** 默认执行角色：节点没单独指定角色时用它（字段名沿用旧的「主 Agent」，老数据照读）；为空表示还没选 */
  mainAgentId: z.string().default(''),
  /** 旧版的「团队」：子 Agent 现在直接在节点上选，这里只为读旧数据保留 */
  members: z.array(WorkflowMember).default([]),
  /** 流程：第一个默认是主流程；entryFlowId 指定任务从哪个流程开始 */
  flows: z.array(Flow).min(1).max(20),
  entryFlowId: z.string().default('main'),
  /** 所属分类；为空表示未分类 */
  categoryId: z.string().default(''),
  /** 全局标签的 id */
  tags: z.array(z.string()).max(20).default([]),
  /** 工作流说明（Markdown）：目标、规范、完成标准等，每个节点执行时都会带上 */
  document: z.string().max(50000).default(''),
  /** 父对话挑工作流看的（ADR 0044）：适用场景、不适用的情况；kind 是改代码（收尾合回）还是一个文件都不写 */
  when: z.string().trim().max(200).optional(),
  notFor: z.string().trim().max(200).optional(),
  kind: WorkflowKind.optional(),
  /** 同一节点修改几轮后在运行结尾提示（不强制终止，用户 2026-11-05 定）；0 表示不提示，不写按 3 */
  reviseLimit: z.number().int().min(0).max(50).optional(),
  /** 对外暴露的配置项：项目设置里按它渲染表单 */
  expose: z.array(WorkflowExpose).max(20).default([]),
  /** 每次执行的上限：花费（美元）、token（输入 + 输出）超过就暂停，免得验收来回循环一直烧钱；0 表示不限 */
  budgetUsd: z.number().min(0).max(100000).optional(),
  budgetTokens: z.number().int().min(0).optional(),
  /** 从内置模板建出来的工作流记下来源（builtin:<key>），内置工作流列表里据此显示「删除」 */
  origin: z.string().max(80).optional(),
  /**
   * 面板最后一次写这个内置副本时内容的指纹（见 shared/builtin/install.ts 的 workflowFingerprint）：
   * 现在的内容还是这个指纹就是没改过，启动时直接升级到新定义，不用靠历史版本表逐个比对
   */
  builtinHash: z.string().max(32).optional(),
})
export const WorkflowInput = z.preprocess(migrateWorkflow, WorkflowFields)
export type WorkflowInput = z.infer<typeof WorkflowFields>

export const Workflow = z.preprocess(migrateWorkflow, WorkflowFields.extend(Meta.shape))
export type Workflow = z.infer<typeof WorkflowFields> & z.infer<typeof Meta>

/** 账号额度：每个时间窗口用了多少（百分比）和什么时候重置 */
export interface CliLimits {
  windows: { id: string; usedPercent: number; resetsAt?: number; minutes?: number }[]
  /** 套餐或计费方式，例如 plus、pro */
  plan?: string
  /** 已经用完：正在被限流 */
  limited?: boolean
  at: string
}

/** CLI 加载的 Skill */
export interface CliSkill {
  name: string
  description: string
  /** 用户目录、项目目录、插件、系统自带 */
  scope: string
  path: string
  enabled: boolean
  /** 来自哪个目录（~/.agents/skills、./.claude/skills），列表按它分组；插件里的是空 */
  source?: string
}

/**
 * 输入框里「/」能用的、CLI 自己带的命令：Claude Code 的 .claude/commands、Codex 的 ~/.codex/prompts，
 * 以及 Skill。面板自己做的命令（压缩、审查……）不在这里，页面按 CLI 补上
 */
export interface SlashCommand {
  /** 输入时打的名字，不含「/」 */
  name: string
  description: string
  kind: 'command' | 'skill'
  /** 来自哪里：~/.claude/commands、./.agents/skills、插件…… */
  source: string
  /** 命令接受的参数提示（front matter 里的 argument-hint） */
  hint?: string
}

export interface CliStatus {
  id: string
  name: string
  /** 实际使用的可执行文件（设置里改过就是改后的值） */
  command: string
  /** 设置里是否启用 */
  enabled: boolean
  installed: boolean
  version?: string
  /** 检测失败的原因 */
  error?: string
  /** 是否是设置里的默认 CLI（Agent 选「系统默认」时使用） */
  isDefault?: boolean
  /** 实际运行的文件（按 PATH 找到的） */
  path?: string
  /** 安装方式：npm 全局包、Claude Code 官方安装脚本、Homebrew、其他；更新和卸载用对应的方式 */
  source?: 'npm' | 'native' | 'brew' | 'other'
  models: { id: string; label: string }[]
  docsUrl: string
}

/** 在设置里安装 / 卸载 CLI 的一次操作 */
export interface CliInstallJob {
  id: string
  cli: string
  action: 'install' | 'uninstall'
  status: 'running' | 'done' | 'failed'
  /** 实际执行的命令，失败时用户可以复制到终端自己运行 */
  command: string
  /** npm 的输出（只保留最后一段） */
  log: string
  error?: string
  /** 完成后重新检测到的状态 */
  cliStatus?: CliStatus
  /** 安装时本来就装着：其实是更新 */
  update?: boolean
  /** 完成时的补充说明，例如「已改用 npm 安装的那个」 */
  note?: string
}

/** 已安装版本和 npm 上的最新版本 */
export interface CliUpdate {
  current?: string
  latest?: string
  /** 有更新的版本可以装 */
  available: boolean
  /** 查不到最新版本的原因（没网等），这时不显示更新按钮 */
  error?: string
}

/** 从本机 CLI 读到的模型 */
export interface CliModel {
  id: string
  label: string
  description?: string
  /** 支持的思考强度；不知道时省略 */
  efforts?: string[]
  /** CLI 自己的默认模型 */
  isDefault?: boolean
  /** 这个模型默认的思考强度 */
  defaultEffort?: string
  /** 分组，例如 Command Code 的「Open Source」「Google」 */
  group?: string
  /** cli：CLI 自己提供的（账号可用的、内置的）；config：配置文件里接的第三方 API */
  origin?: 'cli' | 'config'
  /** 上下文窗口（token）；CLI 没给出时省略 */
  contextWindow?: number
  /** 最大输出（token）；CLI 没给出时省略 */
  maxOutput?: number
  /** 能不能看图片：false 时附上的图片它看不到；CLI 没给出时省略 */
  images?: boolean
}

export interface CliModels {
  /** cli：从本机 CLI 读到；builtin：读不到时用内置的建议列表 */
  source: 'cli' | 'builtin'
  models: CliModel[]
  /** 这个 CLI 所有模型支持的思考强度的并集；空表示沿用内置列表 */
  efforts: string[]
  /** 读取失败的原因（这时 models 是内置列表） */
  error?: string
  /** 登录方式：account 是账号登录，列出账号能用的全部模型；api 是 API Key / 自定义接口，列出配置文件里配的模型 */
  auth?: 'account' | 'api'
  /** 模型从哪读的，例如「~/.codex/config.toml」，显示在设置里 */
  from?: string
}

/** 项目分类：同一类项目共用一个默认工作流，例如「Web 应用」「游戏客户端」 */
export const ProjectCategoryInput = z.object({
  name: z.string().trim().min(1, t('分类名不能为空')).max(20),
  description: z.string().trim().max(200).default(''),
  /** 默认工作流；为空表示还没指定 */
  workflowId: z.string().default(''),
})
export type ProjectCategoryInput = z.infer<typeof ProjectCategoryInput>

export const ProjectCategory = ProjectCategoryInput.extend(Meta.shape).extend({
  /** 自带的分类：不能删除（判定按固定 id，见 shared/builtin/project-categories.ts）；旧数据缺这个字段时按 false 读 */
  builtin: z.boolean().default(false),
})
export type ProjectCategory = z.infer<typeof ProjectCategory>

/** 每个工作流一份暴露项取值（key 是工作流 id，值是 Workflow.expose 里的 key → 值） */
export const WorkflowParamsById = z.record(z.string(), z.record(z.string(), ParamValue))

/**
 * 项目里的一条测试步骤：按顺序执行命令、检查环境。
 * 步骤属于项目而不是工作流——同一个工作流给不同项目用时，命令各不相同。
 * 新建对话时也快照一份进任务，但执行时以项目当前设置为准（见 shared/test-steps.ts 的 currentTestSteps）：
 * 改了项目设置，进行中的对话下一次判断就按新步骤走，快照只在项目被删、读不到时兜底。
 */
export const TEST_STEP_ENVS = ['auto', 'wsl', 'powershell', 'cmd', 'bash'] as const

/**
 * 一条测试步骤跑多大范围（决定「谁在什么时候跑它」）：
 * - always：每次改动都跑。类型检查、lint 这类几十秒内能跑完的快速检查
 * - changed：只有改动清单命中 appliesTo 才跑。相关单测、相关界面检查分片
 * - parent：子对话一律不跑，合并后由父对话在全量里跑。全量单测、全量界面检查、端到端测试
 * parent 只对 Git 项目的独立分支子对话生效（有「合回」这一步才有「父对话替你跑」）；
 * 共用目录、P4 / SVN、没有版本控制、工作流节点里没有父对话代跑，这些步骤照常由执行者自己跑。
 * 这个字段合并了原来的 runInParent（勾「禁止子对话执行」等于 scope = parent），不再保留两个字段。
 */
export const TEST_STEP_SCOPES = ['always', 'changed', 'parent'] as const
export type TestStepScope = (typeof TEST_STEP_SCOPES)[number]

/**
 * 命令里能看出「跑的是全量、很慢」的写法：迁移老步骤和生成默认步骤时补成 parent。
 * 只认这些明确的全量入口，宽泛的 test / build 不改判——猜错成 parent 会让子对话漏跑，比多跑一次更糟。
 */
export const FULL_SUITE_COMMAND = /(test:?(?:unit|all|e2e)\b|\be2e\b|ui-check|playwright\s+test|cypress)/i

/**
 * 老步骤的 runInParent 迁成 scope（不保留两个字段）：
 * 老字段 runInParent 为 true 的就是 parent；没勾的按原来的筛选语义还原——
 * 命令明显是跑全量的（全量单测、全量界面检查、e2e）先判 parent，**不看 appliesTo**：
 * 老默认步骤正是「全量命令 + 适用改动」，先按 appliesTo 判成 changed 会让存量项目照旧每个子对话跑一遍全量；
 * 其余写了适用改动的是 changed；「合并时编译」的步骤本来就只在父对话侧跑，标 changed；剩下的是 always。
 * appliesTo 为空的老步骤仍然是「总是执行」：升级不会让原来会跑的步骤变成从不跑。
 * 全量命令判成 parent 是这次的行为变化（子对话不再自己跑全量），见 ADR 0020。
 */
export function legacyTestStepScope(step: {
  runInParent?: unknown
  appliesTo?: unknown
  merge?: unknown
  command?: unknown
}): TestStepScope {
  if (step.runInParent === true) return 'parent'
  if (FULL_SUITE_COMMAND.test(String(step.command ?? ''))) return 'parent'
  if (Array.isArray(step.appliesTo) && step.appliesTo.some((g) => typeof g === 'string' && g.trim())) return 'changed'
  if (step.merge === true) return 'changed'
  return 'always'
}

/** 整条步骤的迁移：已经写了 scope 的不动，老数据按上面的规则换算并去掉 runInParent */
export function migrateTestStep(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const s = input as Record<string, unknown>
  if (s.scope !== undefined) return s
  const { runInParent: _legacy, ...rest } = s
  return { ...rest, scope: legacyTestStepScope(s) }
}

/**
 * 测试步骤的字段（不含 id）：AI 生成 / 补全步骤时整份沿用这里校验，
 * 新增字段只改这一处，避免提示词、AI 结果和保存校验三份定义走偏。
 */
export const TestStepShape = z.object({
  /** 显示名，例如「类型检查」「编译」 */
  name: z.string().trim().min(1, t('步骤名不能为空')).max(60),
  /** 要执行的命令原文 */
  command: z.string().trim().min(1, t('命令不能为空')).max(2000),
  /** 在哪执行：auto 按项目所在系统和命令自己判断 */
  env: z.enum(TEST_STEP_ENVS).catch('auto').default('auto'),
  /** 相对项目根的工作目录；空表示项目根 */
  cwd: z.string().trim().max(300).default(''),
  /** 执行条件的补充说明，写给人看的，例如「仅在发布前跑」；判定以 appliesTo 为准 */
  when: z.string().trim().max(120).default(''),
  /**
   * 适用范围（scope = changed 时用）：本次改动的文件里至少要有一个匹配这些 glob，才跑这条步骤。
   * 空数组按总是执行处理——老项目的步骤没有这个字段，解析上来是空数组，不会因为升级就漏跑；
   * 新加的步骤留空同样表示「改动怎么看都该跑」。
   * 匹配算法只有一份（shared/test-steps.ts 的 matchesGlob / stepApplies）：界面输入用 parseGlobs、
   * 交给 Agent 的提示词用 appliesToText，单测钉住 stepApplies；按清单筛哪些步骤要跑由
   * scripts/changed-tests.mjs 做（单测文件、界面分片的定位也在这个脚本里）
   */
  appliesTo: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /** 跑多大范围，见 TEST_STEP_SCOPES；老步骤解析时按 legacyTestStepScope 换算 */
  scope: z.enum(TEST_STEP_SCOPES).catch('always').default('always'),
  /** 超时（秒）；0 表示不限 */
  timeoutSec: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .catch(0)
    .default(0),
  note: z.string().trim().max(300).default(''),
  enabled: z.boolean().default(true),
  /** 合并时编译：子对话提交编译时，面板把它合回原目录后跑这些步骤，通过才提交 */
  merge: z.boolean().default(false),
  /**
   * 小改动也跑：Agent 判断这次是小改动时只跑标了这个的步骤（类型检查、lint 这类几秒到几十秒的），
   * 不跑完整测试；合并编译时也只跑同时标了「合并时编译」的。旧步骤没有时是 false
   */
  quick: z.boolean().default(false),
})

export const TestStepFields = z.preprocess(migrateTestStep, TestStepShape)
export type TestStepFields = z.infer<typeof TestStepShape>

export const TestStep = z.preprocess(
  migrateTestStep,
  TestStepShape.extend({
    id: z.string().trim().min(1).max(40),
  }),
)
export type TestStep = z.infer<typeof TestStep>

/**
 * 项目教训：Agent 在这个项目里返工过的地方，写成下次能直接照做的规则。
 * 按 paths 命中要改的文件才给全文，提示里平时只放标题，条目多了也不会占满上下文（见 shared/lessons.ts）
 */
/** 教训被改写前的一版 */
export const LessonRevision = z.object({
  title: z.string().max(120),
  rule: z.string().max(1500).default(''),
  /** 为什么改：用户的哪条新要求和它冲突、两全的做法是什么 */
  why: z.string().max(500).default(''),
  at: z.string().default(''),
})
export type LessonRevision = z.infer<typeof LessonRevision>

export const ProjectLesson = z.object({
  id: z.string().min(1),
  /** 一句话的规则：该怎么做，不是发生了什么 */
  title: z.string().trim().min(1, t('规则不能为空')).max(120),
  /** 展开说明：具体到文件、字段、做法 */
  rule: z.string().trim().max(1500).default(''),
  /** 起因：哪次返工、被怎么纠正 */
  cause: z.string().trim().max(500).default(''),
  /** 管哪些文件（相对项目根的 glob，`**` 跨目录）；空表示所有改动都适用 */
  paths: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  /** 标签：按主题归类（并发、测试……），界面上能按它筛，Agent 也能按它查不对应具体文件的条目；旧数据没有时为空 */
  tags: z.array(z.string().trim().min(1).max(20)).max(5).catch([]).default([]),
  enabled: z.boolean().default(true),
  /** 谁记的：用户手动加的，还是 Agent 被纠正后自己记的（方便用户复查） */
  source: z.enum(['user', 'agent']).catch('user').default('user'),
  /** 在哪个对话里记的 */
  taskId: z.string().default(''),
  createdAt: z.string().default(''),
  /** 最后一次被改写的时间：用户的新要求和它冲突、Agent 找到两全的做法时会改写它 */
  updatedAt: z.string().default(''),
  /** 改写前的版本（新的在前，最多留几条）：用户能看到它为什么变了，改坏了也能照着改回去 */
  history: z.array(LessonRevision).max(5).catch([]).default([]),
})
export type ProjectLesson = z.infer<typeof ProjectLesson>

/**
 * 全局教训：从各个项目的教训里提取出来、换个项目也适用的规则，所有项目的对话都会带上。
 * 只能由用户确认后修改（Agent 没有写它的工具），优先级低于项目教训和用户这次的要求。
 * 存在数据目录的 config/global-lessons.json
 */
export const GlobalLesson = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, t('规则不能为空')).max(120),
  rule: z.string().trim().max(1500).default(''),
  cause: z.string().trim().max(500).default(''),
  /** 一般不写：不同项目的目录不一样；写了就按相对项目根的 glob 匹配 */
  paths: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  enabled: z.boolean().default(true),
  /** 从哪些项目提取的（项目名，只用来显示） */
  from: z.array(z.string().max(60)).max(20).default([]),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
})
export type GlobalLesson = z.infer<typeof GlobalLesson>
export const GlobalLessons = z.array(GlobalLesson).max(100)

/** 旧项目的 workflowParams 是单层（只属于 workflowId 那一个工作流），读出来时按工作流分组 */
function migrateProject(input: unknown) {
  const v = dropLegacyAgent(input)
  if (!v || typeof v !== 'object') return v
  const p = v as Record<string, unknown>
  const raw = p.workflowParams
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p
  const vals = Object.values(raw)
  const single = vals.length > 0 && vals.every((x) => x === null || typeof x !== 'object' || Array.isArray(x))
  if (!single) return p
  return { ...p, workflowParams: p.workflowId ? { [String(p.workflowId)]: raw } : {} }
}

/** 项目：本机上的一个目录，项目对话和子对话都在这个目录里执行 */
const ProjectFields = z.object({
  name: z.string().trim().min(1, t('名称不能为空')).max(40),
  description: z.string().trim().max(200).default(''),
  /** 本机绝对路径 */
  path: z.string().trim().default(''),
  categoryId: z.string().default(''),
  /** 子对话默认用的工作流；为空时使用分类的默认工作流 */
  workflowId: z.string().default(''),
  /** 子对话可以挑选的其他工作流：默认工作流不合适时优先用更合适的那个 */
  workflowIds: z.array(z.string()).max(50).default([]),
  /** 默认对话 Agent：项目里新建对话时用它，可以设为无（空字符串） */
  defaultAgentId: z.string().default(''),
  /** 用户有没有设置过默认 Agent：升级时没设置过的旧项目自动指向协调 Agent，设过「无」的不再覆盖 */
  agentSet: z.boolean().default(false),
  /** 工作流暴露项的取值，每个工作流一份（key 是工作流 id） */
  workflowParams: WorkflowParamsById.default({}),
  /**
   * 这个项目里给必备角色（统筹、执行、文档、测试验收）填的参数，key 是角色 id：
   * 执行时当作这个项目里的默认值，见 shared/builtin/core.ts 的 withProjectParams
   */
  agentParams: WorkflowParamsById.default({}),
  /**
   * 这个项目的测试步骤：新建对话时快照进任务，测试 Agent 按它执行。
   * 旧项目没有这个字段时是空数组（Agent 自己找命令，并建议用户补上）。
   */
  testSteps: z.array(TestStep).max(40).default([]),
  /** 在这个项目里关掉的插件测试步骤（plugin:<插件>:<步骤>）：插件带的步骤默认生效，见 shared/plugins/contrib.ts */
  pluginStepsOff: z.array(z.string().max(100)).max(100).optional(),
  /**
   * 按改动大小决定验证范围：小改动只跑快速检查就收尾，大改动跑完整的测试步骤。
   * 关掉时每次改动都跑完整步骤。旧项目也默认打开：小改动在没有标「小改动也跑」的合并步骤时仍跑全部合并步骤，不会少编译
   */
  scaledVerify: z.boolean().default(true),
  /**
   * 项目教训：新数据存在项目文档目录的 lessons.md（见 server/projects/lessons.ts），这里只保留旧项目的数据，
   * 读取时和文件合并、写入后清空。旧项目没有时是空数组
   */
  lessons: z.array(ProjectLesson).max(200).default([]),
  /** 标了 WSL 的测试步骤用哪个发行版；空时用 Ubuntu-24.04 */
  wslDistro: z.string().trim().max(60).default(''),
  /**
   * 这个项目里新建 / 改写的文本文件用什么编码和换行符；
   * 留空时跟随设置里的全局格式（默认 UTF-8 无 BOM + LF）
   */
  fileFormat: FileFormat.optional(),
  /**
   * 找文件、搜代码时要跳过的目录（相对名字，例如 Saved、Intermediate）：
   * 实际生效的是它加上内置默认清单（见 shared/search-exclude.ts），提示词里会带上一行。
   * 没设时只用内置默认清单（和 fileFormat 一样是可选的：旧数据和直接拼 Project 字面量的地方不用补）
   */
  searchExclude: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  /** 每个 CLI 信不信任项目里它的配置（ADR 0050，见 shared/cli/trust.ts）；没写就跟随 CLI 自己的决定 */
  cliTrust: ProjectCliTrust,
  /**
   * 子对话怎么避免互相干扰：
   * - worktree：Git 项目里每个子对话在自己的独立分支目录里改文件（只隔离编辑，不在里面编译）；
   *   改完提交编译，面板把它合回开分支的那个目录试编译，通过才提交、失败撤回并把报错交回子对话。
   *   不是 Git 仓库（P4、没有版本控制）时自动退回 claim
   * - claim：和父对话共用一个目录，改文件前认领（同一个文件同一时间只归一个子对话）
   */
  childIsolation: z.enum(['worktree', 'claim']).catch('worktree').default('worktree'),
  /**
   * 新建对话时「独立分支」默认勾不勾（只是输入框里的默认值，每次新建仍可以改）。默认不勾，要的在项目设置里打开
   * （用户 2026-11-05 定，撤回 2026-11-04 的默认开）。
   * 旧字段 isolateNew 默认是 true，存的 true 多半只是写盘带上的默认值、不是用户选的；存的 false 和新默认一样。
   * 所以换名后由 zod 剥掉旧字段，旧项目一律按新默认不勾；更早的 isolateDefault 同理
   */
  isolateByDefault: z.boolean().default(false),
  /**
   * cherry-pick 的目标：Git 项目是本地分支名，P4 项目是目标工作区里的项目路径（另一条分支映射到本机的目录）。
   * 用户让 Agent 把改动 cherry-pick 过去时按它做；没设时为空（可选：旧数据和直接拼 Project 字面量的地方不用补）
   */
  cherryPick: z.string().trim().max(500).optional(),
  /**
   * 插件按项目存的设置（插件接口 6，WebPlugin.projectSections）：键是插件 id，内容由插件自己定、自己校验，
   * 跟项目设置一起保存；面板不认识里面的东西，插件删了也原样留着，重装后接着用
   */
  plugins: z.record(z.string(), z.unknown()).optional(),
  /** 推送授权：ask 第一次需要推送时问一次，allow 直接推，deny 一律不推 */
  gitPolicy: z.enum(['ask', 'allow', 'deny']).default('ask'),
  /**
   * 每个顶层对话（连同名下全部子对话）的用量上限：80% 提醒一次，100% 停下整个对话（见 shared/budget.ts）。
   * 两项都是 0 表示不限；旧项目没有这个字段，也是不限
   */
  budget: z.object({ tokens: z.number().int().min(0).default(0), costUsd: z.number().min(0).default(0) }).optional(),
  /** 改了代码要跑过测试步骤才能用 end_turn 记成做完（shared/done-evidence.ts）；默认不拦，只在完成依据上标出来 */
  requireVerify: z.boolean().optional(),
  /**
   * 「AI 初始化项目」完成并应用的时间（ISO）。空表示还没初始化：项目设置里要先初始化才能确认保存，
   * 旧项目也是空的，第一次打开设置时补做一次
   */
  initializedAt: z.string().max(40).default(''),
  /**
   * 上次「AI 初始化项目」算出的推荐（结构见 project-init.ts 的 ProjectProposal）。
   * 存下来后重新打开设置时，卡片上还能直接应用推荐；旧项目没有这个字段，按没有推荐处理。
   * 这里只标类型，具体校验由服务端用 ProjectProposalSchema 做（两边不能循环引用）
   */
  initResult: z.custom<ProjectProposal>().optional(),
  /**
   * 侧栏里的显示顺序：拖拽后由 PUT /projects/order 重新编号（1、2、3…）。
   * 没有这个字段的旧项目还没排过，按添加时间排序，并且排在拖拽过的项目后面
   */
  sortOrder: z.number().int().min(0).optional(),
})
export const ProjectInput = z.preprocess(migrateProject, ProjectFields)
export type ProjectInput = z.infer<typeof ProjectFields>

export const Project = z.preprocess(migrateProject, ProjectFields.extend(Meta.shape))
export type Project = z.infer<typeof ProjectFields> & z.infer<typeof Meta>

/** 本地目录检测结果 */
export interface DirInfo {
  path: string
  exists: boolean
  isDir: boolean
  /** 是 git 仓库时的当前分支（分离 HEAD 时为提交号前 7 位） */
  gitBranch: string | null
  /** 目录里已有「AI 初始化项目」写好的 AGENTS.md（带指向 MODULE-MAP 的文档地图）：同一目录新建项目时不用再初始化 */
  initialized: boolean
}

/** 会话栏要现读的本机信息（见 server/session-bar.ts） */
export interface SessionInfo {
  /** 对话的工作目录（独立分支时是 worktree） */
  dir: string
  /** 「owner/repo」，没有远端时是目录名 */
  repo: string
  branch: string
  isGit: boolean
  /** CLI 启动时读的说明文件（字数） */
  memory: { path: string; chars: number }[]
  /** 进了上下文的 Skill（名字 + 描述的字数） */
  skills: { name: string; chars: number }[]
  /** 改动里这个对话新建的文件 */
  outputs: string[]
}

/** 目录所在 git 仓库的本地分支 */
export interface DirBranches {
  /** 当前所在的分支；分离 HEAD 时为空 */
  current: string | null
  /** 最近提交的排在前面 */
  branches: string[]
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
  /** 快速入口：Windows 上是各个盘符，其他系统是主目录和根目录 */
  roots?: { name: string; path: string }[]
}

/**
 * 任务：在某个项目里执行的一次工作。
 * - workflow：按工作流的流程图执行，阶段依次推进，阶段内的节点并行
 * - chat：直接和一个 Agent 对话
 * 创建后用户可以继续追加要求，每次追加会触发新一轮执行。
 */
export const TaskMode = z.enum(['workflow', 'chat'])
/**
 * AI 分析对话的种类（见 ADR 0014、0016）：标题在列表里和别的对话区分开，右侧功能面板按种类挑内容。
 * run：分析执行记录（对话、子任务、几次工作流执行）；init：AI 初始化项目；lessons：教训评审；fix：AI 排查报错
 */
export const AnalysisKind = z.enum(['run', 'init', 'lessons', 'fix'])
export type AnalysisKind = z.infer<typeof AnalysisKind>

/** 用户随要求附上的文件或图片：上传后存在面板的数据目录里，执行时把路径告诉 Agent，由 CLI 自己读取 */
export const Attachment = z.object({
  name: z.string().min(1).max(200),
  /** 本机绝对路径 */
  path: z.string().min(1),
  size: z.number().int().min(0),
  mime: z.string().default(''),
  /** 引用已有的文件（把复制出来的路径粘贴回输入框）：发送时不再拷进对话目录，直接用这个路径 */
  ref: z.boolean().optional(),
  /**
   * 引用对话里的一段内容：原文。界面上是一张引用卡片，交给 Agent 时在原位换成引用块；
   * 原文同时存成附件目录里的一个文件（path），复制消息时给的就是这个路径，粘贴回来还能认出是引用
   */
  quote: z.string().max(50000).optional(),
})
export type Attachment = z.infer<typeof Attachment>
/**
 * 上传一个附件最大多少（字节）。比设置里「大文件」小的才上传；大文件先在本机找回原路径直接引用，
 * 找不到时没超过这个上限的仍然上传一份
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/**
 * 一个对话最多能设多少 token 的执行上限：一亿 token 已经远超一次对话，
 * 再大一定是填错了；太小会挡住正常的长时间任务，所以不收更小的人工上限
 */
export const MAX_TASK_BUDGET_TOKENS = 100_000_000
/** 一个对话的时长上限最多几天（分钟）：和设置里的单步时限同一个上限，超过一天的任务该拆成多个 */
export const MAX_TASK_BUDGET_MINUTES = 1440
/**
 * 消息里图片卡片取的图有多宽（像素）。卡片本身是 1.25em 见方（约 20px），2 倍屏上按 40px 显示，
 * 取 160 已留 4 倍余量；同一批 48 张截图实测：原图 3501KB，640 要 2376KB，160 只要 266KB。
 * 看大图、复制图片仍取原图，不受它影响。
 */
export const ATTACHMENT_THUMB_WIDTH = 160
export type TaskMode = z.infer<typeof TaskMode>

export const NewTaskInput = z.object({
  /** 为空表示 Chat 模式的聊天：不属于任何项目，只能直接对话 */
  projectId: z.string().default(''),
  mode: TaskMode,
  /** 由哪个对话分出：协调 Agent 新建子对话时填父对话的 id */
  parentTaskId: z.string().optional(),
  /** 顶层对话 id；为空表示自己就是顶层对话 */
  rootTaskId: z.string().optional(),
  /** workflow 模式：为空时用项目的工作流 */
  workflowId: z.string().default(''),
  /** chat 模式：对话的 Agent（旧客户端可能还传已经去掉的角色 id，按登记的换过去） */
  agentId: z.string().default('').transform(aliasAgent),
  /** chat 模式用的 CLI、模型和思考强度（只对默认 Agent 有效）；为空跟随默认 CLI 的设置 */
  cli: z.string().trim().max(40).default(''),
  model: z.string().trim().max(200).default(''),
  effort: z.string().trim().max(40).default(''),
  prompt: z.string().trim().min(1, t('请描述任务')).max(20000),
  attachments: z.array(Attachment).default([]),
  /** chat 模式：Agent 参数的值（没给的用默认值） */
  params: z.record(z.string(), ParamValue).default({}),
  /**
   * 在独立分支（git worktree）里执行，不直接改项目目录；只有 git 仓库可以。
   * 只对项目里的顶层对话有效：子对话一律和父对话用同一个目录，不建独立分支（几个子对话同时改由文件认领协调）
   */
  isolate: z.boolean().optional(),
  /** 「提问」开关：Agent 的提问交给用户回答；关着时让它自己选 */
  askUser: z.boolean().default(false),
  /** 父对话的「子对话也提问」：之后新建子对话默认开不开提问（见 shared/children/ask.ts）；只在创建时用，不传按设置 */
  childAskUser: z.boolean().optional(),
  from: z.string().optional(), // 别的对话替它建的（task.create）：发件对话 id，第一条记成 peer（ADR 0041）
  /** AI 分析开出的对话：记下是哪种分析（见 AnalysisKind） */
  analysis: AnalysisKind.optional(),
  /** AI 分析开出的对话：分析的是哪个对话（「在当前对话里修」把修复建议发回它）；和对话无关的分析不填 */
  analysisOf: z.string().max(100).optional(),
  /** 归哪个插件的设计模式（插件网页部分登记的 id，例如 blender.model；ADR 0059），普通对话不填 */
  plugin: z.string().max(80).optional(),
  /**
   * 执行上限（定时计划带的）：token 上限和时长上限（分钟）。
   * 0 表示不限；计划里的值在创建对话时落进任务，之后改计划不影响已经启动的对话
   */
  budgetTokens: z.number().int().min(0).max(MAX_TASK_BUDGET_TOKENS).optional(),
  budgetMinutes: z.number().int().min(0).max(MAX_TASK_BUDGET_MINUTES).optional(),
  /** 这个对话自己的用量上限（连同名下子对话），设了就不用项目的（Task.convBudget） */
  convBudget: ConvBudget.optional(),
})
export type NewTaskInput = z.infer<typeof NewTaskInput>

/** 任务的独立分支：Agent 在这个目录里改，做完后合并回项目或丢弃 */
/**
 * 一条分诊记录：协调器（父对话）把一条消息分到哪里、为什么、替用户做了什么假设。
 * 由派单工具的 route 参数生成，界面画成分诊卡，用户可以一键改派（见 docs/openspec/changes/role-composition-and-dispatch）
 */
export const TaskRoute = z.object({
  id: z.string(),
  /** 去向：子对话（新开 / 交回）、子任务、就地微改动 */
  target: z.enum(['child', 'resend', 'subtask', 'inline-edit']),
  /** 去向的对象：子对话 id、子任务 id；就地改动是声明的文件 */
  refs: z.array(z.string().max(300)).max(20).default([]),
  /** 去向的标题：子对话标题、子任务标题 */
  label: z.string().max(200).default(''),
  understanding: z.string().max(500).default(''),
  reason: z.string().max(500).default(''),
  assumptions: z.string().max(500).default(''),
  /** 这条分诊出自哪条消息（用户消息的 id；找不到时为空） */
  messageId: z.string().default(''),
  at: z.string(),
  /** 用户点了「改派」的时间 */
  overriddenAt: z.string().optional(),
})
export type TaskRoute = z.infer<typeof TaskRoute>

export const TaskWorktree = z.object({
  path: z.string(),
  branch: z.string(),
  /** 创建时项目所在的分支，界面上提示合并到哪里 */
  baseBranch: z.string().default(''),
  state: z.enum(['active', 'merged', 'discarded']).default('active'),
  /** 合并、丢弃的结果说明（合并到了哪个分支） */
  note: z.string().default(''),
})
export type TaskWorktree = z.infer<typeof TaskWorktree>

/** 对话页面还开着：CLI 才能停在 MCP 工具上等下一句（见 server/presence.ts） */
export const PresenceInput = z.object({
  viewerId: z.string().min(1),
  active: z.boolean(),
})

/**
 * `POST /tasks/:id/seen` 的返回：只回「这一轮看到哪」，不再把整份对话传回去
 * （打开一次对话页之前要多传 2.4MB，前端其实只拿它把本地那份换个 turnSeenAt）。
 */
export const TaskSeenResult = z.object({ turnSeenAt: z.string() })
export type TaskSeenResult = z.infer<typeof TaskSeenResult>

export const FollowUpInput = z.object({
  text: z.string().trim().min(1, t('内容不能为空')).max(20000),
  attachments: z.array(Attachment).default([]),
  /** 任务正在执行时：true 先停下当前这一轮再发送；否则直接交给正在跑的 CLI，交不出去就这一轮结束后接着处理 */
  interrupt: z.boolean().default(false),
  /** 页面生成的消息 id（待认领）：服务端沿用，推送到达后按 id 换成真实的一份、不出现两条；必须是 uuid，免得撞 id */
  messageId: z.uuid().optional(),
  from: z.string().optional(), // 别的对话替它发的（task.send）：发件对话 id，记成 peer（ADR 0041）
  /** 这条是交回「等你操作」的结果（输入框上挂着「交回给」）：那件事的 id，服务端收口后给 CLI 的内容前面加一句说明 */
  userAction: z.string().max(100).optional(),
})
/** 父对话发布的一条全局规则 */
export const TaskRule = z.object({ id: z.string(), text: z.string().max(2000), at: z.string() })
export type TaskRule = z.infer<typeof TaskRule>

/** 可以直接修改的任务字段 */
export const TaskPatch = z
  .object({
    title: z.string().trim().min(1, t('标题不能为空')).max(80),
    archived: z.boolean(),
    // 聊天置顶：侧栏聊天列表最上面单独一组，只是标记
    pinned: z.boolean(),
    // 子对话「解决」：只是标记，不动 status、不停进程，随时能再打开
    resolved: z.boolean(),
    // 对话用的 CLI、模型和思考强度，执行中也能改，下一轮生效
    cli: z.string().trim().max(40),
    model: z.string().trim().max(200),
    effort: z.string().trim().max(40),
    modelOverride: ModelOverride, // 用角色的对话换模型（失败后「换个模型重试」），见 task-run.ts
    // 「提问」开关：Agent 有问题时交给你回答，还是让它自己选
    askUser: z.boolean(),
    // 父对话的「子对话也提问」：之后新建的子对话默认是否开启提问
    childAskUser: z.boolean(),
    // 一次性动作：这次改 childAskUser 时，已创建的子对话要不要跟着改（不存进任务）
    applyChildAsk: z.boolean(),
    // 对话的 Agent 参数，下一轮生效
    params: z.record(z.string(), ParamValue),
    // 对话的 Agent；空字符串表示不用 Agent 角色，直接用 CLI
    agentId: z.string(),
    // 父对话的设置：目标、全局规则、子对话的执行配置
    goal: z.string().trim().max(4000),
    rules: z.array(TaskRule).max(50),
    childRun: z.object({ cli: z.string().max(40), model: z.string().max(200), effort: z.string().max(40) }).nullable(),
  })
  .partial()
export type TaskPatch = z.infer<typeof TaskPatch>

/**
 * 对话里的报错和警告分哪几类（说明和处理办法见 shared/alerts.ts）：界面画成一行带底色的「警告」，
 * 点开看这是什么、怎么办和原始信息。所有错误都要这样显示在对话里，不能只写日志
 */
export const AlertKind = z.enum([
  'network', // 连不上模型服务、连接中断
  'gateway', // 上游网关 / 中转服务把连接断开了（502、Connection closed）
  'rate_limit', // 被限流、服务过载
  'auth', // 登录过期、密钥无效
  'quota', // 余额或额度用完
  'context', // 上下文超长
  'model', // 模型名不对、接口拒绝这次请求
  'cli_missing', // 找不到 CLI 命令
  'cli_exit', // CLI 没做完这一轮就退出、执行失败
  'no_response', // 交给 CLI 后迟迟没有任何输出
  'mcp_slow', // 项目里配的 MCP 服务连不上或不响应，CLI 第一轮可能先等它
  'idle', // 执行中很久没有输出
  'timeout', // 超过单步时限被停掉
  'empty_turn', // CLI 报这一轮结束，却什么都没返回
  'retry', // CLI 自己在重试
  'delivery', // 面板没能把消息交给对话（后台结果、子对话上报）
  'worktree', // 独立分支建不起来、删不掉
  'budget', // 用户给这个计划 / 任务设的 token 或时长上限到了
  'unfinished', // 计划没做完就停下，面板推满了还这样
  'panel', // 面板自己出错
  'plugin', // 插件出错、超时（挂工具、启动），这一轮用不了它的工具
])
export type AlertKind = z.infer<typeof AlertKind>

export const Alert = z.object({
  kind: AlertKind,
  /** warn 黄底：还在处理或可能自己恢复；error 红底：这一步失败了，需要处理 */
  level: z.enum(['warn', 'error']),
  /** 原始信息：CLI 的报错、stderr、面板的异常，点开时原样显示 */
  detail: z.string().default(''),
  /** 后来恢复了（重试成功、又有输出了）：一句说明，行变成灰色 */
  resolved: z.string().optional(),
})
export type Alert = z.infer<typeof Alert>

/** Agent 在一条消息里做的操作：读文件、改文件、跑命令、搜索 */
export const ToolUse = z.object({
  kind: z.enum(['read', 'edit', 'run', 'search', 'web', 'skill', 'agent', 'compact', 'other']),
  /** 动作名，显示在最前面，例如「读取」「技能」「MCP」；为空时按 kind 给默认的 */
  name: z.string().optional(),
  /** 动作的对象：文件、命令、技能名、搜索词 */
  label: z.string(),
  detail: z.string().default(''),
  /** 点开工具调用时显示：完整命令、参数或改动内容 */
  input: z.string().optional(),
  /** 工具的输出（命令输出、读到的内容、错误），过长时截断 */
  output: z.string().optional(),
  /** 工具执行失败 */
  failed: z.boolean().optional(),
  /** 工具进程的退出码（CLI 报得出时才有）：有输出但退出码非零，和什么都没跑出来，排查时是两回事 */
  exitCode: z.number().optional(),
  /** 还在执行（命令的输出会边跑边更新） */
  running: z.boolean().optional(),
  /** 这次调用跑了多久（毫秒）：跑完才有 */
  ms: z.number().optional(),
  /** 还在等结果的调用从什么时候开始（毫秒时间戳）：界面边跑边显示已经用了多久，跑完换成 ms */
  startedAt: z.number().optional(),
  /**
   * 压缩上下文的这次调用的前后大小（token）：界面直接读数值，不解析 label 里的中文。
   * 旧数据没有这个字段，CLI 没报数值时字段缺省，界面按缺失处理
   */
  compact: z
    .object({
      /** 压缩前上下文的大小 */
      before: z.number().optional(),
      /** 压缩后上下文的大小 */
      after: z.number().optional(),
      /** 压缩完 CLI 没报压缩后多大（Codex 手动压缩）：等下一轮第一次报用量时补上 after */
      awaitAfter: z.boolean().optional(),
    })
    .optional(),
  /** 这一行是报错或警告（CLI 的重试提示、面板的提醒）：画成带底色的警告行 */
  alert: Alert.optional(),
  /**
   * 推给页面时省掉了输出的后半段（只出现在推送里，不存盘，见 shared/task.ts 的 liteMessages）：
   * 原来的长度、行数，和取全文用的消息 id、第几个工具。页面打开窗口看全部时再按这个去取
   */
  outputCut: z.object({ len: z.number(), lines: z.number(), msg: z.string(), i: z.number() }).optional(),
})
export type ToolUse = z.infer<typeof ToolUse>

/** 子对话交出去的两种需要用户拍板的事：执行中的提问、这一轮做完的收尾建议 */
export const AskKind = z.enum(['question', 'suggestion'])
export type AskKind = z.infer<typeof AskKind>

/**
 * 对话之间收发的消息分哪几类：收发两边都按它挑图标和小标签，一眼分得出是交代任务还是上报、收尾、编译。
 * task 交代任务、answer 回答提问、question 提问、report 汇报和状态上报、wrapup 请求收尾、
 * merge 收尾结果、build 编译（申请、占位、结果）、rule 全局规则、chat 父对话之间传话
 */
export const PeerKind = z.enum([
  'task',
  'answer',
  'question',
  'report',
  'wrapup',
  'merge',
  'build',
  'test',
  'rule',
  'chat',
])
export type PeerKind = z.infer<typeof PeerKind>

/** 这条消息是另一个对话发来的：谁发的（角色名、对话标题）、它和收件方是什么关系、哪一类、是不是报错 */
export const PeerFrom = z.object({
  id: z.string(),
  title: z.string().default(''),
  /** 发件对话的角色名（「统筹」「程序」）：界面写「已收到 X 发来的消息」 */
  name: z.string().default(''),
  /** 发件方相对收件方：parent 父对话、child 子对话、peer 同项目的其他父对话 */
  rel: z.enum(['parent', 'child', 'peer']),
  kind: PeerKind.default('report'),
  /** 内容标题：一行里显示的那句（交代的事、状态、收尾结果）；为空时取正文第一行 */
  subject: z.string().default(''),
  /** 报错、失败、没合进去这一类：行标红 */
  failed: z.boolean().optional(),
  /** 同一个子对话后来又交了一封汇报、这封还没被读就被替换掉了：对话流里这一行变淡（ADR 0034） */
  superseded: z.boolean().optional(),
})
export type PeerFrom = z.infer<typeof PeerFrom>

/**
 * 执行中发的那条用户消息最后是怎么交给 CLI 的（面板记录的事实，界面据此写「插进当前轮 / 排到下一轮」）：
 * wait CLI 正等着下一句，直接交回同一个进程；steer 插进正在执行的这一轮；
 * notes 交给正在跑的 CLI，它会在这一轮里自己取；next-node 交给工作流里下一个开始的节点；
 * held 这一轮收不下，结束后自动接着处理；next 这一轮已经结束，按新的一轮处理；
 * lost 这一轮没能正常结束（失败、停止），排着的消息不会再被自动处理，要用户重新发；
 * restart CLI 卡住了，停掉后接回会话重开一轮处理；
 * pending 只在页面本地：点发送后已经插进对话、面板还没接收（界面立刻清空输入框，不用等接口返回）
 */
export const DeliveryHow = z.enum(['wait', 'steer', 'notes', 'next-node', 'held', 'next', 'lost', 'restart', 'pending'])
export type DeliveryHow = z.infer<typeof DeliveryHow>

export const FileChange = z.object({ path: z.string(), add: z.number().int(), del: z.number().int() })
export type FileChange = z.infer<typeof FileChange>

/**
 * 项目根之外、这个对话的 Agent 写出过的一个文件：只有绝对路径。
 * 不在 git 快照里，算不了增删行数、做不了差异和撤销，右栏只列出来供查看。
 * 和 FileChange 分开：changes 只放相对项目根、能算差异的改动，审查和撤销只认它
 */
export const OutsideChange = z.object({ path: z.string() })
export type OutsideChange = z.infer<typeof OutsideChange>

/**
 * 一轮对话改了哪些文件（总结下面的「已更改 N 个文件」，见 server/turn/changes.ts）：
 * spans 是 git 快照树的起止（中间被子对话合并隔开时有几段），撤销时只撤这几段自己的改动。
 * revertedAt 是撤销的时间：撤过的卡片只显示「已撤销」，不能再撤
 */
export const TurnChanges = z.object({
  spans: z.array(z.object({ from: z.string(), to: z.string() })),
  files: z.array(FileChange),
  /** 剔除掉的同目录别的对话改的文件（server/turn/owners.ts）：卡片上说明一句，免得用户以为漏记了 */
  others: z.array(z.string()).optional(),
  revertedAt: z.string().optional(),
})
export type TurnChanges = z.infer<typeof TurnChanges>

export const TaskMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'system']),
  agentId: z.string().default(''),
  /** 属于哪个任务节点（task.steps 的 id）；为空表示不属于任何节点（追问、对话） */
  step: z.string().default(''),
  text: z.string().default(''),
  /** 交给 Agent 的内容：工作流里输入的「/命令」展开成的要求；为空时用 text */
  prompt: z.string().optional(),
  tools: z.array(ToolUse).default([]),
  /** 生成这段回复前的思考过程（CLI 给出的思考或推理摘要） */
  thinking: z.string().optional(),
  /** 思考用了多久（毫秒） */
  thinkingMs: z.number().optional(),
  /** 这一轮模型请求用了多久（毫秒）：CLI 报得出起止时才有，用来说明两步之间等的是模型 */
  modelMs: z.number().optional(),
  /** 用户消息附上的文件和图片 */
  attachments: z.array(Attachment).optional(),
  /**
   * 这条用户消息是怎么交给 CLI 的（执行中发的才有，见 DeliveryHow）：记的是事实，
   * 界面按它告诉用户消息去了哪里（插进当前这一轮 / 排到下一轮 / 这一轮结束后自动处理）
   */
  delivery: z.object({ how: DeliveryHow, at: z.string() }).optional(),
  /** 系统消息是不是错误：错误在节点里和对话里都用醒目的样式显示 */
  error: z.boolean().optional(),
  /** 报错、警告的分类和原始信息：画成可以点开的警告行（旧数据只有 error 时按正文归类） */
  alert: Alert.optional(),
  /** 这次执行结束时写的状态说明（已暂停、失败后可以重试）：继续执行时它已经不成立，会被去掉 */
  transient: z.boolean().optional(),
  /**
   * 计划启动时写进对话的那条提示（把计划输入又抄了一遍）：对话流里不画出来，
   * 但数据照旧保留，历史任务、导出和继续执行都读得到
   */
  planStart: z.boolean().optional(),
  bugReport: z.number().int().optional(), // Bug 诊断报告第几版（ADR 0045）：对话里画成可点开报告的一行
  learned: LearnedNote.optional(), // 学到经验的那条系统消息：对话里画成按条展示的卡片（旧消息没有，照旧一行字）
  /** 派出子角色的那条系统消息：派出的子角色（步骤 id），对话里在这里放可以展开的「子任务」卡片 */
  spawned: z.array(z.string()).optional(),
  /** panel 为 helpers 时：这次交回结果的是哪几个子任务（步骤 id）。旧数据没有，按正文的「### 」标题数 */
  results: z.array(z.string()).optional(),
  /** 面板推回的消息和父子对话之间的往来是哪一种（见 shared/panel-kind.ts）；用户、Agent 说的话没有 */
  panel: PanelKind.optional(),
  /**
   * panel 为 child / wrapup 时：是哪个子对话、上报时它处在哪个状态（见 shared/task.ts 的 ConvState）。
   * 父对话里画成一行「子对话状态」，点开看全文；旧数据没有这一项时按正文第一行显示
   */
  child: z.object({ id: z.string(), title: z.string().default(''), state: z.string().default('') }).optional(),
  /**
   * 子对话交回结果时面板自动画在父对话里的总结卡（见 shared/summary/card.ts 的 childSummaryCards）：
   * 标题就是子对话总结的「类型｜结论」，child 是点标题跳过去的子对话。父对话不再自己写这张卡。
   * 子对话没写总结时为空（旧数据也没有这一项），按没有卡片显示
   */
  summaryCards: z
    .array(z.object({ kind: z.string(), label: z.string(), title: z.string(), child: z.string() }))
    .optional(),
  /**
   * 子对话停下时独立分支里还有没提交的改动（见 server 的 stopWorktreeNote）：父对话里那一行直接写
   * 「N 个文件未提交」并给「继续」，不用点开才知道改动在哪个目录、还有几个文件
   */
  worktree: z.object({ dirty: z.number(), path: z.string(), branch: z.string().default('') }).optional(),
  /**
   * 另一个对话发来的消息（父对话交代的任务、子对话的状态上报、收尾请求、编译结果、传话……）：
   * 不当成用户说的话，界面上统一画成一行「接收消息 · 已收到 X 发来的消息」，点开看全文。
   * 交给 CLI 的内容不变（父对话交代的任务 role 仍是 user，轮次、回退照旧按它算）
   */
  peer: PeerFrom.optional(),
  /** panel 为 ask 时：哪个子对话问的、问了什么、可选的做法，以及谁怎么回答的 */
  ask: z
    .object({
      from: z.string(),
      title: z.string().default(''),
      question: z.string().default(''),
      options: z.array(z.string()).default([]),
      /** question：执行中需要拍板的问题；suggestion：这一轮做完的收尾建议，等用户选下一步怎么做 */
      kind: AskKind.default('question'),
      answer: z.string().optional(),
      /** user：用户在卡片上回答；parent：父对话的 AI 交给了这个子对话 */
      by: z.enum(['user', 'parent']).optional(),
      /** 用户点了选择窗口的关闭：没回答，子对话终止了 */
      declined: z.boolean().optional(),
      /** 用户没回答，交给父对话的 AI 决定：卡片显示「交给父对话决定」，子对话不再弹选择 */
      delegated: z.boolean().optional(),
      /** 成功叫起父对话的时间：重复点「交给父对话决定」时据此判断要不要再叫一次（失败时为空） */
      delegatedAt: z.string().optional(),
      /** 上次没能叫起父对话的原因：卡片上显示给用户并给重试，刷新后也还在 */
      delegatedError: z.string().optional(),
    })
    .optional(),
  /** 系统消息是用户对 Agent 提问的回答：在对话正文里像用户消息一样显示每个问题和答案 */
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  /** 对话里用户消息对应的 CLI 那一轮：分叉、撤回时让 CLI 从这一轮截断会话 */
  turn: z
    .object({
      session: z.string(),
      /** Codex 的 turn id；Pi 是这一轮用户消息的 entryId（分叉到它之前） */
      id: z.string().default(''),
      /** Claude Code 这一轮最后一条回复的 uuid（--resume-session-at 用） */
      end: z.string().default(''),
    })
    .optional(),
  /** 对话里这条回复用的 CLI、模型和思考强度：对话中途可以换，每条记自己的 */
  run: z.object({ cli: z.string(), model: z.string().default(''), effort: z.string().default('') }).optional(),
  /** 这条是一轮的总结时，这一轮改了哪些文件（只在 git 仓库里记） */
  turnChanges: TurnChanges.optional(),
  at: z.string(),
})
export type TaskMessage = z.infer<typeof TaskMessage>

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])
export type StepStatus = z.infer<typeof StepStatus>

/**
 * 任务里执行过（或将要执行）的一个节点。主流程的节点在任务创建时就列出来；
 * 节点的开始 / 验收 / 结束流程、流程节点里的子节点在执行时才加进来，用 parentId 挂在发起它的节点下。
 */

/** 节点的用量：最近一次的上下文占用，以及累计的 token 和费用 */
export const StepUsage = z.object({
  context: z.number().default(0),
  window: z.number().default(0),
  model: z.string().default(''),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  costUsd: z.number().default(0),
})
export type StepUsage = z.infer<typeof StepUsage>

/**
 * 在排队等 API 的并发名额（API 设置里的并发上限满了）：api 是 API 名称，ahead 是前面还排着几个。
 * reason 区分这次拿名额的性质：'start' 是这一轮还没开始（真的在排队等名额），
 * 'yield' 是这一轮已经跑起来、临时让出（等子任务 / 等下一句）后拿回。两者不能显示成同一句话：
 * 让出期间 CLI 往往还在出 token，显示「排队等名额 · 下一个就是这里」会和实时速度自相矛盾。
 */
export const ApiWait = z.object({
  api: z.string(),
  ahead: z.number().int().default(0),
  /** 旧快照里没有这个字段，当时的标记都是开始前排队，按 'start' 算 */
  reason: z.enum(['start', 'yield']).default('start'),
})
export type ApiWait = z.infer<typeof ApiWait>

export const TaskStep = z.object({
  /** 路径形式的唯一 id，也是 CLI 会话键：主流程节点就是节点 id，子节点形如 `n1/review.2/n5` */
  id: z.string(),
  parentId: z.string().default(''),
  /**
   * 在父节点里的位置：start / review / end 是三个入口，body 是流程节点执行的流程，
   * step 是节点里按顺序执行的一步，sub 是节点执行中自己派出的子 Agent，
   * call 是主 Agent 评估时委派的另一个工作流
   */
  slot: z.enum(['', 'start', 'review', 'end', 'body', 'step', 'sub', 'call']).default(''),
  /** 验收的第几轮（从 1 开始）；不是验收流程里的节点为 0 */
  round: z.number().int().default(0),
  workflowId: z.string().default(''),
  flowId: z.string().default(''),
  nodeId: z.string().default(''),
  /** main：一个工作流这次执行的主 Agent（调度、评估子 Agent 的结果、整理最终结果），id 以 @main 结尾 */
  kind: z.enum(['agent', 'flow', 'main']).default('agent'),
  title: z.string(),
  agentId: z.string().default(''),
  status: StepStatus.default('pending'),
  startedAt: z.string().default(''),
  endedAt: z.string().default(''),
  /** 之前几次被停止、打断时已经执行的时间（毫秒）；续接时接着累加，重新执行时清零 */
  spentMs: z.number().default(0),
  /** 等用户确认、回答问题的时间（毫秒），含在执行时间里；waitStartedAt 是正在等的开始时间 */
  waitMs: z.number().default(0),
  waitStartedAt: z.string().default(''),
  /** 节点的最终输出（交给下游节点），续跑时直接复用 */
  output: z.string().default(''),
  /** 验收结果；节点上记录最后一轮的结论 */
  verdict: z.enum(['', 'pass', 'fail']).default(''),
  /** 已经验收了几轮 */
  rounds: z.number().int().default(0),
  /**
   * 这个节点又跑了一遍的次数：上一次跑完（不是被打断续接）之后重新执行才算，用于报告里的「返工」。
   * 重新执行时 rounds 会清零，以前看不出来节点其实已经跑过一遍了（报告写「返工 0 次」）
   */
  reruns: z.number().int().default(0),
  /** 验收不通过、带着意见重做过的次数：同样清零不得，只能单独累加 */
  reviews: z.number().int().default(0),
  /** 节点自己给出的结论（有条件连线时要求写）：决定走哪条线 */
  branch: z.enum(['', 'pass', 'fail']).optional(),
  /** Agent 用 submit_verdict / submit_result 交的结论和结果：状态只认它，不看回复文字（见 shared/submitted.ts） */
  submitted: Submitted.optional(),
  /** 执行到一半被停止或面板重启打断；继续执行时续接这个节点的 CLI 会话，从中断的地方接着做 */
  interrupted: z.boolean().default(false),
  awaitConfirm: z.boolean().optional(), // 做完了、停在等用户确认：继续时直接回到确认，不重跑节点
  /** 子任务 / 节点在排队等 API 的并发名额；拿到就去掉 */
  apiWait: ApiWait.optional(),
  /**
   * 子任务接着哪个 CLI 会话跑（task.sessions 的键）：spawn_agents 带 resume 时是被接着的那个子任务的会话，
   * 复看的评审不用把文档和代码从头再读一遍。空的就用自己的 id（旧数据和新开的子任务都是这样）
   */
  session: z.string().default(''),
  /** 评审开始时工作区的快照（git 树）：接着这个会话复看时，只把这之后的增量交给评审（见 EngineHost.reviewDiff） */
  snapshot: z.string().default(''),
  /** 最近一次启动这个节点的 Agent 用的命令（可执行文件和参数），方便复制出来排查问题 */
  command: z.array(z.string()).default([]),
  /**
   * 派这个子任务时交给它的要求原文（spawn_agents 的 instructions）。父对话的那条系统消息里只有标题列表，AI 分析时判断「它有没有做到派给它的要求」只能靠这段；旧记录没有这个字段，报告里如实说明看不到
   */
  brief: z.string().default(''),
  /** 派这个子任务时点的角色参数（spawn_agents 的 params），resume 接着做时沿用；旧记录没有，按角色默认值渲染 */
  params: z.record(z.string(), ParamValue).optional(),
  /** 这个节点自己的用量（不含子节点）：右栏点了节点时只看它的 */
  usage: StepUsage.optional(),
  /** 这个节点执行期间改动的文件 */
  changes: z.array(FileChange).default([]),
  /** 第几次工作流运行（从 1 开始）：同一个对话里工作流可以按顺序跑多次，每次的节点互相隔离 */
  runId: z.number().int().default(1),
})
export type TaskStep = z.infer<typeof TaskStep>

export const TaskStatus = z.enum(['running', 'done', 'failed', 'stopped'])
export type TaskStatus = z.infer<typeof TaskStatus>

// 停止原因拆到 stop-reason.ts（这个文件到了行数上限），这里照旧导出
export { StopReason } from './stop-reason.ts'

/**
 * 一轮（TaskTurn）是怎么结束的：只有 done 是正常结束，其余几种在报告里分开写，
 * 以前把它们混成「N 轮没有正常结束」，看不出是被新消息接管、用户停的还是面板收掉的。
 * 旧记录没有这个字段，按 unknown 算，不要默认成 failed
 */
export const TurnEnd = z.enum([
  'done', // 正常结束
  'supersede', // 用户发了新消息，这一轮被接管
  'user', // 用户点了暂停
  'failed', // 执行失败
  'panel', // 面板顺带结束的：父对话收尾、页面切走、闲置回收、归档、重启、换 CLI、CLI 没响应
])
export type TurnEnd = z.infer<typeof TurnEnd>

/** 不属于流程节点的一轮执行：工作流跑完后的追加要求、对话的每一轮。任务进度里一轮一行，带耗时和用量 */
export const TurnSources = z.object({
  rules: z.number().default(0),
  user: z.number().default(0),
  results: z.number().default(0),
  tools: z.number().default(0),
  setup: z.number().default(0),
})
export type TurnSources = z.infer<typeof TurnSources>

export const TaskTurn = z.object({
  id: z.string(),
  /** 这一轮要求的第一行（截短） */
  title: z.string(),
  agentId: z.string().default(''),
  status: TaskStatus,
  startedAt: z.string(),
  endedAt: z.string().default(''),
  /** 开始时任务的累计用量和等待时间：这一轮的用量 = 结束时（执行中是现在）减去它 */
  from: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    waitMs: z.number(),
  }),
  /** 怎么结束的：旧记录没有这个字段，按原因没记录处理（见 TurnEnd） */
  end: TurnEnd.optional(),
  /** 结束时算好的这一轮用量和等待时间 */
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  waitMs: z.number().default(0),
  /**
   * 这一轮交给 Agent 的内容按来源的字数（估算，不是 token）：面板规则、消息、子任务和计划交回的结果、
   * 工具输出、新会话开头的角色设定和项目教训。用来看 token 花在了哪；旧记录没有
   */
  sources: TurnSources.optional(),
})
export type TaskTurn = z.infer<typeof TaskTurn>

export const AgentUsage = z.object({
  context: z.number(),
  window: z.number(),
  model: z.string().default(''),
  /** 正在输出时的速度（token/秒），没在输出时为 0 */
  tps: z.number().default(0),
  /** 这一轮最后一次的输出速度：没有输出时接着显示它，刚开始是 0 */
  lastTps: z.number().default(0),
  /** 这个 Agent 累计输出的 token 和花在生成上的时间，用来算平均速度 */
  outputTokens: z.number().default(0),
  genMs: z.number().default(0),
  /** 面板交给这个会话的内容（面板工具、追加的系统提示词）：会话栏的上下文细分用；旧记录没有 */
  parts: ContextParts.optional(),
  /** CLI 自己报的上下文细分（Claude Code 每轮结束时要一次）：会话栏优先用它；报不出来的 CLI 没有 */
  snapshot: ContextSnapshot.optional(),
  /** 模型首包的记录（见 shared/first-token.ts）；旧记录没有 */
  firstToken: FirstTokenStats.optional(),
})
export type AgentUsage = z.infer<typeof AgentUsage>

export const TaskTodo = z.object({
  text: z.string(),
  status: z.enum(['pending', 'running', 'done']),
  agentId: z.string().default(''),
})
export type TaskTodo = z.infer<typeof TaskTodo>

/**
 * 这次任务里跑过的项目测试步骤和它们的真实耗时（见 ADR 0018）。
 * 数据只从后台命令取（命令开跑 / 结束的时间），不靠 Agent 自报；收尾总结里的耗时表按它算。
 * 同一条步骤 + 同一个执行方只留最后一次：失败重跑后总结显示最后那次的耗时，tries 说跑了多少次
 */
export const TaskTestRun = z.object({
  /** 项目测试步骤的 id（任务里的快照）；按命令能认出是哪条步骤时才记 */
  stepId: z.string().default(''),
  stepName: z.string().default(''),
  /** 谁跑的：父对话（范围为 parent 的步骤）/ 子对话自己 */
  by: z.enum(['parent', 'self']).catch('self').default('self'),
  ok: z.boolean().default(false),
  /** 耗时（毫秒）：按后台命令的真实开始 / 结束时间算 */
  durationMs: z.number().int().min(0).default(0),
  /** 第几次跑这条，失败重跑会累加；记录本身只留最后一次 */
  tries: z.number().int().min(1).default(1),
  at: z.string().default(''),
})
export type TaskTestRun = z.infer<typeof TaskTestRun>

// 执行计划的结构拆到 plan-schema.ts（这个文件到了行数上限），从这里引用的地方不用改
export { PlanStatus, PlanWait, PlanItem, PlanStep, TaskPlan }

// 请求和问题的结构拆到 task-request.ts（这个文件到了行数上限），从这里引用的地方不用改
export { AskQuestion, TaskRequest }

/** 运行级共享状态的一个键：并发节点都能读写，后写的覆盖先写的，版本号用来判断谁更新 */
export const RunStateEntry = z.object({
  value: z.string().max(20000),
  version: z.number().int().min(1).default(1),
  /** 最后写这个键的节点 id */
  by: z.string().default(''),
  at: z.string().default(''),
})
export type RunStateEntry = z.infer<typeof RunStateEntry>

/** 一次运行里节点之间发的消息：并发节点靠它传话 */
export const RunMessage = z.object({
  id: z.string(),
  from: z.string().default(''),
  to: z.string().default(''),
  text: z.string().max(20000),
  /** 收件人已经取走：历史留在运行记录里，但不再重复交给节点 */
  read: z.boolean().default(false),
  at: z.string(),
})
export type RunMessage = z.infer<typeof RunMessage>

/** 一次工作流运行：每次一份独立的工作流快照、共享状态和消息；节点在 task.steps 里，用 runId 和这里对应 */
export const TaskRun = z.object({
  /** 第几次运行，从 1 开始 */
  id: z.number().int(),
  workflowId: z.string().default(''),
  workflowName: z.string().default(''),
  /** 这次运行用的工作流快照（连同引用的其他工作流） */
  workflows: z.array(Workflow).default([]),
  skillSlots: z.record(z.string(), z.string()).default({}),
  status: TaskStatus.default('running'),
  startedAt: z.string().default(''),
  endedAt: z.string().default(''),
  /** 并发节点共享的键值状态 */
  state: z.record(z.string(), RunStateEntry).default({}),
  /** 节点之间的消息 */
  messages: z.array(RunMessage).default([]),
})
export type TaskRun = z.infer<typeof TaskRun>

/** 界面上显示的一条后台命令（server/background.ts 的 BgJob 去掉输出） */
export const TaskJob = z.object({
  id: z.string(),
  /**
   * 发起它的子任务步骤（TaskStep.id）：运行区据此把子任务的后台命令按「子任务 + 命令名」列出。
   * 可选：父对话自己起的、以及这次改动之前存下的记录都没有这个字段
   */
  step: z.string().optional(),
  name: z.string(),
  command: z.string(),
  state: z.enum(['queued', 'running']),
  /** 开始跑的时间；排队中为空 */
  startedAt: z.string().default(''),
  /** 常驻服务（开发服务器、监听）：运行区照样列出、能停掉，但对话不算在等它的结果（server/background.ts 的 awaitedJob） */
  service: z.boolean().optional(),
})
export type TaskJob = z.infer<typeof TaskJob>

/**
 * 一条后台命令的当前样子（界面上点命令行打开的窗口用它轮询）：
 * 在跑的时候要给得出已经输出的内容，跑完了也要还能读到最终输出和退出码——用户可能过一阵才点开。
 * 和 TaskJob 分开：TaskJob 只列还在跑的（运行区那一行），这个带输出和终态
 */
export const TaskJobView = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed', 'stopped']),
  /** 退出码：还在跑、排队中为空 */
  code: z.number().nullable(),
  /** 已经输出的内容（只留结尾，见 server/background.ts 的 KEEP_LINES） */
  output: z.string(),
  /** 交给面板的时间：排队也算在等结果的时间里 */
  createdAt: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** 最后一次有输出的时间：界面上「多久没动静」看它 */
  lastOutputAt: z.string(),
})
export type TaskJobView = z.infer<typeof TaskJobView>

export const TaskData = z.object({
  projectId: z.string(),
  title: z.string(),
  /** 标题还是从第一条消息截的：AI 第一次回复后按对话内容起一个标题换上，只做一次；用户改过名就不再换 */
  autoTitle: z.boolean().default(false),
  mode: TaskMode,
  /** 子对话的父对话 id；空表示项目里的顶层对话 */
  parentTaskId: z.string().default(''),
  /** 顶层对话的 id：子对话从哪个项目对话分出来的；顶层对话自己为空 */
  rootTaskId: z.string().default(''),
  /** 子对话请父对话收尾的记录（ADR 0005，见 wrap-request-schema.ts） */
  wrapRequest: WrapRequest.optional(),
  buildAsk: BuildAsk.optional(), // UE 子对话申请的编译和结果（见 build-ask.ts），结果按它推回子对话
  /**
   * 子对话的交接摘要（见 ADR 0007）：submit_merge 时按模板写的关键信息加上面板补的 git 事实。
   * 完成后再被叫醒、上下文又大时，开新会话只带它，不把上次的工具输出全带进去
   */
  handoff: z.object({ text: z.string(), files: z.string().default(''), at: z.string() }).optional(),
  /**
   * 评审门禁的显式放行记录（见 shared/review/gate.ts）：评审没过而用户明确要求「已知问题也合并」时，
   * 面板记下谁、什么时候、为什么、原本拦住什么。收尾消息和交接摘要里一并带给父对话，任务详情里也能看到
   */
  reviewOverride: z
    .object({
      by: z.enum(['user', 'parent']),
      /** 面板接收 submit_merge 时记的时间，不用调用方自报的 */
      at: z.string(),
      reason: z.string(),
      /** 原本拦住的那条门禁原因（一句话） */
      blocked: z.string(),
    })
    .optional(),
  /** 子对话的摘要：最近一条回复的开头，协调 Agent 判断关联强度时看它 */
  summary: z.string().default(''),
  /**
   * 父对话发布的全局规则（输入「/rule 内容」）：名下所有子对话和它们的工作流节点都必须遵守。
   * 只对这个对话有效，不写进项目的 AGENTS.md
   */
  rules: z.array(TaskRule).default([]),
  /** 父对话的目标：用户在对话设置里写的，父对话和名下子对话每一轮都看得到，判断要不要做、做到哪一步 */
  goal: z.string().max(4000).default(''),
  /** 父对话给子对话定的 CLI、模型和思考强度；空表示按执行角色自己的配置 */
  childRun: z.object({ cli: z.string(), model: z.string(), effort: z.string() }).optional(),
  /** 子对话发给父对话、父对话还没读到的消息：父对话下一轮开始时交给它，读完清空 */
  inbox: z
    .array(
      z.object({
        from: z.string(),
        title: z.string(),
        text: z.string(),
        at: z.string(),
        /** 对话里对应的那条消息：同一个子对话的新汇报替换掉没读的旧汇报时，旧的那行标成「已被取代」 */
        mid: z.string().optional(),
        /** 子对话的汇报（不是提问、回答）：只有它会被同一个子对话更新的汇报替换 */
        report: z.boolean().optional(),
      }),
    )
    .default([]),
  /**
   * 子对话：这一轮 AI 自己用 message_parent 写的阶段汇报，还没交给父对话。
   * 一轮只交一封（ADR 0034）：面板这一轮结束上报状态时把它并进去当「结果」，交出后清空
   */
  pendingReport: z.string().optional(),
  /** 子对话：用户直接在子对话里交代的要求（最近一条）。不再给父对话单独发消息，下一封汇报里带上，交出后清空 */
  userDirect: z.string().optional(),
  /**
   * 子对话：请用户决定、还没人回答的提问（父对话里也有一张对应的卡片，id 是那条消息的 id）。
   * 有它时子对话的输入框换成选择弹窗；回答、交给父对话决定或父对话转达了决定后清掉
   */
  parentAsks: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()).default([]),
        /** 见 TaskMessage.ask.kind：收尾建议和提问共用这套弹窗，只是说法不同 */
        kind: AskKind.default('question'),
      }),
    )
    .optional(),
  workflowId: z.string().default(''),
  agentId: z.string().default(''),
  /** 对话时给默认 Agent 选的 CLI、模型和思考强度，继续对话也用它 */
  cli: z.string().default(''),
  model: z.string().default(''),
  effort: z.string().default(''),
  modelOverride: ModelOverride.optional(), // 用角色的对话里用户换的模型，盖过角色的；见 task-run.ts 的 withTaskModel
  /** 「提问」开关：打开时 Agent 的提问交给用户回答，关着时让它自己选最合适的做法 */
  askUser: z.boolean().default(false),
  /**
   * 「子对话也提问」：这条父对话下新建的子对话默认是否开启提问，右键菜单里改。
   * 父对话关掉提问时已有子对话一起关，这个字段不变，所以重新打开父对话后菜单项又回到勾选
   */
  childAskUser: z.boolean().default(true),
  /** AI 分析开出的对话：哪种分析（见 AnalysisKind）；普通对话没有 */
  analysis: AnalysisKind.optional(),
  /** AI 分析开出的对话：分析的是哪个对话（「在当前对话里修」发回它）；旧数据、和对话无关的分析没有 */
  analysisOf: z.string().optional(),
  /** 归哪个插件的设计模式（插件网页部分登记的 id，例如 blender.model；ADR 0059），普通对话不填，读法见 taskPlugin */
  plugin: z.string().optional(),
  /** 旧版的模型设计对话（ADR 0025，现在是 Blender 插件的 blender.model），只读不写 */
  modelDesign: z.boolean().optional(),
  /** 对话时 Agent 参数的值 */
  params: z.record(z.string(), ParamValue).default({}),
  status: TaskStatus,
  /** 停下来的原因：只有 'user' 是用户按的暂停，其余几种界面要写清是谁结束的（见 StopReason） */
  stopReason: StopReason.optional(),
  /** 顶层对话的用量上限提醒到了哪一级（warn 提醒过、over 停过）：同一级只说一次；调高上限后跟着回落 */
  budgetNotice: z.enum(['warn', 'over']).optional(),
  /** 累计执行时间（毫秒），不含等用户继续对话的空闲时间 */
  runMs: z.number().default(0),
  /** 这一轮开始执行的时间；没在执行时为空 */
  runStartedAt: z.string().default(''),
  /** 等用户确认、回答问题的累计时间（毫秒），含在 runMs 里；waitStartedAt 是正在等的开始时间 */
  waitMs: z.number().default(0),
  waitStartedAt: z.string().default(''),
  /**
   * 答完后停在等用户下一句的累计时间（毫秒）：这段不在 runMs 里，也不算进 waitMs（等你确认/提问）。
   * 两种等待混在一个数里时，报告会写出「执行 8m（其中等你处理 23h55m）」这种装不下的数
   */
  idleWaitMs: z.number().default(0),
  /** 正在等下一句的开始时间；没在等时为空 */
  idleWaitAt: z.string().default(''),
  /** 追加要求、对话的每一轮，按时间顺序 */
  turns: z.array(TaskTurn).default([]),
  /** 所有节点：主流程的节点按执行顺序排在前面，执行中产生的子节点追加在后面 */
  steps: z.array(TaskStep).default([]),
  messages: z.array(TaskMessage).default([]),
  changes: z.array(FileChange).default([]),
  /**
   * 项目根之外、这个对话的 Agent 写出过的文件（CLI 写文件事件报的路径，存绝对路径）。
   * 面板自己的产物在收集时排除：数据目录里的附件、对话目录的截图 / 临时文件、任务交接和系统临时目录
   * （见 server/own-changes.ts 的 outsideFiles）。没有 git 快照，只能列出来看，不算进 changes
   */
  outsideChanges: z.array(OutsideChange).default([]),
  /** 在线演示里的任务，输出是示例 */
  simulated: z.boolean().default(true),
  /** CLI 会话 id，用于续接：工作流节点按节点 id 记，对话和追加要求按 Agent id 记 */
  sessions: z.record(z.string(), z.string()).default({}),
  /**
   * 每个会话最后一次带上的角色设定的指纹（键同 sessions）：没有系统提示词参数的 CLI 只在第一轮带角色，
   * 续接时角色变了就补发新版（见 server/exec/runner.ts）
   */
  roleHashes: z.record(z.string(), z.string()).optional(),
  /**
   * 每个会话已经收到过的提示词段落指纹（键同 sessions，见 shared/prompt/delta.ts）：续接时只发新的和变了的段落。
   * 会话换了、压缩过就作废（runner 在压缩时删掉）
   */
  promptSent: z
    .record(
      z.string(),
      z.object({ session: z.string(), hashes: z.record(z.string(), z.string()), turns: z.number().default(0) }),
    )
    .optional(),
  /** 对话的会话是哪个 CLI 的：对话中途换了 CLI 时，下一轮开新会话，把之前的对话带过去 */
  sessionCli: z.string().optional(),
  /** 对话的会话是在哪个目录里开的：改文件前开了独立分支、换了目录时，下一轮开新会话，把之前的对话带过去 */
  sessionDir: z.string().optional(),
  /**
   * 每个会话是在哪个目录里开的（键同 sessions）：CLI 的会话按目录存，在别的目录里续接时找不到。
   * 子任务接着上一轮做时最容易撞上（父对话中途开了独立分支，子任务的会话还留在原目录）。
   * 不先看这里，Pi 会去全局找会话，找到别的项目的后停下来问要不要分叉，非交互模式直接按 Aborted 退出
   */
  sessionDirs: z.record(z.string(), z.string()).default({}),
  /**
   * 要改文件时才开独立分支：对话先在原目录里看代码、回答问题，
   * 真要改文件时调用 begin_edit，面板这时才建 worktree，再在里面接着做（能跨目录续接的 CLI 续接原会话，其余开新会话）
   */
  wantsWorktree: z.boolean().default(false),
  /** 父对话派单时说了要改代码（create_conversation 的 edits）：第一次执行前就开好独立分支，不中途换目录重开 */
  editFirst: z.boolean().optional(),
  /**
   * 排在哪些兄弟子对话之后（create_conversation 的 after，见 shared/children/after.ts）：建好后停在 stopReason 'after'，
   * 这些子对话都合回或完成后面板自动启动它，启动时清掉
   */
  waitAfter: z.array(z.string()).optional(),
  /** 改动合回父对话所在的分支（共用目录是父对话验收）的时间：排在它后面的子对话按它判断能不能开始 */
  mergedAt: z.string().optional(),
  /**
   * 对话分叉或撤回后，下一轮从哪里接着：session 里保留到 through 这一轮（含），之后的丢掉；
   * through 为空表示一轮都不留，开新会话。CLI 不能截断会话时，把留下的对话整理成文字带给新会话
   */
  rewind: z
    .object({
      session: z.string(),
      through: z.object({ session: z.string(), id: z.string().default(''), end: z.string().default('') }).nullable(),
      /** 要丢掉的第一轮（只能分叉到某一轮之前的 CLI 用它的 id，例如 Pi）；没有丢掉的轮次时为空 */
      cut: z
        .object({ session: z.string(), id: z.string().default(''), end: z.string().default('') })
        .nullable()
        .optional(),
      /** through 是不是这个会话的最后一轮（Command Code 只能从最后分叉） */
      latest: z.boolean().default(false),
      /** 压缩上下文时 CLI 写的摘要（不能压缩会话的 CLI 开新会话时带上） */
      summary: z.string().optional(),
    })
    .optional(),
  /** 不属于节点的调用（对话、追加要求）最近一次启动 Agent 用的命令 */
  command: z.array(z.string()).default([]),
  /** 用量：每个 Agent 最近一次的上下文占用和实时速度，以及累计 token 和费用 */
  usage: z
    .object({
      agents: z.record(z.string(), AgentUsage).default({}),
      /** 输入 token（含缓存命中和缓存写入的部分） */
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      /** 输入里命中缓存的部分 */
      cacheReadTokens: z.number().default(0),
      /** 输入里写入缓存的部分 */
      cacheWriteTokens: z.number().default(0),
      costUsd: z.number().default(0),
    })
    .default({ agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }),
  /** CLI 维护的待办清单（Claude Code 的 TodoWrite、Codex 的计划），对话任务的进度看它 */
  todos: z.array(TaskTodo).default([]),
  /** 对话的执行计划：最后一份没完成的是当前计划，之前的连同总结留着看 */
  plans: z.array(TaskPlan).default([]),
  /** Agent 用 end_turn 交代的结束（最近的在最后，只留最近 50 条），见 shared/turn-end.ts */
  turnEnds: z.array(EndTurnRecord).optional(),
  ...TaskRuntimeFields,
  /** 任务开始时项目里已有的未提交改动（git numstat），统计改动时排除 */
  baseline: z.record(z.string(), z.string()).default({}),
  /** 任务创建时的工作流（连同引用的其他工作流）；之后改动、删除工作流不影响这个任务。旧任务没有 */
  workflows: z.array(Workflow).default([]),
  /** 历次工作流运行：每次一份工作流快照、共享状态和节点消息。旧任务没有 */
  runs: z.array(TaskRun).default([]),
  /** 技能槽取值（工作流 expose 里 target=skill 的项，Agent 的 skills 写 `{{槽名}}`）：和工作流快照一起定下来 */
  skillSlots: z.record(z.string(), z.string()).default({}),
  /**
   * 工作流任务新建时、以及「继续流程」时把项目里的测试步骤写一份进任务（纯对话任务为空）。
   * 执行时以项目当前设置为准，见 shared/test-steps.ts 的 currentTestSteps：拼提示词拿不到项目时整段验证说明
   * 都不注入（不会退回这份快照）；只有「谁跑这些步骤 / 匹配耗时」这几条在项目读不到时用它兜底。
   */
  testSteps: z.array(TestStep).default([]),
  /** 这次任务里跑过的测试步骤耗时（见 ADR 0018）：子对话自己的后台命令和父对话跑的步骤都记在这里 */
  testRuns: z.array(TaskTestRun).default([]),
  /** 新建对话时面板所在系统（windows / linux / darwin）：决定标了 wsl 的步骤怎么执行 */
  platform: z.string().default(''),
  /** 工作流的名字，列表里显示（摘要不带上面的完整工作流） */
  workflowName: z.string().default(''),
  /** 任务开始时的提交（git 仓库才有）；统计改动和看差异都和它比，Agent 中途提交了也不丢 */
  baseRef: z.string().default(''),
  /**
   * 面板拷进对话目录的图片：消息里记的源文件绝对路径 → 对话目录 attachments/ 里的绝对路径。
   * 再次执行时按它复用同一份拷贝。旧任务的值是任务工作目录里的相对文件名，仍照旧复用；
   * 统计 git 改动时只把旧任务这种可能落在工作目录里的值交给排除名单（不靠文件名猜）。
   */
  placedAttachments: z.record(z.string(), z.string()).default({}),
  /** 正在等用户确认的请求 */
  requests: z.array(TaskRequest).default([]),
  /** 审批卡上点过「一直允许」的规则键（shared/allow-rules.ts）：同一个对话里同类请求自动允许 */
  allowRules: z.array(z.string()).default([]),
  /** 独立分支执行时的工作目录和分支；直接在项目目录执行时为空 */
  worktree: TaskWorktree.nullable().default(null),
  /**
   * 父对话进行中的就地微改动（shared/inline-edit.ts）：声明的文件、理由和开始时的工作区基线。
   * 结束时清掉（写 undefined）；进行中父对话不能收尾子对话
   */
  inlineEdit: z
    .object({
      files: z.array(z.string()).max(20),
      reason: z.string().max(500),
      startedAt: z.string(),
      head: z.string().default(''),
      baseline: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  /** 父对话的分诊记录：每次派单 / 交回 / 派子任务 / 就地改动时的理解、理由和假设，界面画成分诊卡 */
  routes: z.array(TaskRoute).max(500).default([]),
  /** 这一轮开始时的累计用量：预算上限按每次执行算，继续执行就重新给一份额度 */
  budgetFrom: z
    .object({
      usd: z.number(),
      tokens: z.number(),
      /** 这一轮开始的时刻（epoch ms）：时长上限从它算起；旧记录没有，时长上限按不限处理 */
      at: z.number().optional(),
    })
    .optional(),
  /** 执行上限（定时计划带的）：token 上限和时长上限（分钟），0 表示不限 */
  budgetTokens: z.number().int().min(0).max(MAX_TASK_BUDGET_TOKENS).default(0),
  budgetMinutes: z.number().int().min(0).max(MAX_TASK_BUDGET_MINUTES).default(0),
  /** CLI 正在处理一轮：预热、等下一句、进程只是活着时都是 false */
  working: z.boolean().default(false),
  /** 模型正在写一个工具调用的入参（写大段报告、大文件时要一二十秒）：哪个工具、从什么时候开始。不存盘意义不大，调用到了就去掉 */
  drafting: z.object({ tool: z.string(), at: z.string() }).optional(),
  /**
   * 对话停止（用户暂停、父对话结束时一起结束、归档）时被连带停掉的后台命令：存盘，
   * 下次继续时写进续接说明，让 Agent 知道哪些命令没跑完、要不要重新启动；续接后清空
   */
  stoppedJobs: z.array(z.object({ name: z.string(), command: z.string() })).optional(),
  /** CLI 最近一次完成一轮回复的时间：判断「完成但没看」用，和进程是否结束无关 */
  turnDoneAt: z.string().default(''),
  /**
   * 用户看过的最新一轮完成时间：和 turnDoneAt 相同时表示这一轮已经看过。
   * 侧栏的橙点就是「完成但没看」，服务端靠它判断还要不要留着 CLI 进程等下一句
   */
  turnSeenAt: z.string().default(''),
  /** CLI 回复完停在面板的 MCP 工具上，等用户在这个对话里的下一句 */
  awaitingUser: z.boolean().default(false),
  /** 对话页打开时在后台用 --resume 启动，还没等到下一句 */
  prewarming: z.boolean().default(false),
  /** 对话这一轮在排队等 API 的并发名额（仍算在运行，可以停止）；拿到就去掉 */
  apiWait: ApiWait.optional(),
  /**
   * 子对话这么久没有输出、面板以父对话的名义自动问过它状态（见 shared/task.ts 的 childIdleAsk）：
   * at 是最后一次询问的时间，count 是这一轮静默里问了几次。子对话有了新的输出就重新计数（不回写清零，
   * 判定时按 at 之后有没有输出算），这样界面能看出「问过、在等回复」
   */
  autoAsk: z
    .object({
      at: z.string(),
      count: z.number().int().min(0).default(0),
      /**
       * 这条询问没交出去（CLI 这一轮收不下，已经从队列和对话里撤掉）：算一次尝试、按阈值隔开再试，
       * 但不显示「等回复」，也不能让它在收尾时开新一轮
       */
      held: z.boolean().optional(),
    })
    .optional(),
  /** 归档：侧栏默认不显示，筛选「已归档」时才列出来；不删除任何内容 */
  archived: z.boolean().optional(),
  /** 置顶（Chat 页的聊天）：侧栏聊天列表最上面单独一组「置顶」，不影响排序时间；旧数据没有这一项，按没置顶算 */
  pinned: z.boolean().optional(),
  /**
   * 进回收站的时刻：删除只做标记，任务记录、对话内容、独立分支、附件、对话目录都先留着，
   * 超过保留期（见 shared/task.ts 的 TRASH_RETENTION_DAYS）才由清理任务物理删除。
   * 列表、计数、搜索一律按 taskGone / taskDeleted 排掉它，不在各处再写一次 `!deletedAt`
   */
  deletedAt: z.string().optional(),
  /**
   * 子对话已经解决：只用于标记（列表归到「已完成」并显示标记），不改 status、不停 CLI，
   * 父对话的等待逻辑和 childrenWorking 聚合都不看它
   */
  resolved: z.boolean().optional(),
  /** 用户最近一次发消息的时间：只在列表摘要里带（摘要去掉了消息），排序和显示用 askedAt() 取 */
  askedAt: z.string().optional(),
  /** 用户结束了工作流：没完成的节点不再执行，之后的要求由主 Agent 直接处理 */
  flowClosed: z.boolean().optional(),
  /**
   * 这个对话里用户对推送的授权：ask_push 弹的授权卡上点的（server/exec/panel-requests.ts 的 notePushAnswer 写入），
   * 问过一次就记住、不再重复问；remotePushAt 是点的时间，分叉、撤回到它之前时清掉（见 shared/push-auth.ts）
   */
  remotePush: z.enum(['allowed', 'denied']).optional(),
  remotePushAt: z.string().optional(),
  runSeq: z.number().int().default(0), // 已经跑了几次工作流：每次运行按顺序执行节点，运行之间互相隔离
  flowRun: FlowRun.optional(), // 工作流运行（不是子对话）：属于哪个父对话、阶段、决定记录，见 task-flow-schema.ts
  /** 用户报的 Bug 的全部数据（要交诊断报告还是直接修、诊断报告各版、档案、简报…），见 shared/bug/task-bug.ts；普通对话没有 */
  bug: TaskBug.optional(),
  userActions: z.array(UserAction).optional(), // 等你操作（request_user_action）：最近的在最后，见 shared/user-action.ts
  /** 从别人导出的文件导入的任务：只读，不能继续执行；agents 是导出时带来的 Agent，本机没有时用来显示名字 */
  imported: z
    .object({
      at: z.string(),
      exportedAt: z.string().default(''),
      app: z.string().default(''),
      agents: z.array(Agent).default([]),
    })
    .optional(),
})
export type TaskData = z.infer<typeof TaskData>

/** 旧任务：消息的节点下标换成节点 id；旧 queue 里没处理的普通要求补到对话末尾（等 CLI 取走的补充丢掉） */
function migrateTask(raw: unknown) {
  const v = moveSessions(dropLegacyAgent(raw))
  if (!v || typeof v !== 'object') return v
  const t = v as {
    steps?: { id?: string }[]
    messages?: { step?: unknown; at?: string }[]
    queue?: { id?: string; text?: unknown; attachments?: unknown; at?: unknown; note?: unknown }[]
  }
  const steps = (t.steps ?? []).map((s, i) => ({
    ...s,
    id: s.id ?? `s${i}`,
    nodeId: (s as any).nodeId ?? s.id ?? `s${i}`,
  }))
  const messages = (t.messages ?? []).map((m) =>
    typeof m.step === 'number' ? { ...m, step: m.step >= 0 ? (steps[m.step]?.id ?? '') : '' } : m,
  )
  const { queue, ...rest } = t
  if (!Array.isArray(queue) || !queue.length) return { ...rest, steps, messages }
  const now = new Date().toISOString()
  const moved = queue
    .filter((q) => q && q.note !== true && typeof q.text === 'string' && q.text.trim())
    .map((q, i) => ({
      id: typeof q.id === 'string' && q.id ? q.id : `q${i}`,
      role: 'user' as const,
      agentId: '',
      step: '',
      text: q.text as string,
      tools: [],
      ...(Array.isArray(q.attachments) && q.attachments.length ? { attachments: q.attachments } : {}),
      at: typeof q.at === 'string' && q.at ? q.at : now,
    }))
  return { ...rest, steps, messages: [...messages, ...moved] }
}

export const Task = z.preprocess(migrateTask, TaskData.extend(Meta.shape))
export type Task = z.infer<typeof TaskData> & z.infer<typeof Meta>

/** 回答 Agent 的请求：允许 / 拒绝，问题的回答（一次问了几个时每个一条） */
export const RequestAnswer = z.object({
  allow: z.boolean(),
  answer: z.string().max(20000).optional(),
  answers: z.array(z.string().max(20000)).max(20).optional(),
  /** 允许并且这个对话里一直允许这类（请求的 rule 记进 task.allowRules，见 shared/allow-rules.ts） */
  always: z.boolean().optional(),
  /** 工作流节点确认时只是追问（allow 为 false）：回答问题、不改结果，不算一轮修改（见 shared/flow/run.ts 的 noteConfirm） */
  ask: z.boolean().optional(),
})

/** 一个保存下来的账号 */
export const SavedAccount = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().default(''),
  savedAt: z.string(),
})
export type SavedAccount = z.infer<typeof SavedAccount>

/** 设置里「账号」页看到的一个 CLI 的登录状态 */
export interface CliAccounts {
  cli: string
  /** 这个 CLI 能不能在面板里登录（有登录命令） */
  canLogin: boolean
  /** 能不能用 API（定义里写了怎么交给它） */
  canApi: boolean
  /** 现在登录着的：没登录时 loggedIn 为 false */
  live: { loggedIn: boolean; email: string; label: string }
  /** 现在登录的账号还没保存下来（用「保存」存成一个账号后才能切回来） */
  unsaved: boolean
  /** 保存下来的账号；active 是现在用的那个 */
  accounts: (SavedAccount & { active: boolean })[]
}

/** 正在进行的登录 */
/** 一个提供方的凭据检查结果（CLI 定义里 auth.check 的输出） */
export interface ProviderAuthCheck {
  provider: string
  ready: boolean
  /** CLI 给的状态和原因，原样显示 */
  status: string
  reason?: string
  /** 就绪时的凭据类型，例如 oauth、api_key */
  authType?: string
}

export interface LoginJob {
  id: string
  cli: string
  status: 'running' | 'done' | 'failed'
  /** CLI 打印的登录网址（浏览器没自动打开时点这里） */
  url: string
  /** CLI 的输出（最后一部分）；要粘贴授权码时用来提示 */
  output: string
  error?: string
  startedAt: number
}
