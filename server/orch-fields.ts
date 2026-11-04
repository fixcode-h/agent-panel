/**
 * 面板编排工具（orch-mcp.ts）共用的参数定义：交给哪个角色、档位、续接、整批默认值、分诊记录、计划步骤这些字段，
 * 以及把它们从工具参数里取出来的函数。从 orch-mcp.ts 按功能拆出来（行数上限，见 docs/lessons/file-caps.md）
 */
import type { HelperSpec, Orchestra, RouteInput } from '../shared/engine.ts'

/** 交给哪个 Agent：列出通用 Agent，模型不用猜名字 */
export function agentField(o: Orchestra) {
  const list = o.common.map((a) => `「${a.name}」${a.description ? `（${a.description}）` : ''}`).join('、')
  // 子对话里点名这类角色时不在本地跑：结果在父对话那边，不能让调用方以为要在这里等
  const hand = o.child
    ? '点名「禁止子对话执行」的角色（例如「文档」）时不会在这里跑：面板会转交父对话创建，点名的计划步骤立即标完成，不用等它的结果。'
    : ''
  return {
    type: 'string',
    description: `交给哪个角色（名字）；不写用必备角色「子任务」${list ? `。也可以点名这些通用角色：${list}` : ''}${hand ? `。${hand}` : ''}`,
  }
}

/** 评审交接单：只收认得的字段，空的不带 */
export function briefOf(v: unknown): HelperSpec['review'] {
  if (!v || typeof v !== 'object') return undefined
  const b = v as Record<string, unknown>
  const s = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string) : undefined)
  const files = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === 'string' && !!f.trim()) : []
  return {
    goal: s('goal'),
    changes: s('changes'),
    checks: s('checks'),
    focus: s('focus'),
    context: s('context'),
    ...(files.length ? { files } : {}),
  }
}

/** 子任务的模型档位 */
export const tierField = () => ({
  type: 'string',
  enum: ['high', 'medium', 'low'],
  description:
    '模型档位：要读代码、做判断的用默认档；删文件、跑命令、提交、勾选清单这类纯执行动作写 low，不要按父对话的档位跑',
})

/** 接着之前哪个子任务（它的 id）的会话做 */
export const RESUME_DESC =
  '接着之前哪个子任务（它的 id，例如 chat/sub/h1）的会话做：复看的评审接着上一次评审，它读过的文档、代码和给过的意见都还在，只交给它增量。失败、被终止或中断的子任务要重试也写它的 id：就在原来那个子任务里接着做（同一个 id 和会话），不要另派一个新的。那个子任务要已经结束；agent 不写或写同一个角色'

/** top：写在 spawn_agents 顶层。一个会话只能接着跑一轮，所以顶层只配一个任务时才允许 */
export const resumeField = (top = false) => ({
  type: 'string',
  description: top ? `${RESUME_DESC}。只派一个任务时才能写在顶层，一次派多个时写进对应那一项` : RESUME_DESC,
})

/** 顶层 agent / tier 是整批的默认值：单个任务里写了以任务里的为准 */
export const BATCH_NOTE = '。也可以写在 spawn_agents 的顶层整批共用；单个任务里写了以任务里的为准'

/** 给字段描述补上「可以写在顶层」的说明 */
export const batchField = <T extends { description: string }>(f: T) => ({
  ...f,
  description: `${f.description}${BATCH_NOTE}`,
})

/** spawn_agents 顶层认得的字段：其余字段不静默丢掉（写错名字的 resume 一丢，复看就换了角色和会话） */
export const SPAWN_TOP_FIELDS = ['tasks', 'step', 'agent', 'tier', 'resume', 'params', 'route']

/** 派出的角色参数：角色有几种做法（「测试验收」的 task）时靠它点名，不写按挂载上的或角色默认的 */
export const paramsField = () => ({
  type: 'object',
  description:
    '角色参数（可选），例如派「测试验收」清理用例写 {"task": "清理用例"}：只认这个角色声明过的参数和选项，写错会被拒绝；不写按挂载上的或角色默认的，resume 时不写沿用上一次的',
})

