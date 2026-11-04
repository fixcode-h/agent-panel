/**
 * Bug 先交诊断报告、用户确认了方案再改（ADR 0045）：纯函数，引擎、服务端和界面共用。
 * - 子对话（父对话派来的 Bug，task.bug）查到根因后用 submit_diagnosis 交报告（submitDiagnosis），这一轮结束；
 *   等确认期间对话算执行中（convState 的 diagnosis），交报告那一行工具调用一直转圈、上面有「查看报告」（用户 2026-11-03 定的：
 *   不是「等你处理」的请求，父对话页也不单独显示）。确认之前不改文件。
 * - 用户在审阅弹窗里确认或标疑问（decideDiagnosis），结果作为新消息交回子对话（diagnosisFeedback）。
 *   不跟「提问」开关走：总是用户确认，父对话不代为确认（用户 2026-11-03 定的）。
 * - 收尾（submit_merge）前核对：要有确认过的方案，实际改动不超出方案里的文件（diagnosisGate）。
 * 交给 Agent 的话是提示词，不翻译；报告的小节名、对话里的提示、请求标题是界面文案，走 t()。
 */
import type { Task, TaskMessage } from './schema.ts'
import { BugCase, type BugBlame, type BugLevel, type Diagnosis, type DiagnosisNote } from './bug-diagnosis-schema.ts'
import { t } from './i18n.ts'
import { settlePlan } from './plan.ts'

type DiagTask = Pick<Task, 'bug' | 'diagnoses' | 'messages' | 'changes' | 'bugCase'>

/**
 * submit_diagnosis / update_bug_case 交上来的内容：工具的原始参数，按 BugCase 解析（字段写坏的当没写，不让一个字段挡住整份）。
 * answers 只有交报告时有：第 2 版起逐条回答上一版的意见
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

const KIND_TEXT: Record<DiagnosisNote['kind'], string> = {
  question: '疑问',
  change: '改方案',
  info: '补充信息',
}

/** 影响面按名字对：忽略空白和大小写 */
const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase()

const normPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

/** 不改方案也能顺带改的：测试、文档、翻译（修 Bug 本来就要补回归测试、回写文档） */
const FREE_FILE = /(^|\/)(tests?|__tests__|docs|locales?)\/|\.(test|spec)\.[^/]+$|\.md$/i

/** 实际改动里超出已确认方案的文件：方案里写目录（以 / 结尾）时目录下的都算 */
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

/**
 * 交上来的报告缺什么；没问题返回空串。按级别查（ADR 0046 第 8 条）：只查结构齐不齐，内容对不对靠用户确认和评审
 */
