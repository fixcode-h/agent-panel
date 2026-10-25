import { z } from 'zod'
import { ApiConfig } from './accounts.ts'
import { t } from './i18n.ts'
import { DEFAULT_PRICING_MODEL } from './pricing.ts'
import type { ProjectProposal } from './project-init.ts'

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
  enabled: z.boolean().default(true),
  /** 通用 Agent：工作流里任何 Agent 执行时都可以把子任务派给它（编排工具 spawn_agents 里列出来） */
  common: z.boolean().default(false),
  /** 可以创建子对话、把用户消息分派给子对话（只有项目顶层对话里生效，子对话不能再分派） */
  canDelegate: z.boolean().default(false),
  /** 可以按工作流启动计划（start_plan）；关掉时只能在当前对话里直接执行 */
  canPlan: z.boolean().default(false),
  /** 用户是否确认过能力开关：升级时为旧内置 Agent 补一次默认能力，之后不再覆盖用户的选择 */
  capsSet: z.boolean().default(false),
  /** 已经做过的一次性升级（见 shared/builtin/core.ts 的 DEFAULT_CHANGES）：做过的不再做，用户之后改回去的值不会被覆盖 */
  upgrades: z.array(z.string().max(80)).max(50).optional(),
  /** 从内置模板建出来的 Agent 记下来源（builtin:<key>），再次添加内置工作流时复用，不重复建 */
  origin: z.string().max(80).default(''),
})
export type AgentInput = z.infer<typeof AgentInput>

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

const AGENT_REF_KEYS = new Set(['agentId', 'mainAgentId', 'defaultAgentId'])

/**
 * 已经不存在的角色 id → 现在该用的 id（空字符串表示不用角色）。读旧数据时按它改写引用：
 * 默认 Agent 固定在这里；合并后被删掉的内置副本由服务端启动时登记（见 setAgentAliases）。
 */
const agentAliases = new Map<string, string>([[LEGACY_DEFAULT_AGENT_ID, '']])

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
 * 工作流：一个主 Agent 和若干子 Agent 组成团队，用流程图编排执行顺序。
 * 主 Agent 执行没指定 Agent 的节点，并在流程完成后处理用户的追加要求。
 */
