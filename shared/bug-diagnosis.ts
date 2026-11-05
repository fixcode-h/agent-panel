/**
 * Bug 先交报告、用户同意了再往下走（ADR 0045；按阶段走见 bug-phase.ts）：纯函数，引擎、服务端和界面共用。
 * - 子对话（父对话派来的 Bug，task.bug）每到一个关口用 submit_diagnosis 交一版报告（submitDiagnosis），这一轮结束：
 *   论证（要加的日志）→ 根因 → 修复方案 → 验证。等用户期间对话算执行中（convState 的 diagnosis），
 *   交报告那一行工具调用一直转圈、上面有「查看报告」（用户 2026-11-03 定的）。
 * - 用户在审阅弹窗里同意、标疑问、贴日志或取消（decideDiagnosis），结果作为新消息交回子对话（diagnosisFeedback）。
 *   不跟「提问」开关走：总是用户确认，父对话不代为确认（用户 2026-11-03 定的）。
 * - 同意加日志后，AI 加好日志用 request_logs 请用户复现（requestLogs），那一版回到等用户。
 * - 收尾（submit_merge）前核对：要有确认过的方案、交过验证且用户给了结果或点了结束，改动不超出方案里的文件（diagnosisGate）。
 * 交给 Agent 的话是提示词，不翻译；报告的小节名、对话里的提示、请求标题是界面文案，走 t()。
 */
import type { Task, TaskMessage } from './schema.ts'
import { BugCase, BugCollect, type BugLevel, type Diagnosis, type DiagnosisNote } from './bug-diagnosis-schema.ts'
import {
  causeAgreed,
  evidenceFiles,
  inputPhase,
  lastPlan,
  logFilesOf,
  normPath,
  PHASE_TEXT,
  phaseFeedback,
  phaseOf,
  planApproved,
} from './bug-phase.ts'
import { t } from './i18n.ts'
import { settlePlan } from './plan.ts'

export { blameLabel, diagnosisMarkdown } from './bug-diagnosis-md.ts'
export { phaseOf } from './bug-phase.ts'

type DiagTask = Pick<Task, 'bug' | 'diagnoses' | 'messages' | 'changes' | 'bugCase'>

/**
 * submit_diagnosis / update_bug_case 交上来的内容：工具的原始参数，按 BugCase 解析（字段写坏的当没写，不让一个字段挡住整份）。
 * answers 只有交报告时有：第 2 版起逐条回答上一版的意见；phase 是这一版的阶段
 */
export type DiagnosisInput = Record<string, unknown>

/** 档案里能写的字段：只认这些，别的键忽略 */
const CASE_KEYS = Object.keys(BugCase.shape).filter((k) => k !== 'updatedAt')

/** 原始参数里写了的档案字段（没写的不动草稿里已有的） */
const picked = (input: DiagnosisInput) =>
  Object.fromEntries(CASE_KEYS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]))

/** 草稿合上这次写的字段 */
const mergeCase = (task: Pick<Task, 'bugCase'>, input: DiagnosisInput) =>
  BugCase.parse({ ...(task.bugCase ?? {}), ...picked(input) })

const answersOf = (input: DiagnosisInput) =>
  (Array.isArray(input.answers) ? input.answers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: Number(x.id),
      answer: typeof x.answer === 'string' ? x.answer : '',
    }))
    .filter((x) => Number.isFinite(x.id) && x.answer.trim())

export const latestDiagnosis = (task: Pick<Task, 'diagnoses'>) => task.diagnoses?.at(-1)
export const pendingDiagnosis = (task: Pick<Task, 'diagnoses'>) => {
  const d = latestDiagnosis(task)
  return d?.status === 'pending' ? d : undefined
}

/** 要 Agent 回答的标注：疑问和改方案；补充信息只要用上，不用逐条回答 */
const needsAnswer = (n: DiagnosisNote) => n.kind !== 'info'

/** 影响面按名字对：忽略空白和大小写 */
const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase()