export function diagnosisProblem(
  c: BugCase,
  prev: Diagnosis | undefined,
  answers: { id: number; answer: string }[] = [],
): string {
  if (prev?.status === 'pending')
    return `诊断报告第 ${prev.version} 版还在等用户确认，不要重复交：结束这一轮，等确认结果交回给你。`
  const need: [string, boolean][] = [
    ['symptom（现象）', !!c.symptom.trim()],
    ['stack 或 location（调用栈）', !!c.stack.length || !!c.location.trim()],
    ['evidence（证据链）', !!c.evidence.trim()],
    ['rootCause（根因）', !!c.rootCause.trim()],
    ['fix 或 options + chosen（修复方案）', !!c.fix.trim() || !!c.chosen?.id],
    ['verify（验证计划）', !!c.verify.trim()],
  ]
  const empty = need.filter(([, ok]) => !ok).map(([label]) => label)
  if (empty.length)
    return `诊断报告缺这些小节：${empty.join('、')}。查不出根因时 rootCause 写「未找到」、confirmed 写 false，next 写下一步要加哪些日志、要用户提供什么。`
  if (!c.files.map(normPath).filter(Boolean).length)
    return 'files 要写方案里要改的文件（相对项目根）：收尾时实际改动按它核对；还没找到根因时写要加临时日志的文件。'
  if (!c.confirmed) {
    if (!c.next.trim() && !c.fix.trim()) return '根因还没证实：next 写下一步要加哪些日志、要用户提供什么。'
  } else {
    const a = c.attribution
    if (!a || (a.category === 'unknown' && !a.note.trim()))
      return 'attribution 要写版本归因：引入点（提交 / CL / rev、作者、日期、标题）、怎么确定的（how）和责任类别（category）；查不到写 category: unknown，note 写试过什么、还缺什么。'
    const full = c.level !== 'quick'
    const lack: string[] = []
    if (full && !c.timeline.some((x) => x.kind === 'change'))
      lack.push('timeline 里至少一条 kind: change 的变更时间线（从以前好过到现在变了什么）')
    if (full && !c.consistency.length) lack.push('consistency（根因怎么解释现象的每一条）')
    if (full && !c.impact.length) lack.push('impact（影响面：每条写怎么受影响、怎么验证）')
    if (full && c.options.length < 2) lack.push('options 至少两个有实质区别的修法（五项比较）')
    if (c.level === 'deep' && c.hypotheses.length < 2)
      lack.push('hypotheses 至少两个假设（已证实 / 已排除 / 待验证，各自依据）')
    if (c.options.length && !c.options.some((o) => o.id && o.id === c.chosen?.id))
      lack.push('chosen.id 要对上 options 里的一个方案')
    if (c.options.length && !c.chosen?.why.trim()) lack.push('chosen.why（为什么选它）')
    if (c.options.length >= 2 && !c.chosen?.whyNotOthers.trim()) lack.push('chosen.whyNotOthers（为什么不选别的）')
    if (c.options.length === 1 && !c.chosen?.whyNotOthers.trim())
      lack.push('chosen.whyNotOthers（只有一个方案时写为什么没有别的合理修法）')
    if (lack.length)
      return `${LEVEL_TEXT[c.level]}级别的诊断报告还缺：${lack.join('；')}。觉得这个 Bug 没这么复杂，可以把 level 降成 quick 并在 levelNote 写理由（用户审阅时看得到）。`
  }
  if (prev?.status === 'questioned') {
    const answered = new Set(answers.map((a) => a.id))
    const left = prev.notes.filter((n) => needsAnswer(n) && !answered.has(n.id)).map((n) => n.id)
    if (left.length)
      return `用户对第 ${prev.version} 版的这几条意见还没回答：${left.join('、')}。answers 里按编号逐条写：查了什么、结论、补了什么证据或改了哪一节。`
  }
  return ''
}

/** 责任类别在界面上的说法 */
export const blameLabel = (b: BugBlame) =>
  ({
    current: t('本次改动'),
    recent: t('近期变更'),
    legacy: t('历史遗留'),
    external: t('外部依赖'),
    environment: t('环境配置'),
    data: t('数据'),
    user: t('用户操作'),
    unknown: t('未确定'),
  })[b]

const levelLabel = (l: BugLevel) => ({ quick: t('快速'), standard: t('标准'), deep: t('深入') })[l]

/** 表格单元格：竖线和换行会打断表格 */
const cell = (v: string) =>
  v
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim() || '—'
const table = (head: string[], rows: string[][]) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ].join('\n')
    : ''

/**
 * 报告渲染成 Markdown：审阅弹窗、交回父对话、对话里的卡片都用这一份。
 * author：引入点里显示作者（设置里可以关掉，只显示提交号）
 */