const WorkflowFields = z.object({
  name: z.string().trim().min(1, t('名称不能为空')).max(40),
  description: z.string().trim().max(200).default(''),
  /** 主 Agent；为空表示还没选 */
  mainAgentId: z.string().default(''),
  /**
   * 主 Agent 调度：子 Agent 的节点完成后交给主 Agent 评估（通过、退回、委派其他工作流、停下），
   * 条件连线由主 Agent 选路，流程结束时主 Agent 整理最终结果。关掉（false）时按连线自动往下走；没写等于打开
   */
  dispatch: z.boolean().optional(),
  /** 主 Agent 调度时用默认 CLI 的哪一档；为空按 Agent 设的档位 */
  mainTier: NodeTier.optional(),
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
  /** 对外暴露的配置项：项目设置里按它渲染表单 */
  expose: z.array(WorkflowExpose).max(20).default([]),
  /** 每次执行的上限：花费（美元）、token（输入 + 输出）超过就暂停，免得验收来回循环一直烧钱；0 表示不限 */
  budgetUsd: z.number().min(0).max(100000).optional(),
  budgetTokens: z.number().int().min(0).optional(),
  /** 从内置模板建出来的工作流记下来源（builtin:<key>），内置工作流列表里据此显示「删除」 */
  origin: z.string().max(80).optional(),
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
 * 新建对话时整份步骤快照进任务，之后改项目设置不影响已经开始的对话。
 */
export const TEST_STEP_ENVS = ['auto', 'wsl', 'powershell', 'cmd', 'bash'] as const

/**
 * 文本文件的写法：编码（带不带 BOM）和换行符。
 * 项目在 Windows 上编辑、在 WSL / Linux 里跑脚本时，CRLF 和 BOM 会让 shebang 失效，
 * 所以默认 UTF-8 无 BOM + LF。
 */
export const FILE_FORMATS = ['utf8', 'utf8-bom'] as const
export const FILE_EOLS = ['lf', 'crlf'] as const
export const FileFormat = z.object({
  encoding: z.enum(FILE_FORMATS).catch('utf8').default('utf8'),
  eol: z.enum(FILE_EOLS).catch('lf').default('lf'),
})
export type FileFormat = z.infer<typeof FileFormat>
/** 没配置时用的格式：UTF-8 无 BOM、LF */
export const DEFAULT_FILE_FORMAT: FileFormat = { encoding: 'utf8', eol: 'lf' }

/**
 * 测试步骤的字段（不含 id）：AI 生成 / 补全步骤时整份沿用这里校验，
 * 新增字段只改这一处，避免提示词、AI 结果和保存校验三份定义走偏。
 */
export const TestStepFields = z.object({
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
   * 适用范围：本次改动的文件里至少要有一个匹配这些 glob，才跑这条步骤。
   * 空数组表示总是执行——老项目的步骤没有这个字段，解析上来是空数组，不会因为升级就漏跑。
   * 匹配算法只有一份（shared/test-steps.ts 的 matchesGlob / stepApplies）：界面输入用 parseGlobs、
   * 交给 Agent 的提示词用 appliesToText，单测钉住 stepApplies；实际比对由 Agent 按提示词里的
   * 改动清单做，执行流程里目前还没有按清单自动跳过的地方
   */
  appliesTo: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
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

export const TestStep = TestStepFields.extend({
  id: z.string().trim().min(1).max(40),
})
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
  /**
   * 按改动大小决定验证范围：小改动只跑快速检查就收尾，大改动跑完整的测试步骤。
   * 关掉时每次改动都跑完整步骤。旧项目也默认打开：小改动在没有标「小改动也跑」的合并步骤时仍跑全部合并步骤，不会少编译
   */
  scaledVerify: z.boolean().default(true),
  /** 项目教训：旧项目没有时是空数组 */
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
  /**
   * 子对话怎么避免互相干扰：
   * - worktree：Git 项目里每个子对话在自己的独立分支目录里改文件（只隔离编辑，不在里面编译）；
   *   改完提交编译，面板把它合回开分支的那个目录试编译，通过才提交、失败撤回并把报错交回子对话。
   *   不是 Git 仓库（P4、没有版本控制）时自动退回 claim
   * - claim：和父对话共用一个目录，改文件前认领（同一个文件同一时间只归一个子对话）
   */
  childIsolation: z.enum(['worktree', 'claim']).catch('worktree').default('worktree'),
  /** 新建对话时「独立分支」默认勾上（只是输入框里的默认值，每次新建仍可以改） */
  isolateDefault: z.boolean().default(false),
  /** 推送授权：ask 第一次需要推送时问一次，allow 直接推，deny 一律不推 */
  gitPolicy: z.enum(['ask', 'allow', 'deny']).default('ask'),
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
/** 一次最多附上的文件数 */
export const MAX_ATTACHMENTS = 10
/**
 * 上传一个附件最大多少（字节）。比设置里「大文件」小的才上传；大文件先在本机找回原路径直接引用，
 * 找不到时没超过这个上限的仍然上传一份
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
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
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS).default([]),
  /** chat 模式：Agent 参数的值（没给的用默认值） */
  params: z.record(z.string(), ParamValue).default({}),
  /**
   * 在独立分支（git worktree）里执行，不直接改项目目录；只有 git 仓库可以。
   * 只对项目里的顶层对话有效：子对话一律和父对话用同一个目录，不建独立分支（几个子对话同时改由文件认领协调）
   */
  isolate: z.boolean().optional(),
  /** 「提问」开关：Agent 的提问交给用户回答；关着时让它自己选 */
  askUser: z.boolean().default(false),
})
export type NewTaskInput = z.infer<typeof NewTaskInput>

/** 任务的独立分支：Agent 在这个目录里改，做完后合并回项目或丢弃 */
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

export const FollowUpInput = z.object({
  text: z.string().trim().min(1, t('内容不能为空')).max(20000),
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS).default([]),
  /** 任务正在执行时：true 先停下当前这一轮再发送；否则直接交给正在跑的 CLI，交不出去就这一轮结束后接着处理 */
  interrupt: z.boolean().default(false),
})
/** 父对话发布的一条全局规则 */
export const TaskRule = z.object({ id: z.string(), text: z.string().max(2000), at: z.string() })
export type TaskRule = z.infer<typeof TaskRule>

/** 可以直接修改的任务字段 */
export const TaskPatch = z
  .object({
    title: z.string().trim().min(1, t('标题不能为空')).max(80),
    archived: z.boolean(),
    // 子对话「解决」：只是标记，不动 status、不停进程，随时能再打开
    resolved: z.boolean(),
    // 对话用的 CLI、模型和思考强度，执行中也能改，下一轮生效
    cli: z.string().trim().max(40),
    model: z.string().trim().max(200),
    effort: z.string().trim().max(40),
    // 「提问」开关：Agent 有问题时交给你回答，还是让它自己选
    askUser: z.boolean(),
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
  'rate_limit', // 被限流、服务过载
  'auth', // 登录过期、密钥无效
  'quota', // 余额或额度用完
  'context', // 上下文超长
  'model', // 模型名不对、接口拒绝这次请求
  'cli_missing', // 找不到 CLI 命令
  'cli_exit', // CLI 没做完这一轮就退出、执行失败
  'no_response', // 交给 CLI 后迟迟没有任何输出
  'idle', // 执行中很久没有输出
  'timeout', // 超过单步时限被停掉
  'empty_turn', // 这一轮没有产出
  'retry', // CLI 自己在重试
  'delivery', // 面板没能把消息交给对话（后台结果、子对话上报）
  'worktree', // 独立分支建不起来、删不掉
  'panel', // 面板自己出错
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
  /** 这一行是报错或警告（CLI 的重试提示、面板的提醒）：画成带底色的警告行 */
  alert: Alert.optional(),
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
export const PeerKind = z.enum(['task', 'answer', 'question', 'report', 'wrapup', 'merge', 'build', 'rule', 'chat'])
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
})
export type PeerFrom = z.infer<typeof PeerFrom>

/**
 * 执行中发的那条用户消息最后是怎么交给 CLI 的（面板记录的事实，界面据此写「插进当前轮 / 排到下一轮」）：
 * wait CLI 正等着下一句，直接交回同一个进程；steer 插进正在执行的这一轮；
 * notes 交给正在跑的 CLI，它会在这一轮里自己取；next-node 交给工作流里下一个开始的节点；
 * held 这一轮收不下，结束后自动接着处理；next 这一轮已经结束，按新的一轮处理；
 * lost 这一轮没能正常结束（失败、停止），排着的消息不会再被自动处理，要用户重新发；
 * restart CLI 卡住了，停掉后接回会话重开一轮处理
 */
export const DeliveryHow = z.enum(['wait', 'steer', 'notes', 'next-node', 'held', 'next', 'lost', 'restart'])
export type DeliveryHow = z.infer<typeof DeliveryHow>

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
  /** 派出子角色的那条系统消息：派出的子角色（步骤 id），对话里在这里放可以展开的「子任务」卡片 */
  spawned: z.array(z.string()).optional(),
  /**
   * 面板推回给 CLI 的消息（后台命令结果、合并编译结果、子任务结果）：不是用户说的话，
   * 对话里显示成 AI 回复里的一行，点开看全文。child 是子对话交回父对话的回报：
   * 只交给父对话的 AI，界面上不显示（子对话自己的状态图标已经说明做完了，汇报在子对话自己的对话里看）。
   * ask 是子对话请父对话决定的问题：父对话里显示成一张可以直接回答的卡片；
   * note 是执行中用户改设置这类说明，画成回复里的一行，不把回复截成两段
   */
  panel: z.enum(['background', 'build', 'helpers', 'child', 'ask', 'note', 'wrapup']).optional(),
  /**
   * panel 为 child / wrapup 时：是哪个子对话、上报时它处在哪个状态（见 shared/task.ts 的 ConvState）。
   * 父对话里画成一行「子对话状态」，点开看全文；旧数据没有这一项时按正文第一行显示
   */
  child: z.object({ id: z.string(), title: z.string().default(''), state: z.string().default('') }).optional(),
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
  at: z.string(),
})
export type TaskMessage = z.infer<typeof TaskMessage>

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])
export type StepStatus = z.infer<typeof StepStatus>

