/**
 * 编排工具背后的状态和子任务收口：派出的子 Agent 在跑哪些、信箱、交回结果怎么拼、评审的交接单和差异、get_status 的状态树。
 * makeOrchestra 仍在 engine.ts，这里只放它调用的部分（engine.ts 贴着行数上限时整块挪出来的）
 */
import type { Agent, ParamValues, TaskStep } from './schema.ts'
import { isMainStep } from './flow.ts'
import { clip } from './text.ts'
import { runMail, sendRunMessage } from './run-state.ts'
import { layeredBatch } from './helper-batch.ts'
import { approvedBrief, requestLogs, submitDiagnosis, updateBugCase, type DiagnosisInput } from './bug-diagnosis.ts'
import { resultLine, resultOf } from './helper-summary.ts'
import { changedFilesPart } from './wrapup-prompt.ts'
import { REVIEW_SOFT_LIMIT_MIN } from './review-limits.ts'
import type { HelperSpec, ReviewBrief, HelperReport, HelperBatch, EngineHost } from './engine-host.ts'
import { activePlan, settleWait } from './plan.ts'
import { SLOT_PROMPT } from './engine-prompt-parts.ts'

/** 一个节点最多派几个子 Agent */
export const MAX_HELPERS_PER_STEP = 12
/** resume 对不上时报错里列出的最近子任务数：够模型认出正确 id，多了反而是干扰 */
export const MAX_RESUME_IDS = 8

/** resume 报错里列子任务的写法：和终止子任务的列表（stop_helpers）同一写法 */
export const helperLabel = (s: TaskStep) => `${s.id}｜${s.title}`

/**
 * resume 该接着哪条子任务：先按全等找，再按 id 的路径段结尾找。
 * 模型常把「a/step/s1/sub/h1」写成「sub/h1」，只按全等比就整批被拒、重试一次白花一轮；
 * 结尾必须落在「/」上，「xsub/h1」也算不上；能对上多条时不猜，交给调用方报候选。
 */
export const resumeTarget = (mine: TaskStep[], raw: string) => {
  // 对话里派的 id 以「@chat」开头，模型常丢掉「@」（@ 在 CLI 里多是引用文件）：两边都去掉开头的 @ 再比
  const bare = (x: string) => x.replace(/^@/, '')
  const id = bare(raw)
  const exact = mine.find((s) => bare(s.id) === id)
  const picked = exact ? [exact] : mine.filter((s) => s.id.endsWith(`/${id}`))
  return { prev: picked.length === 1 ? picked[0] : undefined, picked }
}

interface OrchState {
  /** 节点 id → 还没读的消息 */
  mail: Map<string, string[]>
  /** 子 Agent 的节点 id → 执行它的 Promise */
  helpers: Map<string, Promise<void>>
  /** 子 Agent 失败的原因 */
  errors: Map<string, string>
  /** 结果已经交回给派它的节点的子 Agent */
  delivered: Set<string>
  /** 对话 / 节点 id → 正在等的这一批子任务 */
  batches: Map<string, Promise<HelperBatch>>
  /** 节点 id → 叫醒它的 wait_agents（有人给它传话时提前返回，不让话晚十几分钟才到） */
  wakers: Map<string, () => void>
}
const orchStates = new WeakMap<EngineHost, OrchState>() // 模块状态：运行时，按引擎宿主记，宿主重建后从头来

/** 这个对话已经 use_capability 加载过的能力（按调用者 + 能力 + 参数）：重复加载只回一句，不再整段返回 */
export const loadedCaps = new WeakMap<EngineHost, Set<string>>() // 模块状态：运行时，按引擎宿主记，宿主重建后从头来

export function orchState(host: EngineHost): OrchState {
  let st = orchStates.get(host)
  if (!st) {
    st = {
      mail: new Map(),
      helpers: new Map(),
      errors: new Map(),
      delivered: new Set(),
      batches: new Map(),
      wakers: new Map(),
    }
    orchStates.set(host, st)
  }
  return st
}