/** 不改方案也能顺带改的：测试、文档、翻译（修 Bug 本来就要补回归测试、回写文档） */
const FREE_FILE = /(^|\/)(tests?|__tests__|docs|locales?)\/|\.(test|spec)\.[^/]+$|\.md$/i

/** 实际改动里超出已确认范围的文件：范围里写目录（以 / 结尾）时目录下的都算 */
export function outOfPlan(changed: string[], files: string[]) {
  const plan = files.map(normPath).filter(Boolean)
  return changed
    .map(normPath)
    .filter((p) => p && !FREE_FILE.test(p))
    .filter((p) => !plan.some((f) => p === f || (f.endsWith('/') && p.startsWith(f))))
}

const LEVEL_TEXT: Record<BugLevel, string> = {
  quick: '快速',
  standard: '标准',
  deep: '深入',
}

const ATTRIBUTION_NEED =
  'attribution 要写版本归因：引入点（提交 / CL / rev、作者、日期、标题）、怎么确定的（how）和责任类别（category）；查不到写 category: unknown，note 写试过什么、还缺什么。'

/** 论证：日志计划、复现步骤、每种结果说明什么；logPlan、collect 要在这一次里写（每轮的日志不一样，不能沿用上一轮） */
function evidenceProblem(c: BugCase, input: DiagnosisInput): string {
  const lack: string[] = []
  if (!c.symptom.trim()) lack.push('symptom（现象）')
  if (!c.hypotheses.length) lack.push('hypotheses（这一轮要区分的假设，至少一个）')
  if (input.logPlan === undefined || !c.logPlan.length)
    lack.push('logPlan（这一轮要加的临时日志，每处写 file、print、hypothesis）')
  else if (c.logPlan.some((l) => !l.file.trim() || !l.print.trim()))
    lack.push('logPlan 每一处都要写 file（加在哪）和 print（打什么）')
  if (input.collect === undefined || !c.collect?.steps.length) lack.push('collect.steps（怎么复现）')
  if (!c.collect?.expect.trim()) lack.push('collect.expect（每种结果说明什么：看到 A 是哪个假设、看到 B 是哪个）')
  return lack.length
    ? `论证这一版还缺：${lack.join('；')}。还没定论就按这个交，用户同意后加日志、复现；根因已经证实就交 phase: cause。`
    : ''
}

/** 根因：证据链三环、引入点；标准以上要变更时间线和一致性，深入要两个假设 */
function causeProblem(c: BugCase): string {
  const need: [string, boolean][] = [
    ['symptom（现象）', !!c.symptom.trim()],
    ['stack 或 location（调用栈）', !!c.stack.length || !!c.location.trim()],
    ['evidence（证据链）', !!c.evidence.trim()],
    ['rootCause（根因）', !!c.rootCause.trim()],
  ]
  const empty = need.filter(([, ok]) => !ok).map(([label]) => label)
  if (empty.length) return `根因这一版缺这些小节：${empty.join('、')}。`
  if (!c.confirmed)
    return '根因还没证实（confirmed 是 false）：交 phase: evidence，写这一轮要加的日志，用户复现贴日志后再分析。'
  const a = c.attribution
  if (!a || (a.category === 'unknown' && !a.note.trim())) return ATTRIBUTION_NEED
  const full = c.level !== 'quick'
  const lack: string[] = []
  if (full && !c.timeline.some((x) => x.kind === 'change'))
    lack.push('timeline 里至少一条 kind: change 的变更时间线（从以前好过到现在变了什么）')
  if (full && !c.consistency.length) lack.push('consistency（根因怎么解释现象的每一条）')
  if (c.level === 'deep' && c.hypotheses.length < 2)
    lack.push('hypotheses 至少两个假设（已证实 / 已排除 / 待验证，各自依据）')
  return lack.length
    ? `${LEVEL_TEXT[c.level]}级别的根因还缺：${lack.join('；')}。觉得这个 Bug 没这么复杂，可以把 level 降成 quick 并在 levelNote 写理由（用户审阅时看得到）。`
    : ''
}