/**
 * 任务里执行过（或将要执行）的一个节点。主流程的节点在任务创建时就列出来；
 * 节点的开始 / 验收 / 结束流程、流程节点里的子节点在执行时才加进来，用 parentId 挂在发起它的节点下。
 */
export const FileChange = z.object({ path: z.string(), add: z.number().int(), del: z.number().int() })
export type FileChange = z.infer<typeof FileChange>

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
  /** 执行到一半被停止或面板重启打断；继续执行时续接这个节点的 CLI 会话，从中断的地方接着做 */
  interrupted: z.boolean().default(false),
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
   * 派这个子任务时交给它的要求原文（spawn_agents 的 instructions）。
   * 父对话的那条系统消息里只有标题列表，AI 分析时判断「它有没有做到派给它的要求」只能靠这段；
   * 旧记录没有这个字段，报告里如实说明看不到
   */
  brief: z.string().default(''),
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

/**
 * 任务停在 stopped 的原因。只有 'user' 是用户自己按的暂停，其余都是别的动作顺带把这一轮结束了：
 * 以前 stopTask 只有一个 boolean，全走同一条，界面一律显示「已暂停」，用户没按暂停却看到几只子对话被停了。
 * 界面按它决定说「已暂停」还是说清是谁结束的（见 shared/task.ts 的 childIcon / stopReasonText）。
 */
export const StopReason = z.enum([
  'user', // 用户点「暂停」
  'parent', // 父对话收尾，名下子对话一起结束（closeChildren）
  'switch', // 换 CLI / 模型 / 角色，这一轮重启
  'archive', // 归档
  'restart', // 面板重启、服务退出
  'presence', // 页面切走、宽限期到了，CLI 不再等下一句
  'idle', // 保活会话超过全局上限，闲置回收（不是用户按的暂停）
  'supersede', // 用户发了新消息，打断当前这一轮
  'finish', // 任务自己彻底完成，收尾时结束等下一句的 CLI
  'stalled', // CLI 没有响应，用户发新消息时面板停掉它、接回会话重开
])
export type StopReason = z.infer<typeof StopReason>

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
})
export type AgentUsage = z.infer<typeof AgentUsage>

export const TaskTodo = z.object({
  text: z.string(),
  status: z.enum(['pending', 'running', 'done']),
  agentId: z.string().default(''),
})
export type TaskTodo = z.infer<typeof TaskTodo>

/**
 * 对话的执行计划：对话分析完列出主步骤，每个主步骤最多再分一层子步骤。
 * 完成的步骤锁死不再改；整份做完、写了总结后收起，之后的新内容开一份新计划。
 * waiting：步骤在等后台命令、子对话这类耗时的结果，对话先去做下一步，结果回来再处理它
 */
export const PlanStatus = z.enum(['pending', 'running', 'waiting', 'done'])
export type PlanStatus = z.infer<typeof PlanStatus>

/** 步骤在等的东西：后台命令（编号）、子对话（id）；结果回来时按它找到步骤 */
export const PlanWait = z.object({
  kind: z.enum(['background', 'child']),
  ref: z.string(),
  label: z.string().default(''),
  state: z.enum(['waiting', 'ok', 'failed']).default('waiting'),
  /** 开始等的时间（子对话是它的创建时间）：步骤用时从真正开工算起。旧数据没有 */
  at: z.string().optional(),
})
export type PlanWait = z.infer<typeof PlanWait>

export const PlanItem = z.object({
  id: z.string(),
  title: z.string(),
  status: PlanStatus.default('pending'),
  /** Agent 写的一句备注（在等什么、卡在哪），或者面板写的等待结果 */
  note: z.string().default(''),
  waits: z.array(PlanWait).default([]),
  startedAt: z.string().default(''),
  endedAt: z.string().default(''),
})
export type PlanItem = z.infer<typeof PlanItem>

export const PlanStep = PlanItem.extend({
  /** 子步骤；主步骤是一次工作流运行时为空，子步骤就是那次运行的节点（run） */
  children: z.array(PlanItem).default([]),
  /** 这个主步骤是第几次工作流运行（start_plan 启动的） */
  run: z.number().int().optional(),
  /**
   * 面板加的收尾步骤（子对话计划的最后一步）：merge 是独立分支合回父对话所在的分支，由合并结果标完成；
   * p4 是把改动按文件类型分进各自的 pending changelist，Agent 做完自己标。旧数据没有这个字段，当普通步骤
   */
  wrapUp: z.enum(['merge', 'p4']).optional(),
  /**
   * 评审本次改动的一步：子对话收尾前必须把它写进计划（标 review: true）并做完，
   * submit_merge 会校验计划里有没有这样一步（见 shared/review-gate.ts）。旧数据没有这个字段
   */
  review: z.boolean().optional(),
})
export type PlanStep = z.infer<typeof PlanStep>

export const TaskPlan = z.object({
  id: z.string(),
  title: z.string().default(''),
  steps: z.array(PlanStep).default([]),
  createdAt: z.string(),
  /** 所有步骤都完成的时间；没完成时为空 */
  doneAt: z.string().default(''),
  /** 计划完成后 Agent 写的总结（必须有）；auto 表示 Agent 没写、面板取了它最后的回复 */
  summary: z.string().default(''),
  autoSummary: z.boolean().default(false),
})
export type TaskPlan = z.infer<typeof TaskPlan>

/** CLI 一次提的一个问题（Claude Code 的 AskUserQuestion 一次可以问几个） */
export const AskQuestion = z.object({
  /** 很短的标签，多个问题时显示在页签上 */
  header: z.string().default(''),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().default('') })).default([]),
  multiSelect: z.boolean().default(false),
})
export type AskQuestion = z.infer<typeof AskQuestion>