/**
 * 分诊记录（父对话派单时写）：面板画成分诊卡，用户不同意可以一键改派。
 * 只给能分派子对话的父对话出这个字段，子对话、节点派子任务不用写
 */
export const routeField = () => ({
  type: 'object',
  description: '分诊记录：你怎么理解这条消息、为什么这样分、替用户做了什么假设。面板画成分诊卡，用户不同意可以一键改派',
  properties: {
    understanding: { type: 'string', description: '一句话复述用户要什么' },
    reason: { type: 'string', description: '为什么分到这里（而不是就地做 / 派子任务 / 交子对话）' },
    assumptions: { type: 'string', description: '替用户做的假设；没有不写' },
  },
})

/** 读 route 参数：只收认得的字段，全空就当没写 */
export function routeOf(v: unknown): RouteInput | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
  const out = { understanding: s('understanding'), reason: s('reason'), assumptions: s('assumptions') }
  return out.understanding || out.reason || out.assumptions ? out : undefined
}

export const tasksField = (o: Orchestra) => ({
  type: 'array',
  description: '每一项是一个子任务，互相之间不能有依赖',
  items: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          '子任务的短标题（显示在任务进度里），10–20 字，点明这次的具体对象或范围；同一批不能有两个相同的标题。不写取 instructions 的第一行（都这样省事就会一批同一个标题）',
      },
      instructions: {
        type: 'string',
        description:
          '要做什么、范围、产出：写清各自的模块或目录、要交付什么、验收标准；派「文档」时给出要记什么和依据在哪（提交号、文件路径、命令输出、关键结论）；子任务只看得到这些和用户需求，不要把同一段话发给多个任务',
      },
      agent: agentField(o),
      tier: tierField(),
      resume: resumeField(),
      params: paramsField(),
      review: {
        type: 'object',
        description:
          '派「评审」看代码改动时的交接单（第一次评审必填 goal 和 checks，复看不用）：把你已经知道的整理给它，评审只看改动的代码，不再自己读文档、搜项目去还原背景',
        properties: {
          goal: { type: 'string', description: '这次改动要达成什么、验收标准（有口径的连口径）' },
          changes: { type: 'string', description: '改了什么、为什么这样改：按文件或模块一两句' },
          checks: { type: 'string', description: '已经跑过的检查：每条「命令 + 结果」' },
          focus: { type: 'string', description: '希望重点看的风险点' },
          context: {
            type: 'string',
            description:
              '判断要用、差异里又看不到的事实：调用方怎么用、上游保证了什么、相关接口签名（从你读过的代码里摘）',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '要评审的文件（相对项目根）：只取这些文件的差异；不写取这个对话改过的全部文件',
          },
        },
      },
    },
    // title 不必填：缺了引擎取 instructions 第一行（见 engine.ts 的 spawn），因为漏写标题被拒、白费一次调用不值
    required: ['instructions'],
  },
})

/** 计划步骤：开出去的等待挂在哪一步上 */
export const stepField = (what: string) => ({
  type: 'string',
  description: `计划里哪一步在等${what}（步骤 id，见 set_plan 返回的计划）：这一步会标成等待中，结果回来自动推给你；不在计划里的不写`,
})

export const planItem = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '已有步骤的 id（set_plan 返回的计划里有）；新步骤不写' },
    title: { type: 'string', description: '步骤名：要做的一件事，10–30 字' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'waiting', 'done', 'skipped'],
      description:
        '待做 / 进行中 / 等待中 / 完成 / 跳过。没有「失败」：没做成就是还要修，保持进行中、查清原因修好重做；确实不做了才标跳过，note 写原因',
    },
    note: { type: 'string', description: '一句备注：在等什么、卡在哪；没有不写' },
    review: {
      type: 'boolean',
      description:
        '这一步是评审本次改动（子对话收尾前必须有这样一步：派「评审」时标等待中、拿回结论后标完成）。没标的话 submit_merge 会被拒绝',
    },
  },
  required: ['title'],
}