/** 修复方案：先有用户同意的根因；修法、文件、验证计划；标准以上要影响面和两个方案 */
function planProblem(c: BugCase, list: Diagnosis[]): string {
  if (!causeAgreed(list))
    return '还没有用户同意的根因：先交 phase: cause（论证还没定论交 phase: evidence），用户同意根因后再交修复方案。'
  const need: [string, boolean][] = [
    ['fix 或 options + chosen（修复方案）', !!c.fix.trim() || !!c.chosen?.id],
    ['verify（验证计划）', !!c.verify.trim()],
  ]
  const empty = need.filter(([, ok]) => !ok).map(([label]) => label)
  if (empty.length) return `修复方案缺这些小节：${empty.join('、')}。`
  if (!c.files.map(normPath).filter(Boolean).length)
    return 'files 要写方案里要改的文件（相对项目根）：确认后只放行这些文件，收尾时实际改动也按它核对。'
  const full = c.level !== 'quick'
  const lack: string[] = []
  if (full && !c.impact.length) lack.push('impact（影响面：每条写怎么受影响、怎么验证）')
  if (full && c.options.length < 2) lack.push('options 至少两个有实质区别的修法（五项比较）')
  if (c.options.length && !c.options.some((o) => o.id && o.id === c.chosen?.id))
    lack.push('chosen.id 要对上 options 里的一个方案')
  if (c.options.length && !c.chosen?.why.trim()) lack.push('chosen.why（为什么选它）')
  if (c.options.length >= 2 && !c.chosen?.whyNotOthers.trim()) lack.push('chosen.whyNotOthers（为什么不选别的）')
  if (c.options.length === 1 && !c.chosen?.whyNotOthers.trim())
    lack.push('chosen.whyNotOthers（只有一个方案时写为什么没有别的合理修法）')
  return lack.length
    ? `${LEVEL_TEXT[c.level]}级别的修复方案还缺：${lack.join('；')}。觉得这个 Bug 没这么复杂，可以把 level 降成 quick 并在 levelNote 写理由（用户审阅时看得到）。`
    : ''
}

/** 验证：先有确认过的方案并且修完；写清用户怎么验证；修完的结果要先记进档案 */
function verifyProblem(c: BugCase, list: Diagnosis[], input: DiagnosisInput): string {
  if (!planApproved(list)) return '还没有用户确认的修复方案：先交 phase: plan，用户确认、修完之后再交验证。'
  const lack: string[] = []
  if (input.collect === undefined || !c.collect?.steps.length) lack.push('collect.steps（用户怎么复现验证）')
  if (!c.collect?.expect.trim()) lack.push('collect.expect（看到什么算修好了）')
  if (!c.result?.regressionTests.length)
    lack.push(
      '先用 update_bug_case 的 result 记下修完的结果（regressionTests 回归测试、impactChecks 影响面逐条的验证）',
    )
  return lack.length ? `验证这一版还缺：${lack.join('；')}。` : ''
}

/**
 * 交上来的报告缺什么；没问题返回空串。按阶段、按级别查（ADR 0046 第 8 条）：只查结构齐不齐，内容对不对靠用户确认和评审
 */
export function diagnosisProblem(
  c: BugCase,
  list: Diagnosis[],
  answers: { id: number; answer: string }[] = [],
  input: DiagnosisInput = {},
): string {
  const prev = list.at(-1)
  if (prev?.status === 'pending')
    return prev.awaiting
      ? `第 ${prev.version} 版的日志已经加好、在等用户复现贴日志，不要再交：结束这一轮，等用户的日志。`
      : `第 ${prev.version} 版还在等用户确认，不要重复交：结束这一轮，等确认结果交回给你。`
  const phase = inputPhase(input, c, list)
  const bad =
    phase === 'evidence'
      ? evidenceProblem(c, input)
      : phase === 'cause'
        ? causeProblem(c)
        : phase === 'plan'
          ? planProblem(c, list)
          : verifyProblem(c, list, input)
  if (bad) return bad
  if (prev?.status === 'questioned') {
    const answered = new Set(answers.map((a) => a.id))
    const left = prev.notes.filter((n) => needsAnswer(n) && !answered.has(n.id)).map((n) => n.id)
    if (left.length)
      return `用户对第 ${prev.version} 版的这几条意见还没回答：${left.join('、')}。answers 里按编号逐条写：查了什么、结论、补了什么证据或改了哪一节。`
  }
  return ''
}