/** Agent 等用户确认的操作（权限不够的命令、改文件）或问题；确认在输入框上方显示，问题换掉输入框 */
export const TaskRequest = z.object({
  id: z.string(),
  step: z.string().default(''),
  agentId: z.string().default(''),
  /** confirm：工作流节点完成后等用户确认结果 */
  kind: z.enum(['command', 'file', 'tool', 'question', 'confirm']),
  title: z.string(),
  detail: z.string().default(''),
  /** 问题的选项；也可以自己填 */
  options: z.array(z.string()).default([]),
  /** 一次问了几个问题时的每一个（有它时 title、options 是第一个问题的） */
  questions: z.array(AskQuestion).optional(),
  at: z.string(),
})
export type TaskRequest = z.infer<typeof TaskRequest>

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

/**
 * 一次工作流运行：对话里可以按顺序跑很多次，每次用一份独立的工作流快照、共享状态和消息。
 * 节点本身仍在 task.steps 里，用 runId 和这里对应。
 */
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
})
export type TaskJob = z.infer<typeof TaskJob>

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
  /**
   * 子对话请父对话收尾的记录（见 ADR 0005）：子对话只剩合回时调用 submit_merge 写 requested，
   * 父对话 finish_child 合并时是 merging，合并没成功退回子对话时是 failed（info 写原因）。
   * 收尾做完（resolved）或者子对话又开始干活时清掉
   */
  wrapRequest: z
    .object({
      state: z.enum(['requested', 'merging', 'failed']),
      at: z.string(),
      note: z.string().default(''),
      tests: z.string().default(''),
      /** UE 项目：合回去后父对话要接着编译（独立分支里编不了 UE，见 ADR 0004） */
      build: z.boolean().optional(),
      info: z.string().default(''),
    })
    .optional(),
  /**
   * 子对话的交接摘要（见 ADR 0007）：submit_merge 时按模板写的关键信息加上面板补的 git 事实。
   * 完成后再被叫醒、上下文又大时，开新会话只带它，不把上次的工具输出全带进去
   */
  handoff: z.object({ text: z.string(), files: z.string().default(''), at: z.string() }).optional(),
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
  inbox: z.array(z.object({ from: z.string(), title: z.string(), text: z.string(), at: z.string() })).default([]),
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
  /** 「提问」开关：打开时 Agent 的提问交给用户回答，关着时让它自己选最合适的做法 */
  askUser: z.boolean().default(false),
  /** 对话时 Agent 参数的值 */
  params: z.record(z.string(), ParamValue).default({}),
  status: TaskStatus,
  /** 停下来的原因：只有 'user' 是用户按的暂停，其余几种界面要写清是谁结束的（见 StopReason） */
  stopReason: StopReason.optional(),
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
  /** 在线演示里的任务，输出是示例 */
  simulated: z.boolean().default(true),
  /** CLI 会话 id，用于续接：工作流节点按节点 id 记，对话和追加要求按 Agent id 记 */
  sessions: z.record(z.string(), z.string()).default({}),
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
   * 真要改文件时调用 begin_edit，面板这时才建 worktree，再在里面开新会话接着做
   */
  wantsWorktree: z.boolean().default(false),
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
  /** 任务开始时项目里已有的未提交改动（git numstat），统计改动时排除 */
  baseline: z.record(z.string(), z.string()).default({}),
  /** 任务创建时的工作流（连同引用的其他工作流）；之后改动、删除工作流不影响这个任务。旧任务没有 */
  workflows: z.array(Workflow).default([]),
  /** 历次工作流运行：每次一份工作流快照、共享状态和节点消息。旧任务没有 */
  runs: z.array(TaskRun).default([]),
  /**
   * 新建对话时解析好的技能槽取值（工作流 expose 里 target=skill 的项）：Agent 的 skills 写 `{{槽名}}`，
   * 执行时按这里换成具体的技能名。和上面的工作流快照一起定下来，之后改项目设置不影响这个对话
   */
  skillSlots: z.record(z.string(), z.string()).default({}),
  /**
   * 新建对话时项目里的测试步骤快照：测试 Agent 按它执行，并把原文交给 CLI。
   * 之后改项目设置不影响已经开始的对话。旧任务没有时为空（Agent 自己找命令）。
   */
  testSteps: z.array(TestStep).default([]),
  /** 新建对话时面板所在系统（windows / linux / darwin）：决定标了 wsl 的步骤怎么执行 */
  platform: z.string().default(''),
  /** 工作流的名字，列表里显示（摘要不带上面的完整工作流） */
  workflowName: z.string().default(''),
  /** 任务开始时的提交（git 仓库才有）；统计改动和看差异都和它比，Agent 中途提交了也不丢 */
  baseRef: z.string().default(''),
  /** 正在等用户确认的请求 */
  requests: z.array(TaskRequest).default([]),
  /** 独立分支执行时的工作目录和分支；直接在项目目录执行时为空 */
  worktree: TaskWorktree.nullable().default(null),
  /** 这一轮开始时的累计用量：预算上限按每次执行算，继续执行就重新给一份额度 */
  budgetFrom: z.object({ usd: z.number(), tokens: z.number() }).optional(),
  /** CLI 正在处理一轮：预热、等下一句、进程只是活着时都是 false */
  working: z.boolean().default(false),
  /**
   * 还在跑或排队的后台命令：服务端发给界面时按当时的情况带上，不存盘。
   * 对话这一轮已经说完、命令还在后台跑时，界面靠它在回复上面转圈
   */
  jobs: z.array(TaskJob).optional(),
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
  /**
   * 名下正在执行的子对话数：只在列表摘要里带，由服务端按子对话的 working 算好。
   * 有子对话在跑时父对话在侧栏也显示执行中；它不是父对话自己的执行状态，不参与完成通知
   */
  childrenWorking: z.number().int().min(0).optional(),
  /** 归档：侧栏默认不显示，筛选「已归档」时才列出来；不删除任何内容 */
  archived: z.boolean().optional(),
  /**
   * 子对话已经解决：只用于标记（列表归到「已完成」并显示标记），不改 status、不停 CLI，
   * 父对话的等待逻辑和 childrenWorking 聚合都不看它
   */
  resolved: z.boolean().optional(),
  /** 用户最近一次发消息的时间：只在列表摘要里带（摘要去掉了消息），排序和显示用 askedAt() 取 */
  askedAt: z.string().optional(),
  /** 用户结束了工作流：没完成的节点不再执行，之后的要求由主 Agent 直接处理 */
  flowClosed: z.boolean().optional(),
  /** 这个对话里用户对推送的选择：问过一次就记住，不再重复问 */
  remotePush: z.enum(['allowed', 'denied']).optional(),
  /** 已经跑了几次工作流：每次运行按顺序执行节点，运行之间互相隔离 */
  runSeq: z.number().int().default(0),
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

