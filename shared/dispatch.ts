/**
 * 主 Agent 调度的提示词和结论格式。子 Agent 的节点完成后，执行引擎续接主 Agent 的会话把结果交给它，
 * 它在回复最后写一个 dispatch 代码块决定流程怎么走；流程结束时它整理最终结果。
 * 提示词固定用中文（和节点提示词一样，不跟界面语言走：结论靠固定格式识别）。
 */
import { END, START, type Agent, type Flow, type Workflow } from './schema.ts'
import { flowLabel, nodeAgent, nodeSteps, topoOrder } from './flow.ts'
import { t } from './i18n.ts'

/** 主 Agent 回复里写决定的代码块语言名 */
export const DISPATCH_LANG = 'dispatch'

export type Dispatch =
  | { action: 'continue'; branch?: 'pass' | 'fail'; note?: string }
  | { action: 'rework'; feedback: string }
  | { action: 'delegate'; workflow: string; input: string }
  | { action: 'stop'; reason: string }
  /** 常驻编排器：起一次新的运行（节点全部新建，按流程图执行） */
  | { action: 'run'; input?: string }
  /** 常驻编排器：重跑（当作用户要求重新走一遍，重新发起新的一次运行） */
  | { action: 'restart'; feedback: string }
  /** 常驻编排器：不起运行，直接回答用户 */
  | { action: 'answer' }

// 语言名后面可以跟别的字（```dispatch json），JSON 也可能和语言名写在同一行
const BLOCK = new RegExp('```' + DISPATCH_LANG + '\\b[^\\n{]*\\n?([\\s\\S]*?)```', 'g')
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** 读主 Agent 的决定（最后一个 dispatch 代码块）；没写或写坏了返回 null，调用方按「继续」处理并提示 */
export function parseDispatch(text: string): Dispatch | null {
  const last = [...text.matchAll(BLOCK)].at(-1)
  if (!last) return null
  let o: Record<string, unknown>
  try {
    const raw = JSON.parse(last[1].trim())
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    o = raw
  } catch {
    return null
  }
  const action = str(o.action).toLowerCase()
  const branch = str(o.branch).toLowerCase()
  switch (action) {
    case 'run':
    case 'start':
      return { action: 'run', ...(str(o.input) || str(o.note) ? { input: str(o.input) || str(o.note) } : {}) }
    case 'restart':
    case 'rerun':
      return { action: 'restart', feedback: str(o.feedback) || str(o.reason) || str(o.note) }
    case 'answer':
    case 'reply':
      return { action: 'answer' }
    case 'rework':
    case 'retry':
      return { action: 'rework', feedback: str(o.feedback) || str(o.reason) || str(o.note) }
    case 'delegate':
      return str(o.workflow) ? { action: 'delegate', workflow: str(o.workflow), input: str(o.input) } : null
    case 'stop':
    case 'fail':
      return { action: 'stop', reason: str(o.reason) || str(o.feedback) }
    case 'continue':
    case 'pass':
    case 'next':
      return {
        action: 'continue',
        ...(branch === 'pass' || branch === 'fail' ? { branch } : {}),
        ...(str(o.note) ? { note: str(o.note) } : {}),
      }
    default:
      return null
  }
}