/** 查到哪个阶段了（ADR 0046）：按报告和草稿推算，父对话的子对话行上显示 */
export function bugStage(task: Pick<Task, 'bug' | 'bugCase' | 'diagnoses'>): string {
  if (!task.bug) return ''
  const list = task.diagnoses ?? []
  const d = list.at(-1)
  if (d) {
    const phase = phaseOf(d)
    if (d.status === 'cancelled') return t('已取消')
    if (d.status === 'pending') {
      if (d.awaiting) return t('等你复现')
      return phase === 'verify' ? t('等你验证') : t('等你确认')
    }
    if (phase === 'evidence') {
      const round = list.filter((x) => phaseOf(x) === 'evidence').length
      return t('论证 · 第 {n} 轮', { n: round })
    }
    if (phase === 'cause') return d.status === 'approved' ? t('修复设计') : t('根因')
    if (phase === 'plan') return d.status === 'approved' ? t('修复') : t('修复设计')
    return d.status === 'questioned' ? t('验证') : t('收尾')
  }
  const c = task.bugCase
  if (!c) return t('立案')
  if (c.options.length || c.impact.length) return t('修复设计')
  if (c.rootCause.trim() || c.attribution) return t('归因')
  if (c.timeline.length) return t('时间线')
  if (c.stack.length || c.location.trim()) return t('定位')
  return t('立案')
}

/** 草稿还缺什么才能交报告：按推出来的阶段查，交报告前还有的写给 Agent 看 */
const draftLeft = (c: BugCase, list: Diagnosis[]) => {
  const prev = list.at(-1)
  const base = prev?.status === 'pending' ? list.slice(0, -1) : list
  const phase = inputPhase({}, c, base)
  // 草稿阶段只看结构：logPlan、collect 交报告时再写
  const p = diagnosisProblem(c, base, [], { phase, logPlan: c.logPlan, collect: c.collect })
  return p
    ? `按现在的档案下一版是「${PHASE_TEXT[phase]}」，交之前还要补：${p}`
    : `下一版「${PHASE_TEXT[phase]}」需要的都齐了。`
}

/**
 * update_bug_case：往档案草稿里记（传哪个字段就换掉哪个字段，数组整组传）。
 * 排查记录跨轮次不丢，交新一版报告时自动带上；修完把结果（result）也记在这里，交验证和收尾时核对
 */
export function updateBugCase(
  task: Pick<Task, 'bug' | 'bugCase' | 'diagnoses'>,
  input: DiagnosisInput,
  now = new Date().toISOString(),
): { ok: boolean; info: string } {
  if (!task.bug)
    return {
      ok: false,
      info: '这不是用户报的 Bug，不用记档案：按简易版直接查和修。',
    }
  const keys = Object.keys(picked(input))
  if (!keys.length)
    return {
      ok: false,
      info: `没写任何档案字段。能写的字段：${CASE_KEYS.join('、')}。`,
    }
  task.bugCase = { ...mergeCase(task, input), updatedAt: now }
  const list = task.diagnoses ?? []
  const tail = planApproved(list)
    ? task.bugCase.result
      ? '修复结果已记下：交 phase: verify 请用户验证（collect 写怎么复现、看到什么算修好了）。'
      : '方案已确认：修完用 result 记下复现用例改前改后、影响面逐条的验证（area 对上报告里的影响面）、回归测试，再交 phase: verify。'
    : draftLeft(task.bugCase, list)
  return {
    ok: true,
    info: `已记进档案：${keys.join('、')}。现在在「${bugStage(task)}」。${tail}`,
  }
}

/**
 * 交一版报告：草稿合上这次交的内容，按阶段、级别检查后冻结成新的一版，上一版作废，等用户（不跟「提问」开关走）。
 * 返回给 Agent 的话；不合格时 ok 为 false、什么都不改
 */