/**
 * 旧任务的消息用节点下标记录所属节点，换成节点 id。
 * 更早的版本还有 queue（执行中排队的追加要求）：现在执行中收到的消息直接进对话，
 * 读旧数据时把没处理的普通要求补到对话末尾，让用户仍然看得到；等 CLI 取走的补充已经不成立了，丢掉。
 */
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

/** 一个档位：模型和思考强度；旧数据只有模型名 */
export const TierSetting = z.preprocess(
  (v) => (typeof v === 'string' ? { model: v } : (v ?? {})),
  z.object({
    model: z.string().trim().default(''),
    effort: z.string().trim().default(''),
    /** 上下文窗口和最大输出（token）；0 表示自动（按模型的默认值，不传给 CLI） */
    context: z.number().int().min(0).default(0),
    maxOutput: z.number().int().min(0).default(0),
  }),
)
export type TierSetting = z.infer<typeof TierSetting>

/** 单个 CLI 的本机设置 */
export const CliSettings = z.object({
  enabled: z.boolean().default(true),
  /** 可执行文件；为空时用默认命令名（从 PATH 查找） */
  command: z.string().trim().default(''),
  /** Agent 没有指定模型时使用；可以是具体模型，也可以是档位 @high / @medium / @low */
  defaultModel: z.string().trim().default(''),
  /** Agent 和档位都没指定思考强度时使用；为空不传 */
  defaultEffort: z.string().trim().default(''),
  /** 高 / 中 / 低三档对应的模型和思考强度；为空用内置的建议值 */
  tiers: z.object({ high: TierSetting, medium: TierSetting, low: TierSetting }).default(() => ({
    high: TierSetting.parse({}),
    medium: TierSetting.parse({}),
    low: TierSetting.parse({}),
  })),
  /** 权限模式，取值见 shared/clis.ts 里各 CLI 的 permissions */
  permission: z.string().default(''),
  /** 每次调用都追加的参数 */
  extraArgs: z.array(z.string()).default([]),
  /** 追加的环境变量，例如 API Key、代理 */
  env: z.array(z.object({ key: z.string().trim(), value: z.string() })).default([]),
  /** 用账号（浏览器登录）还是 API（全局设置里配的接口 + 密钥）；两种方式的模型下拉各列各的 */
  authMode: z.enum(['account', 'api']).default('account'),
  /** API 模式用哪个 API（全局设置里 apis 的 id） */
  apiId: z.string().default(''),
  /** 在任务页和设置里显示账号额度（5 小时、每周用了多少） */
  showLimits: z.boolean().default(false),
  /** 上下文占用达到这个百分比时自动压缩；0 表示用 CLI 自己的规则 */
  autoCompact: z.number().int().min(0).max(100).default(0),
  /** 一轮任务最多执行多少回合（模型请求次数）；0 表示用 CLI 自己的默认值（Command Code 是 1000） */
  maxTurns: z.number().int().min(0).max(1000).default(0),
  /** CLI 定义里开关（options）的状态；没改过的按定义里的默认值 */
  options: z.record(z.string(), z.boolean()).default({}),
})
export type CliSettings = z.infer<typeof CliSettings>

/** 内容区默认宽度 */
export const CONTENT_WIDTH = 1000
export const CONTENT_MAX = 1280

/** 各英文字体默认的空格调整：只有等宽的 Maple Mono 需要收窄 */
export const WORD_SPACING: Record<'maple' | 'plex' | 'system', number> = { maple: -0.2, plex: 0, system: 0 }
/** 字体：界面（英文）、中文、代码各选一种，字号、字间距、空格宽度、行高可调 */
export const Appearance = z.object({
  /** 界面的英文字体：默认内置的 Maple Mono NL（不带符号连字的版本） */
  uiFont: z.enum(['maple', 'plex', 'system']).catch('maple').default('maple'),
  /** 中文字体：默认内置的思源黑体（Noto Sans SC），和 Maple Mono 中文版用的是同一套字形 */
  cjkFont: z.enum(['noto', 'system']).catch('noto').default('noto'),
  /** 代码、命令、路径用的等宽字体 */
  monoFont: z.enum(['maple', 'jetbrains']).catch('maple').default('maple'),
  /** 本机装了的字体名，填了就排在最前面，缺的字再用上面选的 */
  customFont: z.string().trim().max(200).default(''),
  /** 界面正文字号（像素），其他文字按比例跟着缩放 */
  fontSize: z.number().min(12).max(18).catch(14).default(14),
  /** 字间距（em）：Maple Mono 是等宽字体，英文字母本来就疏，默认收紧一点 */
  letterSpacing: z.number().min(-0.08).max(0.15).catch(-0.02).default(-0.02),
  /** 空格的宽度调整（em，CSS word-spacing）：等宽字体的空格有半个汉字宽，中英文混排时显得空，默认收窄。代码里不调 */
  wordSpacing: z.number().min(-0.4).max(0.3).catch(-0.2).default(-0.2),
  /** 对话和文档正文的行高 */
  lineHeight: z.number().min(1.3).max(2.2).catch(1.75).default(1.75),
})
export type Appearance = z.infer<typeof Appearance>

