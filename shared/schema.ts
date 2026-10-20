import { z } from 'zod'
import { ApiConfig } from './accounts.ts'
import { t } from './i18n.ts'

/** 参数的值：单选、文本是字符串，多选是字符串数组，开关是布尔，数字是数字 */
export const ParamValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(30)])
export type ParamValue = z.infer<typeof ParamValue>
export type ParamValues = Record<string, ParamValue>

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
  /** 从内置模板建出来的 Agent 记下来源（builtin:<key>），再次添加内置工作流时复用，不重复建 */
  origin: z.string().max(80).default(''),
})
export type AgentInput = z.infer<typeof AgentInput>

const Meta = z.object({ id: z.string(), createdAt: z.string(), updatedAt: z.string() })

export const Agent = AgentInput.extend(Meta.shape)
export type Agent = z.infer<typeof Agent>

/**
 * 自带的默认 Agent：不能删除，CLI、模型、思考强度固定跟随设置里的默认 CLI，
 * 对话时可以在输入框旁边临时换模型和思考强度。新建的对话没选过 Agent 时用它。
 */
export const DEFAULT_AGENT_ID = 'default-agent'
export const defaultAgent = (): Agent => {
  const at = new Date(0).toISOString()
  return {
    ...AgentInput.parse({
      name: t('默认 Agent'),
      description: t('使用默认 CLI 的默认模型和思考强度，对话时可以临时调整'),
      icon: 'sparkles',
    }),
    id: DEFAULT_AGENT_ID,
    createdAt: at,
    updatedAt: at,
  }
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
function migrateWorkflow(v: unknown) {
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

export const ProjectCategory = ProjectCategoryInput.extend(Meta.shape)
export type ProjectCategory = z.infer<typeof ProjectCategory>

/** 项目：本机上的一个目录，Agent 会在这个目录里按工作流执行任务 */
export const ProjectInput = z.object({
  name: z.string().trim().min(1, t('名称不能为空')).max(40),
  description: z.string().trim().max(200).default(''),
  /** 本机绝对路径 */
  path: z.string().trim().default(''),
  categoryId: z.string().default(''),
  /** 单独指定的工作流；为空时使用分类的默认工作流 */
  workflowId: z.string().default(''),
  /** 工作流暴露项的取值（key 是 Workflow.expose 里的 key） */
  workflowParams: z.record(z.string(), ParamValue).default({}),
  /** 推送授权：ask 第一次需要推送时问一次，allow 直接推，deny 一律不推 */
  gitPolicy: z.enum(['ask', 'allow', 'deny']).default('ask'),
})
export type ProjectInput = z.infer<typeof ProjectInput>

export const Project = ProjectInput.extend(Meta.shape)
export type Project = z.infer<typeof Project>

/** 本地目录检测结果 */
export interface DirInfo {
  path: string
  exists: boolean
  isDir: boolean
  /** 是 git 仓库时的当前分支（分离 HEAD 时为提交号前 7 位） */
  gitBranch: string | null
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
})
export type Attachment = z.infer<typeof Attachment>
/** 一次最多附上的文件数 */
export const MAX_ATTACHMENTS = 10
/** 单个附件的大小上限（字节） */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export type TaskMode = z.infer<typeof TaskMode>

export const NewTaskInput = z.object({
  /** 为空表示 Chat 模式的聊天：不属于任何项目，只能直接对话 */
  projectId: z.string().default(''),
  mode: TaskMode,
  /** workflow 模式：为空时用项目的工作流 */
  workflowId: z.string().default(''),
  /** chat 模式：对话的 Agent */
  agentId: z.string().default(''),
  /** chat 模式用的 CLI、模型和思考强度（只对默认 Agent 有效）；为空跟随默认 CLI 的设置 */
  cli: z.string().trim().max(40).default(''),
  model: z.string().trim().max(200).default(''),
  effort: z.string().trim().max(40).default(''),
  prompt: z.string().trim().min(1, t('请描述任务')).max(20000),
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS).default([]),
  /** chat 模式：Agent 参数的值（没给的用默认值） */
  params: z.record(z.string(), ParamValue).default({}),
  /** 在独立分支（git worktree）里执行，不直接改项目目录；只有 git 仓库可以 */
  isolate: z.boolean().default(false),
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
  /** 任务正在执行时：true 先停下当前这一轮再发送；否则排队，这一轮完成后自动接着处理 */
  interrupt: z.boolean().default(false),
  /** 任务正在执行时：插话交给正在跑的 CLI，由它判断相关性（相关的调整方向，无关的等这一轮完成后再处理）；CLI 收不下时排队（见 CLI 配置的 steer、notes） */
  steer: z.boolean().default(false),
})
/** 执行中发来、排队等这一轮完成后再处理的要求 */
export const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  at: z.string(),
  /** 已经登记给正在跑的调用，等它用面板的工具取走（见 CLI 配置的 notes）；取走了会从队列里去掉 */
  note: z.boolean().default(false),
})
export type QueuedMessage = z.infer<typeof QueuedMessage>
/** 可以直接修改的任务字段 */
export const TaskPatch = z
  .object({
    title: z.string().trim().min(1, t('标题不能为空')).max(80),
    archived: z.boolean(),
    // 对话用的 CLI、模型和思考强度，执行中也能改，下一轮生效
    cli: z.string().trim().max(40),
    model: z.string().trim().max(200),
    effort: z.string().trim().max(40),
    // 「提问」开关：Agent 有问题时交给你回答，还是让它自己选
    askUser: z.boolean(),
    // 对话的 Agent 参数，下一轮生效
    params: z.record(z.string(), ParamValue),
  })
  .partial()

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
  /** 还在执行（命令的输出会边跑边更新） */
  running: z.boolean().optional(),
})
export type ToolUse = z.infer<typeof ToolUse>

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
  /** 这一轮模型请求用了多久（毫秒）：CLI 报得出起止时才有，用来说明两步之间等的是模型 */
  modelMs: z.number().optional(),
  /** 用户消息附上的文件和图片 */
  attachments: z.array(Attachment).optional(),
  /** 系统消息是不是错误：错误在节点里和对话里都用醒目的样式显示 */
  error: z.boolean().optional(),
  /** 这次执行结束时写的状态说明（已暂停、失败后可以重试）：继续执行时它已经不成立，会被去掉 */
  transient: z.boolean().optional(),
  /** 系统消息是用户对 Agent 提问的回答：在对话正文里像用户消息一样显示每个问题和答案 */
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  /** 对话里用户消息对应的 CLI 那一轮：分叉、撤回时让 CLI 从这一轮截断会话 */
  turn: z
    .object({
      session: z.string(),
      /** Codex 的 turn id */
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
   * sub 是节点执行中自己派出的子 Agent，call 是主 Agent 评估时委派的另一个工作流
   */
  slot: z.enum(['', 'start', 'review', 'end', 'body', 'sub', 'call']).default(''),
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
  /** 节点自己给出的结论（有条件连线时要求写）：决定走哪条线 */
  branch: z.enum(['', 'pass', 'fail']).optional(),
  /** 执行到一半被停止或面板重启打断；继续执行时续接这个节点的 CLI 会话，从中断的地方接着做 */
  interrupted: z.boolean().default(false),
  /** 最近一次启动这个节点的 Agent 用的命令（可执行文件和参数），方便复制出来排查问题 */
  command: z.array(z.string()).default([]),
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

export const TaskData = z.object({
  projectId: z.string(),
  title: z.string(),
  mode: TaskMode,
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
  /** 累计执行时间（毫秒），不含等用户继续对话的空闲时间 */
  runMs: z.number().default(0),
  /** 这一轮开始执行的时间；没在执行时为空 */
  runStartedAt: z.string().default(''),
  /** 等用户确认、回答问题的累计时间（毫秒），含在 runMs 里；waitStartedAt 是正在等的开始时间 */
  waitMs: z.number().default(0),
  waitStartedAt: z.string().default(''),
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
  /**
   * 对话分叉或撤回后，下一轮从哪里接着：session 里保留到 through 这一轮（含），之后的丢掉；
   * through 为空表示一轮都不留，开新会话。CLI 不能截断会话时，把留下的对话整理成文字带给新会话
   */
  rewind: z
    .object({
      session: z.string(),
      through: z.object({ session: z.string(), id: z.string().default(''), end: z.string().default('') }).nullable(),
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
  /** 任务开始时项目里已有的未提交改动（git numstat），统计改动时排除 */
  baseline: z.record(z.string(), z.string()).default({}),
  /** 任务创建时的工作流（连同引用的其他工作流）；之后改动、删除工作流不影响这个任务。旧任务没有 */
  workflows: z.array(Workflow).default([]),
  /** 工作流的名字，列表里显示（摘要不带上面的完整工作流） */
  workflowName: z.string().default(''),
  /** 任务开始时的提交（git 仓库才有）；统计改动和看差异都和它比，Agent 中途提交了也不丢 */
  baseRef: z.string().default(''),
  /** 正在等用户确认的请求 */
  requests: z.array(TaskRequest).default([]),
  /** 独立分支执行时的工作目录和分支；直接在项目目录执行时为空 */
  worktree: TaskWorktree.nullable().default(null),
  /** 执行中排队的要求：这一轮完成后按顺序处理；失败或暂停时留着，由用户决定 */
  queue: z.array(QueuedMessage).default([]),
  /** 这一轮开始时的累计用量：预算上限按每次执行算，继续执行就重新给一份额度 */
  budgetFrom: z.object({ usd: z.number(), tokens: z.number() }).optional(),
  /** CLI 正在处理一轮：预热、等下一句、进程只是活着时都是 false */
  working: z.boolean().default(false),
  /** CLI 最近一次完成一轮回复的时间：判断「完成但没看」用，和进程是否结束无关 */
  turnDoneAt: z.string().default(''),
  /** CLI 回复完停在面板的 MCP 工具上，等用户在这个对话里的下一句 */
  awaitingUser: z.boolean().default(false),
  /** 对话页打开时在后台用 --resume 启动，还没等到下一句 */
  prewarming: z.boolean().default(false),
  /** 归档：侧栏默认不显示，筛选「已归档」时才列出来；不删除任何内容 */
  archived: z.boolean().optional(),
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

/** 旧任务的消息用节点下标记录所属节点，换成节点 id */
function migrateTask(v: unknown) {
  if (!v || typeof v !== 'object') return v
  const t = v as { steps?: { id?: string }[]; messages?: { step?: unknown }[] }
  const steps = (t.steps ?? []).map((s, i) => ({
    ...s,
    id: s.id ?? `s${i}`,
    nodeId: (s as any).nodeId ?? s.id ?? `s${i}`,
  }))
  const messages = (t.messages ?? []).map((m) =>
    typeof m.step === 'number' ? { ...m, step: m.step >= 0 ? (steps[m.step]?.id ?? '') : '' } : m,
  )
  return { ...t, steps, messages }
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

/**
 * 从外网访问面板：默认关闭，服务仍然只监听 127.0.0.1，由 cloudflared 或用户自己的反向代理把请求转进来。
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
   * 对话页切走后，CLI 还停在等下一句的工具上多久（分钟）；0 表示回复完就结束这一轮。
   * 期间这个对话保留一个 CLI 进程，值越大越省重开的时间，同时挂着的进程也越多
   */
  presenceGraceMinutes: z.number().int().min(0).max(1440).default(60),
  /** Agent 选「系统默认」时使用的 CLI */
  defaultCli: z.string().default('claude'),
  clis: z.record(z.string(), CliSettings).default({}),
  /** 全局的 API：配一次，每个 CLI 都能选用（协议对得上的） */
  apis: z.array(ApiConfig).default([]),
  /** CLI 的显示顺序（设置侧栏、默认 CLI、Agent 的 CLI 选项）；没列出的排在后面 */
  cliOrder: z.array(z.string()).default([]),
  /** 服务启动后用默认浏览器打开面板（只在托管了前端页面时生效，开发模式下页面在 Vite 那边） */
  openBrowser: z.boolean().default(true),
  /** 网络代理：检查更新、下载新版本时用，例如 http://127.0.0.1:7890；为空时用环境变量 HTTPS_PROXY / HTTP_PROXY */
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
  /** 界面语言：auto 跟随浏览器 */
  language: z.enum(['auto', 'zh', 'en']).default('auto'),
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