export function submitDiagnosis(
  task: DiagTask,
  input: DiagnosisInput,
  newId: () => string,
  now = new Date().toISOString(),
): { ok: boolean; info: string; version?: number } {
  if (!task.bug)
    return {
      ok: false,
      info: '这不是父对话派来的 Bug，不用交诊断报告：按派给你的事直接做。',
    }
  const list = task.diagnoses ?? []
  const prev = list.at(-1)
  const c = mergeCase(task, input)
  const answers = answersOf(input)
  const bad = diagnosisProblem(c, list, answers, input)
  if (bad) return { ok: false, info: bad }
  const phase = inputPhase(input, c, list)
  // 用户的决定（取消、同意、贴了日志）留着：那是用户做过的事，不是被新一版顶掉的
  if (prev && (prev.status === 'pending' || prev.status === 'questioned')) prev.status = 'superseded'
  const version = (prev?.version ?? 0) + 1
  const { result, updatedAt: _u, ...body } = c
  const files =
    phase === 'evidence'
      ? evidenceFiles(c)
      : phase === 'verify'
        ? (lastPlan(list)?.files ?? [])
        : c.files.map(normPath).filter(Boolean)
  const d: Diagnosis = {
    ...body,
    // 论证和验证以外不带日志计划、复现步骤：那是上一轮的，留在这一版里会让人以为还要复现
    logPlan: phase === 'evidence' ? c.logPlan : [],
    collect: phase === 'evidence' || phase === 'verify' ? c.collect : undefined,
    phase,
    version,
    at: now,
    files,
    answers,
    status: 'pending',
    notes: [],
    overall: '',
    logs: '',
    logFiles: [],
    result: phase === 'verify' ? result : undefined,
    before: (task.changes ?? []).map((x) => normPath(x.path)).filter(Boolean),
  }
  ;(task.diagnoses ??= []).push(d)
  // 草稿留着：下一版从它改起，用户只问了几条时别的小节不用重写
  task.bugCase = { ...c, updatedAt: now }
  const wait =
    phase === 'verify'
      ? '等用户复现验证、贴日志（或点结束跳过验证）'
      : phase === 'evidence'
        ? '等用户同意加日志（用户也可能直接贴日志）'
        : '等用户确认'
  return {
    ok: true,
    version,
    info: `已交第 ${version} 版（${PHASE_TEXT[phase]}），${wait}。现在结束这一轮回复，用户回复之前不要改任何文件；用户的决定会作为新消息交给你。`,
  }
}

/**
 * request_logs：用户同意加日志后，AI 加好了日志、自己复现不了，请用户复现贴日志。那一版回到等用户（「等你复现」）
 */
export function requestLogs(
  task: Pick<Task, 'bug' | 'diagnoses'>,
  input: DiagnosisInput,
  now = new Date().toISOString(),
): { ok: boolean; info: string } {
  if (!task.bug) return { ok: false, info: '这不是用户报的 Bug，不用请用户复现。' }
  const d = latestDiagnosis(task)
  if (!d || phaseOf(d) !== 'evidence' || d.status !== 'approved')
    return {
      ok: false,
      info: '现在不能请用户复现：要先交 phase: evidence 的一版（写日志计划），用户同意加日志、你加好之后才调用。',
    }
  const added = (Array.isArray(input.added) ? input.added : []).filter((x): x is string => typeof x === 'string')
  if (!added.length) return { ok: false, info: 'added 要写这次实际加的日志位置（path:line，对上日志计划的编号）。' }
  const parsed = input.collect === undefined ? undefined : BugCollect.safeParse(input.collect)
  const collect = parsed?.success ? parsed.data : d.collect
  if (!collect?.steps.length) return { ok: false, info: 'collect.steps 要写用户怎么复现（日志计划里没写时这里补上）。' }
  d.status = 'pending'
  d.awaiting = { at: now, added: added.slice(0, 50), collect }
  d.collect = collect
  return {
    ok: true,
    info: `已请用户按第 ${d.version} 版的日志计划复现。现在结束这一轮回复，等用户贴日志；日志会作为新消息交给你。`,
  }
}