/** 抓取元素用的鼠标按键。左键、右键留给页面自己的交互（点按钮、弹菜单），所以默认为中键 */
export const PICK_BUTTONS = ['middle', 'left', 'right'] as const
export type PickButton = (typeof PICK_BUTTONS)[number]
export const DEFAULT_PICK_BUTTON: PickButton = 'middle'
/** 切换抓取模式的快捷键：`·`（U+00B7），中文输入法下就是反引号那一格 */
export const DEFAULT_PICK_HOTKEY = '·'

/**
 * 开发者模式的「元素抓取」怎么触发：快捷键和抓取用的鼠标按键。
 * 存成字符串 / 名字，手改设置文件也能认；写法看 web/src/lib/hotkey.ts
 */
export const ElementPicker = z.object({
  /** 切换抓取模式（开启 / 退出）的快捷键；在输入框里打字时不触发 */
  hotkey: z.string().trim().min(1).max(40).catch(DEFAULT_PICK_HOTKEY).default(DEFAULT_PICK_HOTKEY),
  /** 抓取用的鼠标按键 */
  button: z.enum(PICK_BUTTONS).catch(DEFAULT_PICK_BUTTON).default(DEFAULT_PICK_BUTTON),
})
export type ElementPicker = z.infer<typeof ElementPicker>

/** 从外网访问面板：默认关闭，服务仍然只监听 127.0.0.1，由 cloudflared 或用户自己的反向代理把请求转进来。
 * 外网的请求一律要求访问令牌，和本机访问不同。
 */
export const RemoteAccess = z.object({
  enabled: z.boolean().default(false),
  /** quick：Cloudflare 临时地址（重启后变）；token：Cloudflare Tunnel（固定域名）；custom：自己搭的反向代理 */
  mode: z.enum(['quick', 'token', 'custom']).catch('quick').default('quick'),
  /** Cloudflare Tunnel 的 token（mode=token 时用），也可以在 cloudflared 里预先配置好 */
  tunnelToken: z.string().trim().max(4000).default(''),
  /** 外网地址：token 模式填隧道的域名，custom 模式填反向代理后的地址；quick 模式自动生成 */
  publicUrl: z.string().trim().max(300).default(''),
  /** cloudflared 可执行文件；留空时依次找数据目录的 bin/ 和 PATH */
  command: z.string().trim().max(500).default(''),
})
export type RemoteAccess = z.infer<typeof RemoteAccess>

