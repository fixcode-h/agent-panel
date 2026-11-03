/**
 * Bug 先交诊断报告、用户确认了方案再改（ADR 0045）：纯函数，引擎、服务端和界面共用。
 * - 子对话（父对话派来的 Bug，task.bug）查到根因后用 submit_diagnosis 交报告（submitDiagnosis），
 *   报告挂成一条等用户处理的请求，这一轮结束；确认之前不改文件。
 * - 用户在审阅弹窗里确认或标疑问（decideDiagnosis），结果作为新消息交回子对话（diagnosisFeedback）。
 *   不跟「提问」开关走：总是用户确认，父对话不代为确认（用户 2026-11-03 定的）。
 * - 收尾（submit_merge）前核对：要有确认过的方案，实际改动不超出方案里的文件（diagnosisGate）。
 * 交给 Agent 的话是提示词，不翻译；报告的小节名、对话里的提示、请求标题是界面文案，走 t()。
 */
import type { Task, TaskMessage, TaskRequest } from './schema.ts'
import type { Diagnosis, DiagnosisNote } from './bug-diagnosis-schema.ts'
import { t } from './i18n.ts'

type DiagTask = Pick<Task, 'bug' | 'diagnoses' | 'requests' | 'messages' | 'changes'>

/** submit_diagnosis 交上来的内容 */
export interface DiagnosisInput {
  symptom: string
  repro: string
  location: string
  evidence: string
  rootCause: string
  confirmed: boolean
  excluded: string
  fix: string
  files: string[]
  risk: string
  verify: string
  answers: { id: number; answer: string }[]
}

export const latestDiagnosis = (task: Pick<Task, 'diagnoses'>) => task.diagnoses?.at(-1)
export const pendingDiagnosis = (task: Pick<Task, 'diagnoses'>) => {
  const d = latestDiagnosis(task)
  return d?.status === 'pending' ? d : undefined
}

/** 要 Agent 回答的标注：疑问和改方案；补充信息只要用上，不用逐条回答 */
const needsAnswer = (n: DiagnosisNote) => n.kind !== 'info'

const KIND_TEXT: Record<DiagnosisNote['kind'], string> = { question: '疑问', change: '改方案', info: '补充信息' }

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

/** 交上来的报告缺什么；没问题返回空串 */
export function diagnosisProblem(input: DiagnosisInput, prev: Diagnosis | undefined): string {
  if (prev?.status === 'pending')
    return `诊断报告第 ${prev.version} 版还在等用户确认，不要重复交：结束这一轮，等确认结果交回给你。`
  const need: [keyof DiagnosisInput, string][] = [
    ['symptom', 'symptom（现象）'],
    ['location', 'location（模块、哪一层、调用栈）'],
    ['evidence', 'evidence（证据链）'],
    ['rootCause', 'rootCause（根因）'],
    ['fix', 'fix（修复方案）'],
    ['verify', 'verify（验证计划）'],
  ]
  const empty = need.filter(([k]) => !String(input[k] ?? '').trim()).map(([, label]) => label)
  if (empty.length)
    return `诊断报告缺这些小节：${empty.join('、')}。查不出根因时 rootCause 写「未找到」，fix 写下一步要加哪些日志、要用户提供什么。`
  if (!input.files.map(normPath).filter(Boolean).length)
    return 'files 要写方案里要改的文件（相对项目根）：收尾时实际改动按它核对；还没找到根因时写要加临时日志的文件。'
  if (prev?.status === 'questioned') {
    const answered = new Set(input.answers.filter((a) => a.answer.trim()).map((a) => a.id))
    const left = prev.notes.filter((n) => needsAnswer(n) && !answered.has(n.id)).map((n) => n.id)
    if (left.length)
      return `用户对第 ${prev.version} 版的这几条意见还没回答：${left.join('、')}。answers 里按编号逐条写：查了什么、结论、补了什么证据或改了哪一节。`
  }
  return ''
}