const diagnosisMessage = (id: string, version: number, text: string, at: string): TaskMessage => ({
  id,
  role: 'system',
  agentId: '',
  step: '',
  text,
  tools: [],
  bugReport: version,
  at,
})

/**
 * 审阅弹窗交上来的决定（页面和接口共用）：cancel 为真是「取消修复」；supply 为真是贴日志（logs 文字、logFiles 日志文件路径），
 * 都不是时 approve 区分同意和带着标注退回
 */
export type DiagnosisDecision = {
  approve: boolean
  cancel?: boolean
  supply?: boolean
  logs?: string
  logFiles?: string[]
  notes: Omit<DiagnosisNote, 'id'>[]
  overall: string
}

/** 交给 AI 的日志文字最多留这么多：再长的请用户附文件 */
const MAX_LOGS = 20000

/** 对话里记一行：你对第几版做了什么 */
function decisionLine(d: Diagnosis, k: number): string {
  const n = d.version
  if (d.status === 'answered')
    return phaseOf(d) === 'verify'
      ? t('你给了第 {n} 版的验证结果，交给它分析', { n })
      : t('你给了第 {n} 版要的日志，交给它分析', { n })
  if (d.status === 'questioned') return t('你对第 {n} 版提了 {k} 条意见，要它接着分析', { n, k: k || 1 })
  return {
    evidence: t('你同意了第 {n} 版的日志计划', { n }),
    cause: t('你同意了第 {n} 版的根因', { n }),
    plan: t('你确认了第 {n} 版的修复方案', { n }),
    verify: t('你结束了第 {n} 版的验证', { n }),
  }[phaseOf(d)]
}

/**
 * 用户在审阅弹窗里的决定：同意、带着标注退回、贴日志，或者取消。只能处理还在等用户的那一版。
 * 返回交给子对话的话（调用方作为新消息发给它，附件也一起带上）；找不到要处理的版本时返回错误
 */
export function decideDiagnosis(
  task: DiagTask & Pick<Task, 'plans' | 'steps'>,
  version: number,
  decision: DiagnosisDecision,
  newId: () => string,
  now = new Date().toISOString(),
): { ok: true; message: string } | { ok: false; error: string } {
  // 取消：不用交话给子对话（message 为空），见 cancelDiagnosis
  if (decision.cancel) {
    const r = cancelDiagnosis(task, version, decision.overall, newId, now)
    return r.ok ? { ok: true, message: '' } : r
  }
  const d = pendingDiagnosis(task)
  if (!d || d.version !== version) return { ok: false, error: t('这一版诊断报告已经处理过了') }
  const notes = decision.notes
    .filter((n) => n.comment.trim() || n.quote.trim())
    .map((n, i): DiagnosisNote => ({ ...n, id: i + 1, comment: n.comment.trim(), quote: n.quote.trim() }))
  const phase = phaseOf(d)
  if (decision.supply) {
    if (phase !== 'evidence' && phase !== 'verify') return { ok: false, error: t('这一版不需要日志') }
    const logs = (decision.logs ?? '').trim()
    const logFiles = (decision.logFiles ?? []).filter(Boolean).slice(0, 20)
    if (!logs && !logFiles.length) return { ok: false, error: t('先贴日志或引入日志文件') }
    d.status = 'answered'
    d.logs = logs.slice(0, MAX_LOGS)
    d.logFiles = logFiles
  } else {
    if (!decision.approve && !notes.length && !decision.overall.trim())
      return { ok: false, error: t('退回要写清哪里有疑问：先标注，或者写整体意见') }
    d.status = decision.approve ? 'approved' : 'questioned'
  }
  d.notes = notes
  d.overall = decision.overall.trim()
  d.decidedAt = now
  task.messages.push(diagnosisMessage(newId(), version, decisionLine(d, notes.length), now))
  return { ok: true, message: diagnosisFeedback(d) }
}

/**
 * 用户在审阅弹窗里点「取消」：这次不修了。不再等确认、也不发话叫醒子对话——这一轮在交报告时已经结束，
 * 计划里没做完的步骤（含收尾那一步）收口成完成（settlePlan，和用户点「解决」同一套），对话停着等用户的下一句。
 * 之后用户要它接着修，改文件仍会被拦（bugDeny），要先交新一版报告再确认
 */
