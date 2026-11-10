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
import {
  BugCase,
  BugCollect,
  type BugLevel,
  type CleanupState,
  type Diagnosis,
  type DiagnosisNote,
} from './bug-diagnosis-schema.ts'
import { cleanupPrompt, TEMP_LOG } from './bug-cleanup.ts'
import { fixFilesOf } from './bug-fix.ts'
import { fixDiffs, resolveSources, type BugSource } from './bug-quotes.ts'
import {
  causeAgreed,
  closedOrCleaning,
  causeInPlan,
  evidenceFiles,
  inputPhase,
  lastFix,
  lastPlan,
  logFilesOf,
  nextRev,
  noFixOf,
  normPath,
  outOfPlan,
  PHASE_TEXT,
  phaseFeedback,
  phaseOf,
  fixApproved,
  planApproved,
  revOf,
  roundOf,
} from './bug-phase.ts'
import { t } from './i18n.ts'
import { settlePlan } from './plan.ts'
import { autoApprove, autoBlock, autoOn } from './bug-auto.ts'
import { ranInConversation, recheckCommands, recheckVerdict } from './bug-recheck.ts'

export { blameLabel, diagnosisMarkdown, diagnosisView } from './bug-diagnosis-md.ts'
export { outOfPlan, phaseOf, revOf } from './bug-phase.ts'

type DiagTask = Pick<Task, 'bug' | 'diagnoses' | 'messages' | 'changes' | 'bugCase'>

/**
 * submit_diagnosis / update_bug_case 交上来的内容：工具的原始参数，按 BugCase 解析（字段写坏的当没写，不让一个字段挡住整份）。
 * answers 只有交报告时有：第 2 版起逐条回答上一版的意见；phase 是这一版的阶段
 */
export type DiagnosisInput = Record<string, unknown>

/** 档案里能写的字段：只认这些，别的键忽略 */
// rejects 是面板记的退回次数，不让 Agent 写
const CASE_KEYS = Object.keys(BugCase.shape).filter((k) => k !== 'updatedAt' && k !== 'rejects')

/** 原始参数里写了的档案字段（没写的不动草稿里已有的） */
const picked = (input: DiagnosisInput) =>
  Object.fromEntries(CASE_KEYS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]))

/** 草稿合上这次写的字段 */
const mergeCase = (task: Pick<Task, 'bugCase'>, input: DiagnosisInput) => {
  const c = BugCase.parse({ ...(task.bugCase ?? {}), ...picked(input) })
  // 只写了「具体改动」没写 files：要改的文件按它补，收尾核对照样有依据
  if (!c.files.length && c.changes.length) c.files = c.changes.map((x) => x.file).filter(Boolean)
  // noFix 传 {}（how 是空的）就是去掉：之前判成不用改代码、后来发现要改
  if (c.noFix && !c.noFix.how.trim()) c.noFix = undefined
  return c
}