/** 取走发给这个节点的消息：新架构从运行记录里取，旧任务用内存信箱 */
export function takeMail(host: EngineHost, id: string) {
  const st = orchState(host)
  const got = st.mail.get(id) ?? []
  st.mail.delete(id)
  return [...got, ...runMail(host, id)]
}
export function putMail(host: EngineHost, id: string, text: string) {
  // 新架构每次运行有自己的记录：写进去，重启后还在，界面上也能看到
  orchState(host).wakers.get(id)?.()
  if (sendRunMessage(host, '', id, text)) return
  const st = orchState(host)
  st.mail.set(id, [...(st.mail.get(id) ?? []), text])
}

const STATUS_TEXT: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

export function helperReport(host: EngineHost, s: TaskStep): HelperReport {
  const st = orchState(host)
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    ...(s.status === 'done' ? { output: s.output } : {}),
    ...(st.errors.get(s.id) ? { error: st.errors.get(s.id) } : {}),
  }
}

export const REVIEW_SOFT_LIMIT_MS = REVIEW_SOFT_LIMIT_MIN * 60_000
export const REVIEW_WRAP_NOTE = `【面板提醒】评审已经进行了 ${REVIEW_SOFT_LIMIT_MIN} 分钟：停止再读代码，按目前已确认的意见马上交卷（调用 submit_verdict 交结论，必须处置的意见列进 blockers）；没来得及确认的标「可能」，没看完的文件单列「没看完」。`

/** 这个角色是不是在评审代码改动（必备角色「评审」、评审对象是代码改动）；评审方案或结论的不算 */
export function reviewsCode(agent: Agent | undefined, params?: ParamValues) {
  if (agent?.origin !== 'builtin:reviewer') return false
  const target = params?.target ?? agent.params.find((p) => p.key === 'target')?.default
  return !target || target === '代码改动'
}

/** 交回时不分份额、整段交的：评审代码的意见要逐条处置 */
export const wholeReport = (host: EngineHost) => (k: TaskStep) =>
  reviewsCode(
    host.agents.find((a) => a.id === k.agentId),
    k.params,
  )

/** 派评审代码时交接单缺了必填的，返回要补什么；不缺返回空 */
export function briefMissing(spec: HelperSpec) {
  const b = spec.review
  const lack = [!b?.goal?.trim() && 'goal（需求和验收标准）', !b?.checks?.trim() && 'checks（跑过的检查：命令 + 结果）']
  return lack.filter(Boolean).join('、')
}

/** 交接单写进评审的提示词：对话整理好的就是评审要用的全部背景 */
export function briefPart(b: ReviewBrief | undefined) {
  if (!b) return ''
  const rows = [
    ['要达成什么、验收标准', b.goal],
    ['改了什么、为什么', b.changes],
    ['已经跑过的检查', b.checks],
    ['重点看', b.focus],
    ['差异里看不到的背景', b.context],
  ].filter((r): r is [string, string] => !!r[1]?.trim())
  if (!rows.length) return ''
  return `## 评审交接单（派你的对话整理）\n这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。\n\n${rows.map(([k, v]) => `### ${k}\n${v.trim()}`).join('\n\n')}`
}

/**
 * 派的是「评审」时，面板把要评审的改动一次带进提示词（ADR 0010、0013）：接着上一轮评审的会话就只带那之后的增量；
 * 交接单写了 files 的只取那几个文件。读不到（不是 git 仓库、git 出错）时不带，评审照它的角色设定自己取 diff
 */