export function cancelDiagnosis(
  task: DiagTask & Pick<Task, 'plans' | 'steps'>,
  version: number,
  overall: string,
  newId: () => string,
  now = new Date().toISOString(),
): { ok: true } | { ok: false; error: string } {
  const d = pendingDiagnosis(task)
  if (!d || d.version !== version) return { ok: false, error: t('这一版诊断报告已经处理过了') }
  d.status = 'cancelled'
  d.notes = []
  d.overall = overall.trim()
  d.decidedAt = now
  settlePlan(task, now)
  task.messages.push(
    diagnosisMessage(newId(), version, t('你取消了诊断报告第 {n} 版，这次不修了，计划已标记完成', { n: version }), now),
  )
  return { ok: true }
}

/** 用户的决定交给子对话的话：按阶段写（bug-phase.ts） */
export const diagnosisFeedback = (d: Diagnosis): string => phaseFeedback(d)

/**
 * 收尾（submit_merge）前的核对：父对话派来的 Bug 要有用户确认过的方案、交过验证且用户给了结果或点了结束，
 * 实际改动不超出方案里的文件（论证时加过日志的文件也算，要删临时日志）。返回拒绝的说法；能收尾返回空串
 */
export function diagnosisGate(task: Pick<Task, 'bug' | 'diagnoses' | 'bugCase'>, changed: string[]): string {
  if (!task.bug) return ''
  const list = task.diagnoses ?? []
  const d = list.at(-1)
  if (!d) return '没有请求收尾：这是父对话派来的 Bug，修之前要先用 submit_diagnosis 交报告，用户确认了方案再改。'
  const v = d.version
  if (d.status === 'pending')
    return d.awaiting
      ? `没有请求收尾：第 ${v} 版在等用户复现贴日志。`
      : `没有请求收尾：第 ${v} 版还在等用户，用户回复之前不能收尾。`
  if (d.status === 'questioned') return `没有请求收尾：用户对第 ${v} 版提了意见，先逐条处理、交新一版，等用户确认。`
  if (d.status === 'cancelled')
    return `没有请求收尾：用户取消了第 ${v} 版，这次不修。用户之后要修，先交新一版报告，等用户确认。`
  const phase = phaseOf(d)
  if (phase === 'evidence' || phase === 'cause')
    return '没有请求收尾：还没有用户确认的修复方案。按流程交根因（phase: cause）、修复方案（phase: plan），确认后再修。'
  if (phase === 'plan')
    return '没有请求收尾：修完先用 update_bug_case 记下 result，再交 phase: verify 请用户验证；用户给了验证结果或点了结束才能收尾。'
  const plan = lastPlan(list)
  const extra = outOfPlan(changed, [...(plan?.files ?? []), ...logFilesOf(list)])
  if (extra.length)
    return `没有请求收尾：这些文件不在用户确认的方案（第 ${plan?.version ?? v} 版）里：${extra.join('、')}。不需要的改回去；确实要改，交新一版方案写明为什么，等用户确认后再收尾。`
  // ADR 0046：修完的结果要记进档案——回归测试、影响面逐条的验证
  const r = task.bugCase?.result
  if (!r?.regressionTests.length)
    return '没有请求收尾：用 update_bug_case 的 result 记下修完的结果：regressionTests 写回归测试（测试文件或用例名；没法自动化的写手工步骤），reproBefore / reproAfter 写复现用例改前、改后的输出。'
  const done = new Set(r.impactChecks.filter((x) => x.output.trim() || x.command.trim()).map((x) => norm(x.area)))
  const left = (plan?.impact ?? []).map((x) => x.area).filter((a) => a.trim() && !done.has(norm(a)))
  if (left.length)
    return `没有请求收尾：确认的方案里这些影响面还没有验证记录：${left.join('、')}。逐条验证后用 update_bug_case 的 result.impactChecks 记下（area 照报告里的写，附命令和本轮输出）。`
  return ''
}