export function diagnosisMarkdown(d: Diagnosis, prev?: Diagnosis, opts: { author?: boolean } = {}): string {
  const sec = (title: string, body: string) => (body.trim() ? `## ${title}\n${body.trim()}` : '')
  const answers = prev
    ? d.answers
        .map((a) => {
          const n = prev.notes.find((x) => x.id === a.id)
          if (!n) return ''
          const quote = n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 120)}」` : ''
          return `${a.id}. **${KIND_TEXT[n.kind]}**${quote}：${n.comment.trim()}\n   - 回答：${a.answer.trim()}`
        })
        .filter(Boolean)
        .join('\n')
    : ''
  const stack = d.stack.length
    ? d.stack
        .map((h, i) => `${i + 1}. \`${h.file}${h.line ? `:${h.line}` : ''}\` ${h.fn}${h.note ? ` — ${h.note}` : ''}`)
        .join('\n')
    : ''
  const kindText = { event: t('事件'), state: t('状态'), change: t('变更') }
  const timeline = table(
    [t('时间'), t('类别'), t('来源'), t('内容')],
    d.timeline.map((x) => [x.at, kindText[x.kind], x.source, x.abnormal ? `**${t('异常')}** ${x.text}` : x.text]),
  )
  const a = d.attribution
  const by = [opts.author === false ? '' : a?.author, a?.date].filter(Boolean).join('，')
  const attribution = a
    ? [
        a.change || a.title
          ? t('引入于 {change}{title}{by}', {
              change: a.change ? `\`${a.change}\`` : '',
              title: a.title ? `《${a.title}》` : '',
              by: by ? `（${by}）` : '',
            })
          : '',
        t('责任类别：{c}；依据：{how}；把握：{conf}', {
          c: blameLabel(a.category),
          how: { blame: t('逐行追溯'), bisect: t('二分定位'), diff: t('对比前一版'), log: t('日志'), none: t('无') }[
            a.how
          ],
          conf: { high: t('高'), medium: t('中'), low: t('低') }[a.confidence],
        }),
        a.note,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const consistency = d.consistency.map((x) => `- ${x.observation} → ${x.explanation}`).join('\n')
  const hypoText = {
    confirmed: t('已证实'),
    excluded: t('已排除'),
    open: t('待验证'),
  }
  const hypotheses = table(
    [t('假设'), t('结论'), t('依据')],
    d.hypotheses.map((h) => [h.text, hypoText[h.status], h.basis]),
  )
  const impact = table(
    [t('影响面'), t('怎么受影响'), t('怎么验证')],
    d.impact.map((x) => [x.area, x.effect, x.verify]),
  )
  const options = d.options
    .map((o) => {
      const chosen = o.id === d.chosen?.id
      const rows: [string, string][] = [
        [t('改法'), o.change],
        [t('要改的文件'), o.files.map((f) => `\`${f}\``).join('、')],
        [t('修得全'), o.covers],
        [t('漏了'), o.misses],
        [t('修改面'), o.surface],
        [t('风险'), o.risk],
        [t('契合'), o.fit],
        [t('可验证'), o.verifiable],
      ]
      return [
        `### ${t('方案 {id}', { id: o.id })}：${o.title}${chosen ? `（${t('选定')}）` : ''}`,
        ...rows.filter(([, v]) => v.trim()).map(([k, v]) => `- **${k}**：${v.trim()}`),
      ].join('\n')
    })
    .join('\n\n')
  const chosen = d.chosen
    ? [
        d.chosen.why && `**${t('为什么选方案 {id}', { id: d.chosen.id })}**：${d.chosen.why}`,
        d.chosen.whyNotOthers && `**${t('为什么不选别的')}**：${d.chosen.whyNotOthers}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  return [
    sec(t('回答上一版的意见'), answers),
    sec(t('级别'), `${levelLabel(d.level)}${d.levelNote ? `：${d.levelNote}` : ''}`),
    sec(t('现象'), d.symptom),
    sec(t('复现'), d.repro),
    sec(t('位置和调用栈'), [d.location, stack].filter(Boolean).join('\n\n')),
    sec(t('时间线'), timeline),
    sec(t('证据链'), d.evidence),
    sec(d.confirmed ? t('根因（已证实）') : t('根因（假设，还没证实）'), d.rootCause),
    sec(t('引入点'), attribution),
    sec(t('根因怎么解释每一条现象'), consistency),
    sec(t('假设'), hypotheses),
    sec(t('已排除'), d.excluded),
    sec(t('影响面'), impact),
    sec(t('候选方案'), options),
    sec(t('选定'), chosen),
    sec(t('修复方案'), d.fix),
    sec(t('要改的文件'), d.files.map((f) => `- \`${f}\``).join('\n')),
    sec(t('影响和风险'), d.risk),
    sec(t('验证计划'), d.verify),
    sec(t('下一步'), d.next),
    sec(t('交报告前已改动的文件'), d.before.map((f) => `- \`${f}\``).join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 查到哪个阶段了（ADR 0046）：按草稿和报告推算，父对话的子对话行上显示 */
export function bugStage(task: Pick<Task, 'bug' | 'bugCase' | 'diagnoses'>): string {
  if (!task.bug) return ''
  const d = latestDiagnosis(task)
  if (d?.status === 'pending') return t('等你确认')
  if (d?.status === 'cancelled') return t('已取消')
  if (d?.status === 'approved') return task.bugCase?.result ? t('收尾') : t('修复')
  const c = task.bugCase
  if (!c) return t('立案')
  if (c.options.length || c.impact.length) return t('修复设计')
  if (c.rootCause.trim() || c.attribution) return t('归因')
  if (c.timeline.length) return t('时间线')
  if (c.stack.length || c.location.trim()) return t('定位')
  return t('立案')
}

/** 草稿还缺什么才能交报告：按当前级别查，交报告前还有的写给 Agent 看 */
const draftLeft = (c: BugCase, prev: Diagnosis | undefined) => {
  const p = diagnosisProblem(c, prev?.status === 'pending' ? undefined : prev)
  return p ? `交诊断报告前还要补：${p}` : '交诊断报告需要的都齐了。'
}

/**
 * update_bug_case：往档案草稿里记（传哪个字段就换掉哪个字段，数组整组传）。
 * 排查记录跨轮次不丢，交新一版报告时自动带上；修完把结果（result）也记在这里，收尾时核对
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
  const d = latestDiagnosis(task)
  const tail =
    d?.status === 'approved'
      ? task.bugCase.result
        ? '修复结果已记下，收尾时按它核对影响面逐条的验证和回归测试。'
        : '方案已确认：修完用 result 记下复现用例改前改后、影响面逐条的验证（area 对上报告里的影响面）、回归测试。'
      : draftLeft(task.bugCase, d)
  return {
    ok: true,
    info: `已记进档案：${keys.join('、')}。现在在「${bugStage(task)}」。${tail}`,
  }
}

/**
 * 交一版诊断报告：草稿合上这次交的内容，按级别检查后冻结成新的一版，上一版作废，等用户确认（不跟「提问」开关走）。
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
  const prev = latestDiagnosis(task)
  const c = mergeCase(task, input)
  const answers = answersOf(input)
  const bad = diagnosisProblem(c, prev, answers)
  if (bad) return { ok: false, info: bad }
  // 取消过的那版留着「已取消」：那是用户的决定，不是被新一版顶掉的
  if (prev && prev.status !== 'superseded' && prev.status !== 'cancelled') prev.status = 'superseded'
  const version = (prev?.version ?? 0) + 1
  const { result: _r, updatedAt: _u, ...body } = c
  const d: Diagnosis = {
    ...body,
    version,
    at: now,
    files: c.files.map(normPath).filter(Boolean),
    answers,
    status: 'pending',
    notes: [],
    overall: '',
    before: (task.changes ?? []).map((x) => normPath(x.path)).filter(Boolean),
  }
  ;(task.diagnoses ??= []).push(d)
  // 草稿留着：下一版从它改起，用户只问了几条时别的小节不用重写
  task.bugCase = { ...c, updatedAt: now }
  return {
    ok: true,
    version,
    info: `已交诊断报告第 ${version} 版，等用户确认。现在结束这一轮回复，确认之前不要改任何文件；用户确认或提出疑问后，结果会作为新消息交给你。`,
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

/** 审阅弹窗交上来的决定（页面和接口共用）：cancel 为真是「取消修复」，approve 不看 */
export type DiagnosisDecision = {
  approve: boolean
  cancel?: boolean
  notes: Omit<DiagnosisNote, 'id'>[]
  overall: string
}

/**
 * 用户在审阅弹窗里的决定：确认方案、带着标注退回再查，或者取消。只能处理还在等确认的那一版。
 * 返回交给子对话的话（调用方作为新消息发给它）；找不到要处理的版本时返回错误
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
  if (!decision.approve && !notes.length && !decision.overall.trim())
    return { ok: false, error: t('退回要写清哪里有疑问：先标注，或者写整体意见') }
  d.status = decision.approve ? 'approved' : 'questioned'
  d.notes = notes
  d.overall = decision.overall.trim()
  d.decidedAt = now
  task.messages.push(
    diagnosisMessage(
      newId(),
      version,
      decision.approve
        ? t('你确认了诊断报告第 {n} 版的方案', { n: version })
        : t('你对诊断报告第 {n} 版提了 {k} 条意见，要它再查', { n: version, k: notes.length || 1 }),
      now,
    ),
  )
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

/** 用户的决定交给子对话的话 */
export function diagnosisFeedback(d: Diagnosis): string {
  const overall = d.overall ? `\n\n用户的整体意见：${d.overall}` : ''
  if (d.status === 'approved')
    return `用户确认了诊断报告第 ${d.version} 版的方案，按它修：
- 先写改前失败的测试（没法自动化的写成可重复的手工步骤），再按方案改。
- 只改方案里的文件：${d.files.map((f) => `\`${f}\``).join('、')}（补测试、回写文档、翻译不算）。要改别的文件，先交新一版诊断报告写明为什么，等用户确认。
- 改完验证不过：不要在这次修法上接着改，把这次的修法和失败证据写进「已排除」，交新一版诊断报告。${overall}`
  const list = d.notes
    .map((n) => {
      const quote = n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 300)}」` : ''
      return `${n.id}. [${KIND_TEXT[n.kind]}]${quote}${n.comment ? `：${n.comment}` : ''}`
    })
    .join('\n')
  return `用户对诊断报告第 ${d.version} 版还有意见，先不要改文件：
${list || '（没有逐条标注，见整体意见）'}${overall}

逐条查清后用 submit_diagnosis 交新一版：answers 按编号回答「疑问」和「改方案」（查了什么、结论、补了什么证据或改了哪一节），「补充信息」用进报告里即可。只处理被问到的几条，别的小节照抄上一版，不要整份重写。`
}