/** 报告渲染成 Markdown：审阅弹窗、交回父对话、对话里的卡片都用这一份 */
export function diagnosisMarkdown(d: Diagnosis, prev?: Diagnosis): string {
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
  return [
    sec(t('回答上一版的意见'), answers),
    sec(t('现象'), d.symptom),
    sec(t('复现'), d.repro),
    sec(t('位置和调用栈'), d.location),
    sec(t('证据链'), d.evidence),
    sec(d.confirmed ? t('根因（已证实）') : t('根因（假设，还没证实）'), d.rootCause),
    sec(t('已排除'), d.excluded),
    sec(t('修复方案'), d.fix),
    sec(t('要改的文件'), d.files.map((f) => `- \`${f}\``).join('\n')),
    sec(t('影响和风险'), d.risk),
    sec(t('验证计划'), d.verify),
    sec(t('交报告前已改动的文件'), d.before.map((f) => `- \`${f}\``).join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 交一版诊断报告：上一版作废，新的一版挂成等用户确认的请求（不跟「提问」开关走），对话里记一条可点开的报告。
 * 返回给 Agent 的话；不合格时 ok 为 false、什么都不改
 */
export function submitDiagnosis(
  task: DiagTask,
  input: DiagnosisInput,
  newId: () => string,
  now = new Date().toISOString(),
): { ok: boolean; info: string; version?: number } {
  if (!task.bug) return { ok: false, info: '这不是父对话派来的 Bug，不用交诊断报告：按派给你的事直接做。' }
  const prev = latestDiagnosis(task)
  const bad = diagnosisProblem(input, prev)
  if (bad) return { ok: false, info: bad }
  if (prev && prev.status !== 'superseded') prev.status = 'superseded'
  const version = (prev?.version ?? 0) + 1
  const d: Diagnosis = {
    version,
    at: now,
    symptom: input.symptom.trim(),
    repro: input.repro.trim(),
    location: input.location.trim(),
    evidence: input.evidence.trim(),
    rootCause: input.rootCause.trim(),
    confirmed: input.confirmed,
    excluded: input.excluded.trim(),
    fix: input.fix.trim(),
    files: input.files.map(normPath).filter(Boolean),
    risk: input.risk.trim(),
    verify: input.verify.trim(),
    answers: input.answers.filter((a) => a.answer.trim()),
    status: 'pending',
    notes: [],
    overall: '',
    before: (task.changes ?? []).map((c) => normPath(c.path)).filter(Boolean),
  }
  ;(task.diagnoses ??= []).push(d)
  // 上一版还挂着的确认（不该有，防重复）先去掉：同一时间只等一版
  task.requests = task.requests.filter((r) => r.purpose !== 'diagnosis')
  const req: TaskRequest = {
    id: newId(),
    step: '',
    agentId: '',
    kind: 'confirm',
    purpose: 'diagnosis',
    version,
    title: t('诊断报告第 {n} 版', { n: version }),
    detail: diagnosisMarkdown(d, prev),
    options: [],
    at: now,
  }
  task.requests.push(req)
  task.messages.push(diagnosisMessage(newId(), version, t('交了诊断报告第 {n} 版，等你确认方案', { n: version }), now))
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

/**
 * 用户在审阅弹窗里的决定：确认方案，或者带着标注退回再查。只能处理还在等确认的那一版。
 * 返回交给子对话的话（调用方作为新消息发给它）；找不到要处理的版本时返回错误
 */
export function decideDiagnosis(
  task: DiagTask,
  version: number,
  decision: { approve: boolean; notes: Omit<DiagnosisNote, 'id'>[]; overall: string },
  newId: () => string,
  now = new Date().toISOString(),
): { ok: true; message: string } | { ok: false; error: string } {
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
  task.requests = task.requests.filter((r) => r.purpose !== 'diagnosis')
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
export function diagnosisGate(task: Pick<Task, 'bug' | 'diagnoses'>, changed: string[]): string {
  if (!task.bug) return ''
  const d = latestDiagnosis(task)
  if (!d) return '没有请求收尾：这是父对话派来的 Bug，修之前要先用 submit_diagnosis 交诊断报告，用户确认了方案再改。'
  if (d.status === 'pending') return `没有请求收尾：诊断报告第 ${d.version} 版还在等用户确认，确认之前不能收尾。`
  if (d.status === 'questioned')
    return `没有请求收尾：用户对诊断报告第 ${d.version} 版提了意见，先逐条处理、交新一版，等用户确认。`
  const extra = outOfPlan(changed, d.files)
  if (extra.length)
    return `没有请求收尾：这些文件不在用户确认的方案（第 ${d.version} 版）里：${extra.join('、')}。不需要的改回去；确实要改，交新一版诊断报告写明为什么，等用户确认后再收尾。`
  return ''
}