/** 用户确认过的最后一版修复方案（旧数据里根因和方案是一版，phaseOf 也算 plan） */
const approvedPlan = (task: Pick<Task, 'bug' | 'diagnoses'>) =>
  task.bug
    ? [...(task.diagnoses ?? [])].reverse().find((x) => x.status === 'approved' && phaseOf(x) === 'plan')
    : undefined

/**
 * 评审对照用（ADR 0046 第 9 条）：用户确认过的那一版的要点，派评审时面板附进它的提示词。
 * 没有确认过的报告返回空。发给 Agent 的提示词，不翻译
 */
export function approvedBrief(task: Pick<Task, 'bug' | 'diagnoses'>): string {
  const d = approvedPlan(task)
  if (!d) return ''
  const chosen = d.options.find((o) => o.id === d.chosen?.id)
  const lines = [
    `## 用户确认的诊断报告（第 ${d.version} 版）`,
    '这是用户报的 Bug，改动应当照这份方案做。对照它看：改动是不是选定的方案、只改了方案里的文件、影响面每一条有没有对应的验证、同类现场处理了没有；对不上的按级别报出来。',
    `- 根因：${d.rootCause}`,
    chosen ? `- 选定方案 ${chosen.id}：${chosen.title}——${chosen.change}` : d.fix ? `- 修复方案：${d.fix}` : '',
    d.files.length ? `- 方案里的文件：${d.files.join('、')}` : '',
    ...(d.impact.length
      ? ['- 影响面：', ...d.impact.map((x) => `  - ${x.area}：${x.effect}（验证：${x.verify}）`)]
      : []),
    d.verify ? `- 验证计划：${d.verify}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Bug 记录的草稿（ADR 0046 第 5 条）：修完请父对话收尾时附上，派「文档」写 Bug 记录时原样交给它，
 * 不用它再从对话里摘。元数据头照 docs/modules/<模块>/bugs/<id>.md 的格式（状态 / 症状 / 入口 / 根因类型 / 模块 / 关键词）
 */
export function bugRecordDraft(task: Pick<Task, 'title' | 'bug' | 'diagnoses' | 'bugCase'>): string {
  const d = approvedPlan(task)
  if (!task.bug || !d) return ''
  const r = task.bugCase?.result
  const a = d.attribution
  const chosen = d.options.find((o) => o.id === d.chosen?.id)
  const entry = d.stack.length
    ? d.stack.map((h) => `\`${h.file}${h.line ? `:${h.line}` : ''}\` ${h.fn}`).join(' → ')
    : d.location
  const meta = [
    `- 状态：已修复${r?.regressionTests.length ? `（${r.regressionTests.join('、')}）` : ''}`,
    `- 症状：${d.symptom.split('\n')[0]}`,
    `- 入口：${entry.split('\n')[0]}`,
    `- 根因类型：${d.rootCause.split('\n')[0]}`,
    a
      ? `- 引入：${[a.change, a.title && `《${a.title}》`, a.date].filter(Boolean).join(' ')}（${a.category}，${a.how}）`
      : '',
  ]
  const sec = (title: string, ...parts: string[]) => {
    const body = parts.filter((x) => x.trim()).join('\n\n')
    return body ? `## ${title}\n\n${body}` : ''
  }
  return [
    `# ${task.title}\n\n${meta.filter(Boolean).join('\n')}`,
    sec('现象', d.symptom, d.repro && `复现：${d.repro}`),
    sec('根因', d.rootCause, d.evidence && `证据：${d.evidence}`),
    sec(
      '修复',
      chosen ? `${chosen.title}：${chosen.change}` : d.fix,
      d.chosen?.whyNotOthers ? `没选别的修法：${d.chosen.whyNotOthers}` : '',
    ),
    sec(
      '防线',
      [
        r?.regressionTests.length ? `- 回归测试：${r.regressionTests.join('、')}` : '- 回归测试：无',
        ...(r?.impactChecks ?? []).map(
          (x) => `- ${x.area}：${x.command}${x.output ? ` → ${x.output.split('\n')[0]}` : ''}`,
        ),
      ].join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}