/**
 * 收尾（submit_merge）前的核对：父对话派来的 Bug 要有用户确认过的最新方案，实际改动不超出方案里的文件。
 * 返回拒绝的说法；能收尾返回空串
 */
export function diagnosisGate(task: Pick<Task, 'bug' | 'diagnoses' | 'bugCase'>, changed: string[]): string {
  if (!task.bug) return ''
  const d = latestDiagnosis(task)
  if (!d) return '没有请求收尾：这是父对话派来的 Bug，修之前要先用 submit_diagnosis 交诊断报告，用户确认了方案再改。'
  if (d.status === 'pending') return `没有请求收尾：诊断报告第 ${d.version} 版还在等用户确认，确认之前不能收尾。`
  if (d.status === 'questioned')
    return `没有请求收尾：用户对诊断报告第 ${d.version} 版提了意见，先逐条处理、交新一版，等用户确认。`
  if (d.status === 'cancelled')
    return `没有请求收尾：用户取消了诊断报告第 ${d.version} 版，这次不修。用户之后要修，先交新一版诊断报告，等用户确认。`
  const extra = outOfPlan(changed, d.files)
  if (extra.length)
    return `没有请求收尾：这些文件不在用户确认的方案（第 ${d.version} 版）里：${extra.join('、')}。不需要的改回去；确实要改，交新一版诊断报告写明为什么，等用户确认后再收尾。`
  // ADR 0046：修完的结果要记进档案——回归测试、影响面逐条的验证
  const r = task.bugCase?.result
  if (!r?.regressionTests.length)
    return '没有请求收尾：用 update_bug_case 的 result 记下修完的结果：regressionTests 写回归测试（测试文件或用例名；没法自动化的写手工步骤），reproBefore / reproAfter 写复现用例改前、改后的输出。'
  const done = new Set(r.impactChecks.filter((x) => x.output.trim() || x.command.trim()).map((x) => norm(x.area)))
  const left = d.impact.map((x) => x.area).filter((a) => a.trim() && !done.has(norm(a)))
  if (left.length)
    return `没有请求收尾：确认的方案里这些影响面还没有验证记录：${left.join('、')}。逐条验证后用 update_bug_case 的 result.impactChecks 记下（area 照报告里的写，附命令和本轮输出）。`
  return ''
}

/**
 * 评审对照用（ADR 0046 第 9 条）：用户确认过的那一版的要点，派评审时面板附进它的提示词。
 * 没有确认过的报告返回空。发给 Agent 的提示词，不翻译
 */
export function approvedBrief(task: Pick<Task, 'bug' | 'diagnoses'>): string {
  const d = task.bug ? [...(task.diagnoses ?? [])].reverse().find((x) => x.status === 'approved') : undefined
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
  const d = [...(task.diagnoses ?? [])].reverse().find((x) => x.status === 'approved')
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