export const Settings = z.object({
  /** 单个步骤最长运行时间（分钟），超时会停止；0 表示不限制 */
  stepTimeoutMinutes: z.number().int().min(0).max(1440).default(0),
  /** CLI 这么多分钟没有任何输出时提醒，再过同样的时间自动停止；0 表示不检测。比总时长更合适：长任务不会被误杀，卡死的会被发现 */
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(15),
  /**
   * 子对话这么多分钟没有任何输出时，面板以父对话的名义自动问它当前在做什么、是否卡住；0 表示不问。
   * 和 idleTimeoutMinutes 是两个独立的档位：这里只问、不停止，问过几次仍没有输出就交给那一条提醒 / 自动停止
   */
  childIdleAskMinutes: z.number().int().min(0).max(1440).catch(3).default(3),
  /**
   * 对话页切走后，CLI 还停在等下一句的工具上多久（分钟）；0 表示回复完就结束这一轮。
   * 期间这个对话保留一个 CLI 进程，值越大越省重开的时间，同时挂着的进程也越多。
   * 只管空闲会话：正在执行的一轮（切到后台也一样）到点不回收，见 server/tasks.ts 的 keepAliveBusy
   */
  presenceGraceMinutes: z.number().int().min(0).max(1440).default(60),
  /**
   * 这一轮回复完成、但用户还没打开看过的对话，多久回收（分钟）；0 表示回复完就回收。
   * 这类对话没有页面开着，不收的话进程会一直挂着，而橙点只有用户点开才会消。同理只管空闲会话
   */
  unreadGraceMinutes: z.number().int().min(0).max(1440).catch(30).default(30),
  /** 关掉后不自动回收：回复完没人看的 CLI 进程一直留着，进程会越攒越多，内存只增不减 */
  reclaimIdleCli: z.boolean().catch(true).default(true),
  /**
   * 同时保活的会话上限：回复完停在等下一句、又没人在看的 CLI 最多留几个，超过就结束最久没用的那个，
   * 下次打开靠 --resume 续接（冷启动一次）。只统计空闲会话，正在执行的对话不占名额也不会被收掉。
   * 0 表示不限制
   */
  keepAliveLimit: z.number().int().min(0).max(50).catch(4).default(4),
  /**
   * 整个面板同时跑的后台命令最多几条（所有对话共用）：超出的排队，前面的跑完一条再开始。
   * 每个子对话的独立分支是不同目录，按目录排队拦不住十几条编译、测试一起跑。
   * 默认 64：一般机器同时跑几十条测试、编译顶得住，只有实在忙不过来时才需要调小
   */
  backgroundLimit: z.number().int().min(1).max(64).catch(64).default(64),
  /** 超过这么大（MB）的文件放进输入框时不上传、不拷进对话目录，直接引用它在本机的路径 */
  largeFileMB: z.number().int().min(1).max(50).catch(10).default(10),
  /**
   * 设置 →「数据」里内存曲线多久采一次（秒）。采样只放在内存里，保留最近两小时，
   * 间隔越小曲线越细，但每次都要读一遍子进程的内存（Windows 上用 PowerShell），别调得太小
   */
  memorySampleSeconds: z.number().int().min(10).max(3600).catch(30).default(30),
  /** 粘贴的纯文字超过这么多字时存成一个文本文件，输入框里放文件卡片；0 表示不转 */
  longPasteChars: z.number().int().min(0).max(1_000_000).catch(5000).default(5000),
  /** Agent 选「系统默认」时使用的 CLI */
  defaultCli: z.string().default('claude'),
  clis: z.record(z.string(), CliSettings).default({}),
  /** 全局的 API：配一次，每个 CLI 都能选用（协议对得上的） */
  apis: z.array(ApiConfig).default([]),
  /** CLI 的显示顺序（设置侧栏、默认 CLI、Agent 的 CLI 选项）；没列出的排在后面 */
  cliOrder: z.array(z.string()).default([]),
  /** 服务启动后用默认浏览器打开面板（只在托管了前端页面时生效，开发模式下页面在 Vite 那边） */
  openBrowser: z.boolean().default(true),
  /** 网络代理：检查更新、下载新版本时用。默认地址和各处的示例见 shared/proxy.ts（只支持 http 代理，SOCKS 用不了）；为空时用环境变量 HTTPS_PROXY / HTTP_PROXY */
  proxy: z.string().trim().default(''),
  /** 访问令牌：打开后只有用启动时显示的地址打开过的浏览器能访问，挡住本机其他程序直接调接口 */
  requireToken: z.boolean().default(false),
  /** 外网访问：默认关闭 */
  remoteAccess: RemoteAccess.prefault({}),
  /** 项目首页的输入框和任务列表、任务页的对话和节点内容的宽度（像素） */
  /** 最宽 1280：再宽两边的任务进度、右栏会被挤得太窄；以前存的更大的值收到上限 */
  contentWidth: z
    .preprocess((v) => (typeof v === 'number' ? Math.min(CONTENT_MAX, Math.max(640, v)) : v), z.number().int())
    .default(CONTENT_WIDTH),
  appearance: Appearance.prefault({}),
  /** 新开的会话「提问」开关默认打开：AI 有问题时弹卡片问用户，而不是自己选 */
  askUserDefault: z.boolean().default(false),
  /** 开发者模式：输入框上显示「抓取界面元素」按钮，点选面板界面上的元素引用进对话，让 AI 改面板自己的代码 */
  developerMode: z.boolean().catch(false).default(false),
  /** 抓取元素时用的快捷键和鼠标按键（设置 →「快捷键」里改） */
  elementPicker: ElementPicker.prefault({}),
  /**
   * 全局的文本文件格式：项目没单独设置时用它，默认 UTF-8 无 BOM + LF。
   * 面板自己写的文件（说明文件、部署的全局说明）和交给 Agent 的约定都按它来
   */
  fileFormat: FileFormat.prefault({}),
  /** 界面语言：auto 跟随浏览器 */
  language: z.enum(['auto', 'zh', 'en']).default('auto'),
  /**
   * 命令行环境：面板替 Agent 跑整行命令（后台命令、合并时编译里「自动」环境的步骤）用哪个 shell。
   * 只在 Windows 上有选择；kind 为空表示按本机检测的推荐（有 Git Bash 用 Git Bash，没有用 WSL，再没有用 cmd）
   */
  shell: z
    .object({
      kind: z.enum(['', 'wsl', 'gitbash', 'powershell', 'cmd']).catch('').default(''),
      /** WSL 的发行版；空时用 WSL 的默认发行版 */
      wslDistro: z.string().trim().max(60).default(''),
    })
    .prefault({}),
  /** UI 设计里生成图片用的 CLI 和模型（目前只有 Codex 内置了生图工具）；模型为空用这个 CLI 的高档 */
  imageGen: z
    .object({
      cli: z.string().default('codex'),
      model: z.string().trim().default(''),
      effort: z.string().default(''),
      /** 同时生成几张图：每张图单独开一个会话（CLI 进程或浏览器里的新对话），最多 10 个 */
      concurrency: z.number().int().min(1).max(10).catch(3).default(3),
      /** 本机生图（ComfyUI）：装在软件目录的 comfyui/ 下 */
      local: z
        .object({
          /** 下载模型用 hf-mirror.com、装依赖用清华 PyPI 镜像 */
          mirror: z.boolean().default(false),
          port: z.number().int().min(1024).max(65535).catch(8188).default(8188),
          /** 已经有 ComfyUI 时填它的地址（例如 http://127.0.0.1:8188），不用再装 */
          url: z.string().trim().default(''),
        })
        .default({ mirror: false, port: 8188, url: '' }),
    })
    .default({
      cli: 'codex',
      model: '',
      effort: '',
      concurrency: 3,
      local: { mirror: false, port: 8188, url: '' },
    }),
  /** 模型目录：三档模型的上下文窗口和最大输出按模型自动识别 */
  modelCatalog: z
    .object({
      /**
       * 模型目录里没有的模型，允许在设置里点「AI 补全」联网查官方数字，
       * 结果写进数据目录的 config/models.json
       */
      aiLookup: z.boolean().default(true),
    })
    .default({ aiLookup: true }),
  /**
   * 用量统计的「计价模型」：按哪个模型的官方 API 单价折算费用（单价表在 shared/pricing.ts）。
   * 存模型 id；找不到时界面显示「未配置单价」，不拿 0 冒充
   */
  usagePricingModel: z.string().default(DEFAULT_PRICING_MODEL),
  /** AI 创建 / 优化 Agent 和工作流 */
  assist: z
    .object({
      /** 默认用哪个 CLI；为空时用第一个已安装的 */
      cli: z.string().default(''),
      model: z.string().trim().default(''),
      /** 用户补充的创建规则，会加进提示词 */
      agentRules: z.string().max(8000).default(''),
      workflowRules: z.string().max(8000).default(''),
    })
    .default({ cli: '', model: '', agentRules: '', workflowRules: '' }),
})
export type Settings = z.infer<typeof Settings>