export async function reviewPart(host: EngineHost, step: TaskStep, spec: HelperSpec) {
  const agent = host.agents.find((a) => a.id === step.agentId)
  if (agent?.origin !== 'builtin:reviewer') return ''
  const brief = [briefPart(spec.review), approvedBrief(host.task)].filter(Boolean).join('\n\n')
  if (!host.reviewDiff)
    return [brief, changedFilesPart(host.task.changes.map((c) => c.path))].filter(Boolean).join('\n\n')
  const key = step.session || ''
  const prev = key
    ? host.task.steps.filter((s) => s !== step && (s.session || s.id) === key && s.snapshot).at(-1)
    : undefined
  const files = (spec.review?.files ?? []).map((f) => f.trim()).filter(Boolean)
  const d = await host.reviewDiff(prev?.snapshot, files.length ? files : undefined).catch(() => null)
  if (!d) return brief
  step.snapshot = d.snapshot
  // P4 没有快照（snapshot 为空）：差异是 p4 diff，和工作区的 have 版本比
  const what = prev
    ? '上一轮评审之后的增量'
    : d.snapshot
      ? '这次的全部改动（和任务开始时比）'
      : '这次改过的文件的改动（p4 diff，和工作区的 have 版本比）'
  if (!d.stat) return [brief, `## 要评审的改动\n${what}：没有改动。`].filter(Boolean).join('\n\n')
  const body = d.diff
    ? `\`\`\`diff\n${d.diff}\n\`\`\``
    : d.file
      ? `差异太长，没有放进来：完整差异在文件 ${d.file}，先读它。`
      : '差异太长，没有放进来：按上面的文件列表自己取 diff。'
  const part = `## 要评审的改动\n面板已经取好了${what}，不用再自己取 diff。每处改动前后带几行没改的代码，只是帮你看懂改动接在哪里：**只评以 + / - 开头的行**，上下文里没改的代码不评。锁文件、压缩产物这类生成的文件只在列表里，不用评。\n\n改动文件：\n\`\`\`\n${d.stat}\n\`\`\`\n\n${body}`
  return [brief, part, d.semantic].filter(Boolean).join('\n\n')
}

/** 子任务真的结束了（不是还在排队或跑着）：状态定了，或者还没开工但已经没在跑 */
export function helperOver(host: EngineHost, k: TaskStep) {
  const st = orchState(host)
  return k.status !== 'running' && (k.status !== 'pending' || !st.helpers.has(k.id))
}

/**
 * 子任务都结束了：把计划里等它们的那一步收口（kind: 'helper'）。成功标完成、失败或终止退回进行中并写清原因。
 * 按「计划里还挂着的 helper 等待」遍历，不只看这一批：老会话里 wait_agents 取走过的，这一批轮不到，那一步会永远等着
 */
export function settleHelperWaits(host: EngineHost) {
  const { task } = host
  // 只看在用的这份计划：settleWait 也按 activePlan 找步骤，旧计划里残留的等待项永远收不了口，
  // 每次交回结果都把那些死项重扫一遍没意义
  const plan = activePlan(task)
  const waiting = new Set(
    (plan?.steps ?? []).flatMap((s) => [s, ...s.children]).flatMap((x) => x.waits.filter((w) => w.kind === 'helper')),
  )
  const hit: { title: string; done: boolean }[] = []
  // 集合已经按 kind === 'helper' 筛过，这里只看还没收口的
  for (const w of waiting)
    if (w.state === 'waiting') {
      const kid = task.steps.find((s) => s.id === w.ref)
      if (kid && helperOver(host, kid)) hit.push(...settleWait(task, 'helper', w.ref, helperDone(kid)))
    }
  if (hit.length) host.changed(true)
  return hit
}

/**
 * 子任务算不算做完（计划里等它的那一步据此收口）：正常结束，并且交了结果「做完」或评审交了结论（ADR 0041 第 16 节）。
 * 没交、交的是没做完 / 卡住：那一步退回进行中，由派它的对话按自己的计划处理
 */
const helperDone = (kid: TaskStep) =>
  kid.status === 'done' && (resultOf(kid) === 'done' || (!!kid.submitted?.verdict && !resultOf(kid)))

/** 子任务没做完时交回结果里带的一句：重试要在原来的子任务里接着做，不另派一个 */
const RETRY_HINT = (id: string) =>
  `（要重试就调用 spawn_agents，resume 写「${id}」：在原来这个子任务里接着做，不要另派一个新的）`

/** 节点结束前等它派出的子 Agent 都结束，返回它没取回的结果（并进节点的输出） */
export async function settleHelpers(host: EngineHost, step: TaskStep) {
  return (await settleHelperBatch(host, step)).text
}