const answersOf = (input: DiagnosisInput) =>
  (Array.isArray(input.answers) ? input.answers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: Number(x.id),
      answer: typeof x.answer === 'string' ? x.answer : '',
      stance: (['adopted', 'explained', 'disagree'] as const).find((v) => v === x.stance),
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

const LEVEL_TEXT: Record<BugLevel, string> = {
  quick: '快速',
  standard: '标准',
  deep: '深入',
}

/** 责任在某次代码改动上的几类：要给出提交和提交人 */
const BLAME_BY_CHANGE = ['current', 'recent', 'legacy']

const ATTRIBUTION_NEED =
  'attribution 要写版本归因：引入点（提交 / CL / rev、作者、日期、标题）、怎么确定的（how）和责任类别（category）；查不到写 category: unknown，note 写试过什么、还缺什么。'

/**
 * 论证的假设表：至少两个（含已排除的，只列一个就是只盯眼前那一处），待验证的要有编号，好和日志计划对上。
 * 用户 2026-11-06 报一个 Bug 来回加了七八轮日志，每轮一两处：一轮要把所有待验证的假设都覆盖到
 */
function hypothesisLack(c: BugCase): string[] {
  if (c.hypotheses.length < 2)
    return ['hypotheses 至少两个候选假设（沿调用栈每个能让结果走偏的分叉都想一遍，已排除的也列上并写依据）']
  if (c.hypotheses.some((h) => h.status === 'open' && !h.id.trim()))
    return ['hypotheses 里待验证的假设要写 id（H1、H2…），日志计划按编号对上']
  if (!c.hypotheses.some((h) => h.status === 'open'))
    return ['hypotheses 里没有待验证的假设：都排除或证实了就不用再加日志，交 phase: cause；还有怀疑的标 open']
  return []
}

/** 日志计划的 hypothesis 里写的编号：「H1、H2」「H1：单位混用」都认 */
const idsIn = (s: string) => s.toUpperCase().split(/[\s,，、/;；:：]+/)

/** 待验证、但日志计划里没有一处写它编号的假设 */
const uncovered = (c: BugCase) =>
  c.hypotheses
    .filter((h) => h.status === 'open' && h.id.trim())
    .map((h) => h.id.trim())
    .filter((id) => !c.logPlan.some((l) => idsIn(l.hypothesis).includes(id.toUpperCase())))

/** 上一版是用户按日志计划复现、贴回了日志的论证：再交论证就是又一轮，next 要写这一轮的（和上一版一样算没写） */
const againAfterLogs = (list: Diagnosis[]) => {
  const prev = list.at(-1)
  return !!prev && phaseOf(prev) === 'evidence' && prev.status === 'answered'
}

/** 论证：日志计划、复现步骤、每种结果说明什么；logPlan、collect 要在这一次里写（每轮的日志不一样，不能沿用上一轮） */
function evidenceProblem(c: BugCase, input: DiagnosisInput, list: Diagnosis[]): string {
  const lack: string[] = []
  if (!c.symptom.trim()) lack.push('symptom（现象）')
  lack.push(...hypothesisLack(c))
  if (input.logPlan === undefined || !c.logPlan.length)
    lack.push('logPlan（这一轮要加的临时日志，每处写 file、print、hypothesis）')
  else {
    if (c.logPlan.some((l) => !l.file.trim() || !l.print.trim() || !l.hypothesis.trim()))
      lack.push('logPlan 每一处都要写 file（加在哪）、print（打什么）和 hypothesis（对应的假设编号，或「路标」）')
    // 实跑 F9：print 写成了描述，打出来的日志和计划对不上，命中表也算不出来
    const loose = c.logPlan.filter((l) => l.print.trim() && !l.print.includes(TEMP_LOG)).map((l) => l.id || l.file)
    if (loose.length)
      lack.push(
        `logPlan 的 print 写要加的那一行语句原文，以 [排查-<主题>] L<n> 开头（${loose.join('、')} 没有）：面板按前缀和编号在用户贴的日志里数出现了几次`,
      )
    const bare = uncovered(c)
    if (bare.length)
      lack.push(
        `这几个待验证的假设没有日志能判真假：${bare.join('、')}（logPlan 的 hypothesis 写上编号；一轮就把每个假设都覆盖到，不留到下一轮）`,
      )
  }
  if (againAfterLogs(list) && (!c.next.trim() || c.next.trim() === list.at(-1)!.next.trim()))
    lack.push('next（又一轮论证：上一轮的日志看到了什么、为什么没能定论、新假设从哪来）')
  if (input.collect === undefined || !c.collect?.steps.length) lack.push('collect.steps（怎么复现）')
  // 实跑 F10：outcomes 空着、expect 写「见 outcomes」也放过了，用户复现完不知道怎么对
  if ((c.collect?.outcomes.length ?? 0) < 2)
    lack.push('collect.outcomes 至少两项（每种结果说明什么：看到 A 是哪个假设、看到 B 是哪个；能核对的写 match）')
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
  // 是代码改动引入的就要说清是谁提交的（用户 2026-11-10 定）；Git 里写了提交号面板会自己取，这里只拦两样都没有的
  if (BLAME_BY_CHANGE.includes(a.category) && !a.change.trim() && !a.author.trim())
    return 'attribution 的责任类别是代码改动（current / recent / legacy），要写引入的那次提交（change：提交号 / CL / rev）和提交人（author，照版本记录原文）；项目没有版本管理、查不到就把 category 写成 unknown，note 写试过什么。'
  if (!c.rating)
    return 'rating 要写根因评级：tier（low 低级：粗心疏漏；mid 中级：逻辑和边界；high 高级：设计、并发、跨模块）和 percent（对根因的把握，0–100 的整数），why 用一句话说依据。'
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
  // 快速级别可以把根因和方案合成一版交：根因那一节照样要齐、要证实，用户确认这一版就同时同意了根因
  if (!causeAgreed(list) && c.level !== 'quick')
    return '还没有用户同意的根因：先交 phase: cause（论证还没定论交 phase: evidence），用户同意根因后再交修复方案。快速级别（必现、读代码就能定、改一个文件）可以把 level 写成 quick，根因和修复方案合成一版交 phase: plan。'
  if (!causeAgreed(list)) {
    const cause = causeProblem(c)
    if (cause) return `快速级别把根因和修复方案合成一版交，根因那一节也要齐：${cause}`
  }
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

/** 修复：先有确认过的方案；changes 一个文件一项，写改了什么、为什么（实际改了哪些文件交报告时按 diff 核对） */
function fixProblem(c: BugCase, list: Diagnosis[]): string {
  if (!planApproved(list)) return '还没有用户确认的修复方案：先交 phase: plan，用户确认之后再改代码、交修复。'
  if (!c.changes.length)
    return 'changes 要写这次实际改了的每个文件（含测试）：what 改了什么，why 为什么这么改，用户对着代码看。'
  const bad = c.changes
    .filter((x) => !x.file.trim() || !x.what.trim() || !x.why.trim())
    .map((x) => x.file || '（没写 file）')
  if (bad.length)
    return `changes 里这几项缺 file、what 或 why：${bad.join('、')}。每个改了的文件都写清改了什么、为什么这么改。`
  return ''
}

/** 验证：先有用户确认过的修复；写清用户怎么验证；修完的结果要先记进档案 */
function verifyProblem(c: BugCase, list: Diagnosis[], input: DiagnosisInput): string {
  if (!planApproved(list)) return '还没有用户确认的修复方案：先交 phase: plan，用户确认、修完之后再交验证。'
  if (!fixApproved(list))
    return lastFix(list)?.status === 'pending'
      ? `第 ${revOf(lastFix(list)!)} 版的修复还在等用户确认，不要交验证：结束这一轮，等用户看完代码。`
      : '修完要先交 phase: fix 请用户看改了哪些代码、为什么这么改，用户确认修复之后再交验证。'
  const lack: string[] = []
  if (input.collect === undefined || !c.collect?.steps.length) lack.push('collect.steps（用户怎么复现验证）')
  if (!c.collect?.expect.trim() && !c.collect?.outcomes.length) lack.push('collect.outcomes（看到什么算修好了）')
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
      ? `第 ${revOf(prev)} 版的日志已经加好、在等用户复现贴日志，不要再交：结束这一轮，等用户的日志。`
      : `第 ${revOf(prev)} 版还在等用户确认，不要重复交：结束这一轮，等确认结果交回给你。`
  const phase = inputPhase(input, c, list)
  const bad =
    phase === 'evidence'
      ? evidenceProblem(c, input, list)
      : phase === 'cause'
        ? causeProblem(c)
        : phase === 'plan'
          ? planProblem(c, list)
          : phase === 'fix'
            ? fixProblem(c, list)
            : verifyProblem(c, list, input)
  if (bad) return bad
  if (prev?.status === 'questioned') {
    const answered = new Set(answers.map((a) => a.id))
    const left = prev.notes.filter((n) => needsAnswer(n) && !answered.has(n.id)).map((n) => n.id)
    if (left.length)
      return `用户对第 ${revOf(prev)} 版的这几条意见还没回答：${left.join('、')}。answers 里按编号逐条写：查了什么、结论、补了什么证据或改了哪一节。`
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
    if (phase === 'cause') return d.status === 'approved' ? (noFixOf(d) ? t('收尾') : t('修复设计')) : t('根因')
    if (phase === 'plan') return d.status === 'approved' ? t('修复') : t('修复设计')
    if (phase === 'fix') return d.status === 'approved' ? (d.merged ? t('收尾') : t('验证')) : t('修复')
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
/** 同一段（用户最近一条消息以来）连续退回几次就停下来交给用户（分析稿 B8） */
export const REJECT_MAX = 3

/**
 * 交诊断报告。被面板退回时记一次（rejects）：便宜模型交不出合格报告时会一直来回改，
 * 连续 REJECT_MAX 次就让它停下来、用 end_turn（blocked）交给用户换模型，不再无限重试。
 * 次数从用户最近一条消息算起：用户换了模型、说了「继续」，重新给它机会；交成功清零
 */
export function submitDiagnosis(
  task: DiagTask,
  input: DiagnosisInput,
  newId: () => string,
  now = new Date().toISOString(),
  src?: BugSource,
): { ok: boolean; info: string; version?: number } {
  const r = submitOnce(task, input, newId, now, src)
  if (!task.bug || task.diagnoses?.at(-1)?.status === 'cancelled') return r
  const since = [...task.messages].reverse().find((m) => m.role === 'user' && !m.panel)?.id ?? ''
  const prev = task.bugCase?.rejects
  const base = task.bugCase ?? BugCase.parse({})
  if (r.ok) {
    task.bugCase = { ...base, rejects: prev ? { ...prev, n: 0 } : undefined }
    return r
  }
  const n = prev && prev.since === since ? prev.n + 1 : 1
  task.bugCase = { ...base, rejects: { n, total: (prev?.total ?? 0) + 1, since } }
  if (n < REJECT_MAX)
    return { ...r, info: `${r.info}\n\n（这是第 ${n} 次被退回，连续 ${REJECT_MAX} 次会停下来交给用户。）` }
  return {
    ...r,
    info:
      `${r.info}\n\n这已经是连续第 ${n} 次被退回。不要再交了：调用 end_turn（outcome: blocked），` +
      `need 写「诊断报告连续 ${n} 次没通过面板核对（最后一次：缺什么），建议换一个能力更强的模型接着查」，然后结束这一轮。`,
  }
}

/** 回归测试命令的提醒（分析稿 B9）：面板这一轮结束后复核；对话里没跑过的命令面板不替它跑 */
function recheckNotes(d: Diagnosis, messages: TaskMessage[]): string[] {
  const cmds = recheckCommands(d)
  if (!cmds.length) return []
  const bare = cmds.filter((c) => !ranInConversation(c, messages))
  return [
    `这一轮结束后面板会在改前的代码（对话开始时的提交加上现在的测试文件）和现在的代码上各跑一次 result.commands，结果放进报告给用户看。`,
    ...(bare.length
      ? [
          `这几条命令没在这个对话里跑过，面板不替你跑，会标「面板没有复核」：${bare.join('、')}。要复核就先自己跑一次，再按原样写进 commands。`,
        ]
      : []),
  ]
}

function submitOnce(
  task: DiagTask,
  input: DiagnosisInput,
  newId: () => string,
  now: string,
  src?: BugSource,
): { ok: boolean; info: string; version?: number } {
  if (!task.bug)
    return {
      ok: false,
      info: '这不是父对话派来的 Bug，不用交诊断报告：按派给你的事直接做。',
    }
  const list = task.diagnoses ?? []
  const prev = list.at(-1)
  // 用户点过「不修了」：这份报告就此关闭，之后的对话不能再拉起它（用户 2026-11-07 定）
  if (prev?.status === 'cancelled') return { ok: false, info: closedOrCleaning(prev, revOf(prev)) }
  const c = mergeCase(task, input)
  const answers = answersOf(input)
  const bad = diagnosisProblem(c, list, answers, input)
  if (bad) return { ok: false, info: bad }
  const phase = inputPhase(input, c, list)
  // 原文：代码取快照、日志和命令输出逐字核对（bug-quotes.ts），对不上拒收，Agent 照原文重交
  const sources = resolveSources(c, { list, messages: task.messages, phase, src, now })
  if (sources.error) return { ok: false, info: sources.error }
  // 修复这一版的实际改动：每个文件和对话开始时比的 diff（去掉临时日志），面板取、不让 Agent 抄；
  // 改了的文件都要在 changes 里写为什么（用户对着代码看原因），取不到 diff（没有宿主、不是 git）时不核对
  const fixFiles =
    (phase === 'fix' || phase === 'verify') && src
      ? fixFilesOf(
          (task.changes ?? []).map((x) => x.path),
          src,
        )
      : []
  if (phase === 'fix' && src?.diff) {
    if (!fixFiles.length)
      return { ok: false, info: '还没有改任何代码（临时日志不算）：按确认的方案改完再交 phase: fix。' }
    const said = new Set(c.changes.map((x) => normPath(x.file)))
    const left = fixFiles.map((f) => f.file).filter((f) => !said.has(f))
    if (left.length)
      return {
        ok: false,
        info: `这些文件改了，changes 里没写：${left.join('、')}。每个改了的文件写一项 what（改了什么）和 why（为什么这么改）；不该改的先改回去。`,
      }
  }
  // 用户的决定（取消、同意、贴了日志）留着：那是用户做过的事，不是被新一版顶掉的
  if (prev && (prev.status === 'pending' || prev.status === 'questioned')) prev.status = 'superseded'
  const version = (prev?.version ?? 0) + 1
  const { rev, overturned } = nextRev(list, phase)
  const { result, updatedAt: _u, rejects: _r, ...body } = c
  const files =
    phase === 'evidence'
      ? evidenceFiles(c)
      : phase === 'verify' || phase === 'fix'
        ? (lastPlan(list)?.files ?? [])
        : c.files.map(normPath).filter(Boolean)
  const d: Diagnosis = {
    ...body,
    // 论证和验证以外不带日志计划、复现步骤：那是上一轮的，留在这一版里会让人以为还要复现
    logPlan: phase === 'evidence' ? c.logPlan : [],
    collect: phase === 'evidence' || phase === 'verify' ? c.collect : undefined,
    phase,
    version,
    rev,
    at: now,
    files,
    answers,
    whatChanged: typeof input.whatChanged === 'string' ? input.whatChanged.trim().slice(0, 2000) : '',
    status: 'pending',
    notes: [],
    overall: '',
    logs: '',
    logFiles: [],
    // 修复这一版也带上：有回归测试命令的，面板交完就复核（分析稿 B9），确认修复时可以把验证合在一起（B2）
    result: phase === 'verify' || phase === 'fix' ? result : undefined,
    before: (task.changes ?? []).map((x) => normPath(x.path)).filter(Boolean),
    fixDiffs: (phase === 'fix' || phase === 'verify') && src ? fixDiffs(list, src) : [],
    fixFiles,
    // 环境：第一份报告时面板采集一次，后面几份沿用（中途重采会把「出问题时的环境」换成排查到一半的）
    env: list.find((x) => x.env)?.env ?? src?.env?.(),
  }
  ;(task.diagnoses ??= []).push(d)
  // 草稿留着：下一版从它改起，用户只问了几条时别的小节不用重写
  task.bugCase = { ...c, updatedAt: now }
  // 按阶段写明这一版只请用户确认什么（实测：根因那一版里写好了方案，回复说「等你确认方案 A」，
  // 弹窗按钮却是「同意根因」，用户以为点了就开始修）
  const wait =
    phase === 'verify'
      ? '等用户复现验证、贴日志（或点结束跳过验证）'
      : phase === 'fix'
        ? '等用户看改了哪些代码、为什么这么改：确认了才做验证；用户对代码标了疑问会交回给你逐条判断'
        : phase === 'evidence'
          ? '等用户同意加日志（用户也可能直接贴日志）'
          : phase === 'cause'
            ? `这一版只请用户确认根因，修复方案要等用户同意根因后另交 phase: plan 再确认${d.options.length || d.fix.trim() ? '（你写的修法在弹窗里标成草案，这一版不确认它）' : ''}；回复用户时不要说在等他确认方案`
            : causeInPlan(d, task.diagnoses)
              ? '等用户一起确认根因和修复方案（快速级别合成一版），确认了才改代码'
              : '等用户确认修复方案，确认了才改代码'
  const round = roundOf(d, task.diagnoses)
  const notes = [...sources.notes, ...recheckNotes(d, task.messages)]
  // 用户设了「后面几步没有要注意的就自动通过」（分析稿 B2）：这一版没有要注意的就当场通过，交给它的话和用户点同意时一样
  const auto = autoOn(task.diagnoses)
    ? autoBlock(
        d,
        task.diagnoses,
        (task.changes ?? []).map((x) => x.path),
      )
    : undefined
  if (auto?.ok) {
    const a = autoApprove(d, now)
    task.messages.push(diagnosisMessage(newId(), version, a.line, now))
    return {
      ok: true,
      version,
      info: `已交第 ${rev} 版的${PHASE_TEXT[phase]}（报告 #${version}）。${a.feedback}${notes.length ? `\n\n面板提醒：\n${notes.map((x) => `- ${x}`).join('\n')}` : ''}`,
    }
  }
  // 自动通过开着、这一版因为要注意的停下：对话里写一行为什么停（复核还没跑完的等复核完再判，见 server/tasks/bug-recheck.ts）
  if (auto && !auto.ok && auto.why)
    task.messages.push(
      diagnosisMessage(newId(), version, t('第 {n} 版没有自动通过：{why}', { n: rev, why: auto.why }), now),
    )
  const which = overturned
    ? `已交第 ${rev} 版（${PHASE_TEXT[phase]}）：回到了更早的阶段或换掉了确认过的方案，第 ${rev - 1} 版的结论作废`
    : `已交第 ${rev} 版的${PHASE_TEXT[phase]}${round > 1 ? `（这一版的第 ${round} 轮，按意见修改不升版本号）` : ''}`
  // 「报告 #n」是交报告的顺序号：对话里那一行按它认出是哪一份（web/src/lib/tasks.ts）
  return {
    ok: true,
    version,
    info: `${which}（报告 #${version}），${wait}。现在结束这一轮回复，用户回复之前不要改任何文件；用户的决定会作为新消息交给你。${notes.length ? `\n\n面板提醒：\n${notes.map((x) => `- ${x}`).join('\n')}` : ''}`,
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
    info: `已请用户按第 ${revOf(d)} 版的日志计划复现（报告 #${d.version}）。现在结束这一轮回复，等用户贴日志；日志会作为新消息交给你。`,
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
  /** 取消时用户勾了要一起删的、为排查新建的文件 */
  drop?: string[]
  /** 取消时用户要求修复也撤掉（共用目录、已修完时） */
  revertFix?: boolean
  supply?: boolean
  logs?: string
  logFiles?: string[]
  notes: Omit<DiagnosisNote, 'id'>[]
  overall: string
  /** 同意时勾了「后面几步没有要注意的就自动通过」（分析稿 B2，bug-auto.ts） */
  autoNext?: boolean
}

/** 交给 AI 的日志文字最多留这么多：再长的请用户附文件 */
const MAX_LOGS = 20000

/** 对话里记一行：你对第几版做了什么 */
function decisionLine(d: Diagnosis, k: number): string {
  const n = revOf(d)
  if (d.status === 'answered')
    return phaseOf(d) === 'verify'
      ? t('你给了第 {n} 版的验证结果，交给它分析', { n })
      : t('你给了第 {n} 版要的日志，交给它分析', { n })
  if (d.status === 'questioned') {
    const phase = { evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), fix: t('修复'), verify: t('验证') }[
      phaseOf(d)
    ]
    return t('你对第 {n} 版的{phase}提了 {k} 条意见，要它接着分析', { n, k: k || 1, phase })
  }
  return {
    evidence: t('你同意了第 {n} 版的日志计划', { n }),
    cause: t('你同意了第 {n} 版的根因', { n }),
    plan: t('你确认了第 {n} 版的修复方案', { n }),
    fix: d.merged
      ? t('你确认了第 {n} 版的修复，面板复核过回归测试，验证一起通过', { n })
      : t('你确认了第 {n} 版的修复', { n }),
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
  /** 取消时面板查到的临时日志（服务端查，不信页面传的）：有就先叫它删，见 cancelDiagnosis */
  cleanup?: Pick<CleanupState, 'found' | 'drop' | 'revertFix' | 'pre'>,
): { ok: true; message: string } | { ok: false; error: string } {
  // 取消：没有临时日志时不用交话给子对话（message 为空），见 cancelDiagnosis
  if (decision.cancel) return cancelDiagnosis(task, version, decision.overall, newId, now, cleanup)
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
    if (decision.approve) {
      d.autoNext = !!decision.autoNext
      // 面板复核过「改前失败、改后通过」：确认修复就同时算验证通过（分析稿 B2 第 ① 条）
      if (phase === 'fix' && recheckVerdict(d.recheck) === 'pass') d.merged = true
    }
  }
  d.notes = notes
  d.overall = decision.overall.trim()
  d.decidedAt = now
  task.messages.push(diagnosisMessage(newId(), version, decisionLine(d, notes.length), now))
  return { ok: true, message: diagnosisFeedback(d) }
}

/**
 * 用户在审阅弹窗里点「取消」：这次不修了。
 * - 代码里没有临时日志（cleanup 不传或什么都没查到）：不再等确认、也不发话叫醒子对话——这一轮在交报告时已经结束，
 *   计划里没做完的步骤（含收尾那一步）收口成完成（settlePlan，和用户点「解决」同一套），对话停着等用户的下一句。
 * - 有临时日志（用户 2026-11-10 定）：报告标「已取消」，但先叫 Agent 把日志删掉（返回给它的话），
 *   这一轮结束时面板核对（server/tasks/bug-cleanup.ts），通过了才关闭报告、收口计划（settleCleanup）。
 * 之后用户要它接着修，改文件仍会被拦（bugDeny），要在父对话重新报这个 Bug
 */
export function cancelDiagnosis(
  task: DiagTask & Pick<Task, 'plans' | 'steps'>,
  version: number,
  overall: string,
  newId: () => string,
  now = new Date().toISOString(),
  cleanup?: Pick<CleanupState, 'found' | 'drop' | 'revertFix' | 'pre'>,
): { ok: true; message: string } | { ok: false; error: string } {
  const d = pendingDiagnosis(task)
  if (!d || d.version !== version) return { ok: false, error: t('这一版诊断报告已经处理过了') }
  d.status = 'cancelled'
  d.notes = []
  d.overall = overall.trim()
  d.decidedAt = now
  const n = revOf(d)
  if (cleanup && (cleanup.found.length || cleanup.drop.length)) {
    d.cleanup = { ...cleanup, state: 'running', failed: [], kept: [], at: now }
    task.messages.push(
      diagnosisMessage(
        newId(),
        version,
        t('你取消了诊断报告第 {n} 版，这次不修了：它先删掉 {k} 处临时日志，面板核对干净后关闭报告', {
          n,
          k: cleanup.found.length,
        }),
        now,
      ),
    )
    return { ok: true, message: cleanupPrompt({ rev: n, ...cleanup }) }
  }
  settlePlan(task, now)
  task.messages.push(
    diagnosisMessage(newId(), version, t('你取消了诊断报告第 {n} 版，这次不修了，计划已标记完成', { n }), now),
  )
  return { ok: true, message: '' }
}

/**
 * 删临时日志的结果：done 面板核对通过；skipped 用户在核对没过后选了「我自己删」或「保留」。
 * 这时才关闭报告：收口计划，对话里记一行。failed 只记下核对结果，等用户决定（不悄悄重试）
 */
export function settleCleanup(
  task: DiagTask & Pick<Task, 'plans' | 'steps'>,
  result: { state: 'done' | 'failed' | 'skipped'; failed?: CleanupState['failed']; kept?: string[] },
  newId: () => string,
  now = new Date().toISOString(),
): boolean {
  const d = task.diagnoses?.at(-1)
  if (!d?.cleanup || d.status !== 'cancelled') return false
  const c = d.cleanup
  c.state = result.state
  c.failed = result.failed ?? []
  c.kept = result.kept ?? []
  c.checkedAt = now
  const n = revOf(d)
  const k = c.found.length
  const line = {
    done: t('临时日志已删干净（{k} 处），诊断报告第 {n} 版已关闭', { k, n }),
    failed: t('临时日志没删干净：{text}', { text: failedSummary(c) }),
    skipped: t('你选了不让它再删，诊断报告第 {n} 版已关闭', { n }),
  }[result.state]
  if (result.state !== 'failed') settlePlan(task, now)
  task.messages.push(diagnosisMessage(newId(), d.version, line, now))
  return true
}

/** 核对没过的概要：还剩几处日志、多了几个空行、删多了几行（对话里那一行和报告上用） */
export function failedSummary(c: Pick<CleanupState, 'failed' | 'kept'>): string {
  const sum = (k: 'left' | 'blank' | 'extra' | 'removed') => c.failed.reduce((a, f) => a + f[k].length, 0)
  return [
    sum('left') && t('还剩 {k} 处临时日志', { k: sum('left') }),
    sum('blank') && t('多了 {k} 个空行', { k: sum('blank') }),
    sum('extra') && t('多了 {k} 行别的改动', { k: sum('extra') }),
    sum('removed') && t('删多了 {k} 行', { k: sum('removed') }),
    c.kept.length && t('要删的文件还在：{files}', { files: c.kept.join('、') }),
  ]
    .filter(Boolean)
    .join('，')
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
  const v = revOf(d)
  if (d.status === 'pending')
    return d.awaiting
      ? `没有请求收尾：第 ${v} 版在等用户复现贴日志。`
      : `没有请求收尾：第 ${v} 版还在等用户，用户回复之前不能收尾。`
  if (d.status === 'questioned') return `没有请求收尾：用户对第 ${v} 版提了意见，先逐条处理、改好再交，等用户确认。`
  if (d.status === 'cancelled') return `没有请求收尾：${closedOrCleaning(d, v)}`
  const phase = phaseOf(d)
  // 用户同意了「不用改代码」：除了删临时日志什么都不该改（临时日志删没删干净由 submitMerge 另查）
  if (phase === 'cause' && d.status === 'approved' && noFixOf(d)) {
    const extra = outOfPlan(changed, logFilesOf(list))
    return extra.length
      ? `没有请求收尾：用户同意的结论是不用改代码，但这些文件改了：${extra.join('、')}。改回去再收尾。`
      : ''
  }
  if (phase === 'evidence' || phase === 'cause')
    return '没有请求收尾：还没有用户确认的修复方案。按流程交根因（phase: cause）、修复方案（phase: plan），确认后再修。'
  if (phase === 'plan')
    return '没有请求收尾：修完先交 phase: fix 请用户看改了哪些代码，用户确认修复后验证、交 phase: verify；用户给了验证结果或点了结束才能收尾。'
  if (phase === 'fix' && !(d.status === 'approved' && d.merged))
    return '没有请求收尾：用户确认了修复，还要验证：用 update_bug_case 记下 result，交 phase: verify；用户给了验证结果或点了结束才能收尾。'
  const plan = lastPlan(list)
  const extra = outOfPlan(changed, [...(plan?.files ?? []), ...logFilesOf(list)])
  if (extra.length)
    return `没有请求收尾：这些文件不在用户确认的方案（第 ${plan ? revOf(plan) : v} 版）里：${extra.join('、')}。不需要的改回去；确实要改，重新交 phase: plan 写明为什么，等用户确认后再收尾。`
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
    `## 用户确认的诊断报告（第 ${revOf(d)} 版）`,
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