/** 显示时去掉 dispatch 代码块（界面另外画一行「主 Agent 的决定」）；流式输出到一半时去掉到结尾 */
export function stripDispatch(text: string) {
  if (!text.includes('```' + DISPATCH_LANG)) return text
  return text
    .replace(BLOCK, '')
    .replace(new RegExp('```' + DISPATCH_LANG + '\\b[\\s\\S]*$'), '')
    .trimEnd()
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 主 Agent 看到的流程概览：每个节点谁做、做什么，以及连线 */
export function flowOverview(w: Workflow, f: Flow, agents: Agent[]) {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? '主 Agent'
  const title = (id: string) =>
    id === START ? '开始' : id === END ? '结束' : `「${f.nodes.find((n) => n.id === id)?.title || '未命名节点'}」`
  const nodes = topoOrder(f).map((n) => {
    const units = nodeSteps(n)
    const who = units
      .map((u) =>
        u.kind === 'flow'
          ? '调用流程'
          : nodeAgent(w, u.agentId) === w.mainAgentId
            ? `${name(w.mainAgentId)}（你自己）`
            : name(u.agentId),
      )
      .join(' → ')
    const what = units
      .map((u) => u.instructions.trim().split('\n')[0])
      .filter(Boolean)
      .join('；')
    return `- ${title(n.id)}：${who}${what ? `。${clip(what, 100)}` : ''}`
  })
  const edges = f.edges
    .filter((e) => e.from !== START && e.to !== END)
    .map(
      (e) => `- ${title(e.from)} → ${title(e.to)}${e.when ? `（${e.when === 'pass' ? '通过时' : '不通过时'}）` : ''}`,
    )
  return [`节点：\n${nodes.join('\n')}`, edges.length ? `连线：\n${edges.join('\n')}` : ''].filter(Boolean).join('\n\n')
}

/** 主 Agent 的职责和决定格式；others 是可以委派的工作流 */
export function mainDuties(
  w: Workflow,
  f: Flow,
  agents: Agent[],
  others: Pick<Workflow, 'id' | 'name' | 'description'>[],
) {
  const can = others
    .slice(0, 20)
    .map((x) => `- ${x.id}｜${x.name}${x.description ? `：${clip(x.description, 80)}` : ''}`)
  return [
    `你是工作流「${w.name}」流程「${flowLabel(f, w)}」的常驻编排器。这个对话从头到尾都由你负责：决定什么时候按流程图跑一次、跑完把结果整理给用户、之后接着处理用户的要求。节点交给各自的子 Agent 执行，完成后结果交给你评估，由你决定流程怎么走。`,
    `## 运行
- 一次「运行」是从开始节点起、按流程图顺序执行一遍：节点可以很多，但必须按连线的顺序走，同一层没有依赖的节点同时执行。这次运行走完就停下，不会自己再跑一遍。
- 用户的每条新要求由你决定：起一次新的运行（节点全部新建，按流程图再走一遍；你的会话保留，上一轮的结论还在），还是直接回答、不起运行。
- 每个对话同时只有一次运行在走；要重做就等下一次运行。
- 决定改动范围、文档格式、测试流程和版本管理时，按你 Agent 里带的 Skill 的规则做：文档要有固定结构和更新时机，测试要按项目的流程跑，版本管理的提交和推送保持一致。`,
    `## 流程\n${flowOverview(w, f, agents)}`,
    [
      '## 你的职责',
      '- 评估子 Agent 的结果：对照这个节点要做的事和用户需求，看结果是否完整、可信。主要看结果本身，必要时查看改动或跑只读命令核实。',
      '- 不要自己动手做节点的工作：要改就退回给那个节点，并写清楚改什么。',
      '- 子 Agent 向你提问时直接回答；你的回答会交回给它。',
      '- 评估时回复要短：一两句评价，再写决定。',
    ].join('\n'),
    [
      `## 决定的格式\n每次评估的回复最后写一个代码块，语言名写 ${DISPATCH_LANG}，内容是一个 JSON：`,
      '- `{"action": "continue"}`：通过，按流程继续。后面有条件连线时必须加 `"branch": "pass"` 或 `"branch": "fail"` 选路；可以加 `"note": "…"` 给后续节点交代要点。',
      '- `{"action": "rework", "feedback": "…"}`：退回给这个节点，按意见修改后再交给你评估。',
      can.length
        ? '- `{"action": "delegate", "workflow": "工作流 id", "input": "交给它的任务"}`：先交给另一个工作流处理（它有自己的主 Agent），结果回来后再评估这个节点。'
        : '',
      '- `{"action": "stop", "reason": "…"}`：遇到不能继续的问题（需求矛盾、不可逆的风险、反复退回仍做不好），停下交给用户。',
      '- 用户提出新要求、这次运行已经走完时：`{"action": "run", "input": "这次要做什么"}` 起一次新的运行（节点全部新建，按流程图再走一遍）；`{"action": "restart", "feedback": "哪里没做好"}` 重做；`{"action": "answer"}` 直接回答、不起运行。',
    ]
      .filter(Boolean)
      .join('\n'),
    can.length ? `## 可以委派的工作流\n${can.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 节点完成后交给主 Agent 评估的事件 */
export function evaluateEvent(o: {
  title: string
  agent: string
  instructions: string
  result: string
  /** 第几次评估这个节点（从 1 开始） */
  round: number
  /** 还能退回几次 */
  reworksLeft: number
  /** 后面的条件分支：通过 / 不通过时去哪 */
  branches?: { pass: string; fail: string }
  /** 委派的结果、收到的消息等补充 */
  extra?: string
}) {
  return [
    `## 事件：节点完成\n节点「${o.title}」（${o.agent}）交回了结果，这是对它的第 ${o.round} 次评估。`,
    o.instructions.trim() ? `### 这个节点要做的事\n${clip(o.instructions.trim(), 1500)}` : '',
    `### 它的结果\n${o.result.trim() || '（没有文字输出）'}`,
    o.extra ?? '',
    o.branches
      ? `### 后面的分支\n通过时走${o.branches.pass || '（没有）'}，不通过时走${o.branches.fail || '（没有）'}。dispatch 里必须写 branch。`
      : '',
    o.reworksLeft > 0 ? `还可以退回 ${o.reworksLeft} 次。` : '退回次数已经用完，这次只能继续或停下。',
    `请评估，回复最后写 ${DISPATCH_LANG} 代码块。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 常驻编排器收到用户的新要求（这次运行已经走完）：说清楚现在的情况，让它决定怎么处理。
 * notes 是这次运行没能走通的地方（停住的节点、不通过的原因）
 */
export function planEvent(prompt: string, run: number, blocked?: { title: string; output: string }) {
  return [
    `## 事件：用户的新要求\n针对这个对话，用户说：\n${prompt}`,
    `这是第 ${Math.max(1, run)} 次运行。之前的运行已经走完（节点全部完成），结果已经交给用户。`,
    blocked
      ? `上一次运行停在节点「${blocked.title}」：它的结论是不通过，后面的节点没有执行。它的结果：\n${clip(blocked.output, 3000)}`
      : '',
    [
      '## 你要决定怎么处理',
      '需求是新的、要再走一遍流程（实现、验收、文档、提交这些按流程图来）时，起一次新的运行：节点全部新建，按流程图顺序执行，上一轮的结果作为参考。',
      '同一件事没做好要重做时，也起新的运行，把要做的事写清楚。',
      '只是问问题、解释、查一下情况，或者改动小到不值得走流程时，直接回答，不起运行。',
    ].join('\n'),
    '回复最后写一个 dispatch 代码块说明决定，见上面的格式。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 常驻编排器收到这个项目对话的要求时（还没有起过运行）：先分析，再决定起不起运行。
 * first 表示这是第一条要求；前面已经直接回答过几条时用「用户的新要求」。
 */
export function firstPlanEvent(prompt: string, first = true) {
  return [
    first ? `## 事件：这个对话的第一条要求\n用户说：\n${prompt}` : `## 事件：用户的新要求\n用户说：\n${prompt}`,
    first
      ? '这个对话还没有执行过流程图。先分析这条要求，再决定怎么处理。'
      : '这个对话还没有执行过流程图（前面只是直接回答）。先分析这条要求，再决定怎么处理。',
    [
      '## 你要决定怎么处理',
      '要按流程图做的事（需求、方案、实现、测试、文档、交付这些按流程图来）时，起一次运行：把这次要做的事写进 input，节点会按顺序执行。',
      '只是问问题、解释、查一下情况，或者改动小到不值得走流程时，直接回答，不起运行。',
    ].join('\n'),
    '回复最后写一个 dispatch 代码块说明决定，见上面的格式。',
  ].join('\n\n')
}

/** 流程完成后请主 Agent 整理最终结果；nested 表示结果交回上一级流程而不是用户 */
export function summaryEvent(results: { title: string; text: string }[], nested: boolean) {
  let room = 12000
  const parts = results.map((r) => {
    const body = clip(r.text.trim() || '（没有文字输出）', Math.max(400, Math.min(3000, room)))
    room -= body.length
    return `### ${r.title}\n${body}`
  })
  return [
    `## 事件：流程完成\n所有节点都完成了，下面是各节点的结果。`,
    parts.join('\n\n'),
    nested
      ? '请把结果整理成交回上一级流程的输出：结论、做了什么、改了哪些文件、怎么验证的、遗留问题。'
      : '请整理交给用户的最终结果：开头一两句直接给结论，再列做了什么、改了哪些文件、怎么验证的，最后写遗留问题和需要用户决定的事。',
    `这一轮不用写 ${DISPATCH_LANG} 代码块。`,
  ].join('\n\n')
}

/** 子 Agent 向主 Agent 提问 */
export function questionEvent(from: string, question: string) {
  return `## 事件：子 Agent 提问\n「${from}」问你：\n${question.trim()}\n\n请直接回答，回答会原样交给它。这一轮不用写 ${DISPATCH_LANG} 代码块。`
}

/** 决定的一句话说明（任务里的系统消息，跟界面语言） */
export function dispatchText(d: Dispatch, title: string) {
  switch (d.action) {
    case 'continue': {
      const head = d.branch
        ? t('主角色评估「{title}」：通过，走「{branch}」分支', {
            title,
            branch: d.branch === 'pass' ? t('通过') : t('不通过'),
          })
        : t('主角色评估「{title}」：通过', { title })
      return d.note ? `${head}${t('。交代后续：{note}', { note: d.note })}` : head
    }
    case 'rework':
      return t('主角色把「{title}」退回修改：{feedback}', { title, feedback: d.feedback || t('（没有写具体意见）') })
    case 'delegate':
      return t('主角色把「{title}」相关的事委派给工作流「{workflow}」', { title, workflow: d.workflow })
    case 'stop':
      return t('主角色停下了流程：{reason}', { reason: d.reason || t('（没有写原因）') })
    case 'run':
      return t('主角色起了新的一次运行：{input}', { input: d.input || t('按流程图再走一遍') })
    case 'restart':
      return t('主角色重做这次运行：{feedback}', { feedback: d.feedback || t('（没有写具体原因）') })
    case 'answer':
      return t('主角色直接回答，没有起运行')
  }
}