/** 同上，另外带上这一批交回结果的是哪几个子任务（步骤 id）：对话里那一行按它数个数 */
export async function settleHelperBatch(host: EngineHost, step: TaskStep): Promise<{ text: string; ids: string[] }> {
  const st = orchState(host)
  const kids = () => host.task.steps.filter((s) => s.parentId === step.id && s.slot === 'sub')
  // 等的这段时间里对话可能又派了几个（用户插进来聊的那一轮）：它们算进同一批，一起交回
  for (let n = -1; n !== kids().length;) {
    n = kids().length
    await Promise.all(kids().map((k) => st.helpers.get(k.id) ?? Promise.resolve()))
  }
  const late = kids().filter((k) => !st.delivered.has(k.id) && st.helpers.has(k.id))
  for (const k of late) st.delivered.add(k.id)
  // 计划里等这些子任务的步骤跟着收口：成功标完成，失败/被终止退回进行中
  settleHelperWaits(host)
  const outputs = await layeredBatch(host.saveHandoff, late, wholeReport(host))
  const text = late
    .map((k) =>
      k.status === 'done'
        ? `### ${k.title}${k.submitted?.verdict ? '' : resultLine(k)}\n${outputs.get(k.id) ?? (k.output || '（没有文字输出）')}`
        : (k.status === 'skipped' && st.errors.get(k.id)
            ? `### ${k.title}\n（${clip(st.errors.get(k.id)!, 300)}）`
            : `### ${k.title}\n（${STATUS_TEXT[k.status] ?? k.status}${st.errors.get(k.id) ? `：${clip(st.errors.get(k.id)!, 300)}` : ''}）`) +
          `\n${RETRY_HINT(k.id)}`,
    )
    .join('\n\n')
  return { text, ids: late.map((k) => k.id) }
}

/** 任务里各个 Agent 的状态，按层级缩进，给 get_status 用 */
export function statusTree(host: EngineHost, self: string) {
  const { task } = host
  const name = (id: string) => host.agents.find((a) => a.id === id)?.name ?? ''
  const lines: string[] = []
  const ids = new Set(task.steps.map((s) => s.id))
  // 对话里派的子 Agent 挂在 @chat 下，@chat 自己不是 steps 里的一条：父节点不在的步骤也当作顶层列出来，
  // 否则对话里派出的子 Agent 一个都查不到（get_status 显示「还没有节点」）
  const roots = task.steps.filter((s) => !s.parentId || !ids.has(s.parentId))
  const kidsOf = (pid: string) => task.steps.filter((s) => s.parentId === pid)
  const walk = (list: TaskStep[], depth: number) => {
    // 主 Agent 排在它调度的节点前面
    for (const s of [...list].sort((a, b) => Number(isMainStep(b)) - Number(isMainStep(a)))) {
      if (lines.length >= 80) return
      const label = s.parentId && !isMainStep(s) ? `${SLOT_PROMPT[s.slot] ?? ''} · ${s.title}` : s.title
      const who = name(s.agentId)
      const out = s.status === 'done' && s.output ? `：${clip(s.output.replace(/\s+/g, ' '), 100)}` : ''
      lines.push(
        `${'  '.repeat(depth)}- ${s.id}｜${label}${who ? `（${who}）` : ''}${s.id === self ? '【你】' : ''}：${STATUS_TEXT[s.status] ?? s.status}${out}`,
      )
      walk(kidsOf(s.id), depth + 1)
    }
  }
  walk(roots, 0)
  return lines.join('\n') || '（还没有节点）'
}

/** 交诊断报告（ADR 0045）：记进任务、挂成等用户确认的请求，马上落盘让界面看到 */
export function diagnoseTask(host: EngineHost, input: DiagnosisInput, draft?: boolean | 'logs') {
  const r =
    draft === 'logs'
      ? requestLogs(host.task, input)
      : draft
        ? updateBugCase(host.task, input)
        : submitDiagnosis(host.task, input, host.newId, undefined, host.bugSource)
  if (r.ok) host.changed(true)
  return r
}

/** 编排工具，绑定在调用它的节点上（主 Agent 的调度轮也有一份） */