/** 回答 Agent 的请求：允许 / 拒绝，问题的回答（一次问了几个时每个一条） */
export const RequestAnswer = z.object({
  allow: z.boolean(),
  answer: z.string().max(20000).optional(),
  answers: z.array(z.string().max(20000)).max(20).optional(),
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

/**
 * 对话进程面板里的一条进程：面板登记的 CLI 或它起的子进程（MCP 服务、shell）。
 * 内存取不到时 rss 为 null（界面显示「未知」），不要用 0 冒充
 */
export const TaskProcess = z.object({
  pid: z.number(),
  /** 父进程；面板起的是 CLI 自己时为空 */
  parentPid: z.number().nullable().default(null),
  /** 命令行摘要：长参数（MCP 配置、临时目录）已经替换掉 */
  command: z.string().default(''),
  /** 归属：哪个对话/子对话/子任务/工作流起的；面板自己的动作（AI 创建、文档）为空 */
  ownerTaskId: z.string().default(''),
  ownerTitle: z.string().default(''),
  /** 进程启动时刻（epoch ms）；取不到时 null */
  startedAt: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** 常驻内存（字节）；取不到时 null */
  rss: z.number().nullable().default(null),
  /** running 运行中；idle 很久没有输出；orphan 任务已经不在跑了（可清理） */
  status: z.enum(['running', 'idle', 'orphan']).default('running'),
  /** cli 面板起的那个进程；child 它起的子进程 */
  kind: z.enum(['cli', 'child']).default('cli'),
})
export type TaskProcess = z.infer<typeof TaskProcess>

/** 一个对话（含附属子对话、子任务）的进程与内存汇总：前端「内存合计」读 cliMemory */
export const TaskProcesses = z.object({
  sampledAt: z.number(),
  processes: z.array(TaskProcess).default([]),
  /** 这个对话及附属任务的 CLI 进程 RSS 合计；取不到系统信息时 null */
  cliMemory: z.number().nullable().default(null),
  /** 面板 server 自己的 RSS：不属于这个对话，界面上单独标明、不计入合计 */
  serverMemory: z.number(),
  /** totalMemory = cliMemory，不含面板自己的内存；cliMemory 未知时 null */
  totalMemory: z.number().nullable().default(null),
  /** 系统进程信息取不到的原因；取得到时为空字符串 */
  unavailable: z.string().default(''),
})
export type TaskProcesses = z.infer<typeof TaskProcesses>

/** 内存曲线上的一个点：t 采样时刻；cli 未知时 total 也是 null（断开而不是掉到 0） */
export const MemoryPoint = z.object({
  t: z.number(),
  /** 面板 server 自己的 RSS，只单独展示，不计入 total */
  server: z.number(),
  /** 这个对话及附属任务的 CLI 内存 */
  cli: z.number().nullable(),
  /** total = cli（不含面板）；cli 未知时 null */
  total: z.number().nullable(),
})
export type MemoryPoint = z.infer<typeof MemoryPoint>

/** 对话内存历史：按时间从旧到新，points 已经按时间范围裁过 */
export const TaskMemoryHistory = z.object({
  sampledAt: z.number(),
  intervalMs: z.number(),
  capacity: z.number(),
  points: z.array(MemoryPoint).default([]),
})
export type TaskMemoryHistory = z.infer<typeof TaskMemoryHistory>

/** 关闭一个进程的结果：失败时把系统给的真实错误带回来 */
export const KillProcessResult = z.object({
  ok: z.boolean(),
  pid: z.number(),
  error: z.string().default(''),
})
export type KillProcessResult = z.infer<typeof KillProcessResult>

/** 清理无效进程：只处理面板登记过、任务已经不在跑的 */
export const CleanProcessesInput = z.object({
  /** 用户在确认列表里勾选的 pid；为空时清全部符合的 */
  pids: z.array(z.number()).max(500).default([]),
})
export type CleanProcessesInput = z.infer<typeof CleanProcessesInput>

export const CleanProcessesResult = z.object({
  /** 真的发过结束的 */
  killed: z.array(z.number()).default([]),
  /** 觉得可以杀但被服务端拦下的（任务还在跑、命令行不像面板起的） */
  skipped: z.array(z.object({ pid: z.number(), reason: z.string() })).default([]),
  /** 登记还在但进程已经结束的（顺手把登记清掉） */
  gone: z.array(z.number()).default([]),
})
export type CleanProcessesResult = z.infer<typeof CleanProcessesResult>

/** AI 清理的建议：只是建议，用户确认后前端再调清理接口 */
export const ProcessSuggestResult = z.object({
  suggestions: z.array(z.object({ pid: z.number(), reason: z.string() })).default([]),
  /** CLI 的原文说明（没有解析出 JSON 时给用户看） */
  text: z.string().default(''),
  error: z.string().default(''),
})
export type ProcessSuggestResult = z.infer<typeof ProcessSuggestResult>

/**
 * 会话内存 AI 分析里的一个归属分组：按 ownerTaskId 汇总，子对话只算自己起的进程树。
 * rss 为 null 表示这个归属的进程都读不到内存（界面显示「未采集」），不是 0
 */
export const TaskMemoryOwner = z.object({
  taskId: z.string().default(''),
  title: z.string().default(''),
  /** 是不是当前打开的这个对话 */
  self: z.boolean().default(false),
  rss: z.number().nullable().default(null),
  /** 进程数，以及其中读到 RSS 的个数 */
  count: z.number().default(0),
  counted: z.number().default(0),
})
export type TaskMemoryOwner = z.infer<typeof TaskMemoryOwner>

/** 会话内存 AI 分析：报告、趋势摘要和交给 AI 的第一句话，界面据此打开排查弹窗 */
export const TaskMemoryAnalysis = z.object({
  sampledAt: z.number(),
  intervalMs: z.number(),
  /** 交给 AI 的报告正文（中文） */
  report: z.string().default(''),
  /** AI 分析的第一句话 */
  ask: z.string().default(''),
  /** 相关目录：项目路径；没有项目时为空（服务端用用户目录） */
  cwd: z.string().default(''),
  /** 最近一段的趋势，采样不足时 null */
  trend: z.enum(['up', 'down', 'flat']).nullable().default(null),
  /** 面板上显示的摘要（和报告里的趋势同源） */
  trendText: z.string().default(''),
  owners: z.array(TaskMemoryOwner).default([]),
  tree: z
    .object({ tasks: z.number(), children: z.number(), running: z.number() })
    .default({ tasks: 1, children: 0, running: 0 }),
})
export type TaskMemoryAnalysis = z.infer<typeof TaskMemoryAnalysis>
