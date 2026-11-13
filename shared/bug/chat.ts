/**
 * 诊断报告跟上对话（用户 2026-11-13 定，设计稿「诊断报告-跟随子对话聊天更新」）：
 * 用户常常不点报告，直接在子对话里和它聊着改、在聊天里定下方案。以前面板只认弹窗里的按钮，报告停在旧的一版「等你确认」，
 * 改文件被拦（它就用脚本绕过去），收尾也接不上。这里给出一条正路：
 * - 它交报告时带 fromChat：面板取「上一份报告之后用户在对话里说的话」原样存进这一版（chatSaid，不让它转述）；
 * - 带 fromChat.confirm：用户在对话里明确让它照这个做，这一版直接记为确认（approvedBy chat），流程接着往下走；
 *   看错了用户在报告上点「不是这个意思」撤回（retractChat）；
 * - 面板自己算「报告之后用户直接说了几句、多改了哪些文件」（chatStale）：弹窗顶上提示、每轮提示词里提醒、改文件被拦时指路。
 * 判断「这句是不是确认」由 Agent 用工具交，面板不读文字（ADR 0041、0049）；面板只核对引用的确实是用户发的消息。
 * 交给 Agent 的话是提示词，不翻译；对话里那一行、报告上的说法是界面文案，走 t()
 */
import type { Task, TaskMessage } from '../schema.ts'
import type { Diagnosis } from './diagnosis-schema.ts'
import { editScope, labelOf, normPath, outOfPlan, PHASE_TEXT, phaseFeedback, phaseOf, revOf } from './phase.ts'
import { t } from '../i18n.ts'

export type ChatQuote = { id: string; at: string; text: string }

/** 报告上最多摆这么多句原话（太早的那几句一般是问答，最后几句才是定下来的） */
const MAX_SAID = 12
/** 一句原话最多留这么长 */
const MAX_TEXT = 2000
/**
 * 用户在报告上做决定后，页面马上把交给它的话作为一条用户消息发过去（diagnosis-routes 的注释）：
 * 紧跟在报告那一行（bugReport）后面这么久以内的用户消息是面板替用户写的那段话，不是用户在对话里说的
 */
const FEEDBACK_GAP_MS = 15_000

/**
 * 某个时间之后用户在这个对话里亲口说的话：不算别的对话转来的（peer）、面板推的（panel）、
 * 报告上做决定后交过去的那段话（紧跟在报告那一行后面的用户消息）
 */
export function chatSaid(messages: TaskMessage[], since: string): ChatQuote[] {
  const out: ChatQuote[] = []
  let lineAt = 0
  for (const m of messages) {
    if (m.role === 'system' && m.bugReport !== undefined) {
      lineAt = Date.parse(m.at)
      continue
    }
    if (m.role !== 'user') continue
    const feedback = lineAt > 0 && Date.parse(m.at) - lineAt < FEEDBACK_GAP_MS
    lineAt = 0
    if (feedback || m.peer || m.panel || !m.text.trim() || !(m.at > since)) continue
    out.push({ id: m.id, at: m.at, text: m.text.trim().slice(0, MAX_TEXT) })
  }
  return out.slice(-MAX_SAID)
}

/** 从哪个时间起算「之后说的话」：用户已经确认的从确认那一刻算，否则从交报告那一刻算 */
const sinceOf = (d: Diagnosis) => (d.status === 'approved' && d.decidedAt ? d.decidedAt : d.at)

/** 这些状态下报告可能落后于对话：等你确认、你已同意（之后又聊出了新东西） */
const live = (d: Diagnosis | undefined): d is Diagnosis => d?.status === 'pending' || d?.status === 'approved'

/**
 * 最新一版报告是不是落后于对话（面板按事实算，不读文字）：报告之后你在对话里直接说过话。
 * files 是同一段时间里多改的、报告没覆盖的文件（等你确认时：交报告之后才改的；确认后：超出确认范围的）
 */
export function chatStale(
  task: Pick<Task, 'bug' | 'messages'> & Partial<Pick<Task, 'changes'>>,
): { d: Diagnosis; said: ChatQuote[]; files: string[] } | undefined {
  if (task.bug?.kind !== 'report') return undefined
  const list = task.bug.diagnoses ?? []
  const d = list.at(-1)
  if (!live(d)) return undefined
  const said = chatSaid(task.messages, sinceOf(d))
  if (!said.length) return undefined
  const changed = (task.changes ?? []).map((x) => normPath(x.path)).filter(Boolean)
  const scope = d.status === 'pending' ? undefined : editScope(list)
  const files =
    scope && 'files' in scope
      ? outOfPlan(changed, scope.files)
      : outOfPlan(
          changed,
          d.before.map((f) => normPath(f)),
        )
  return { d, said, files }
}

/** submit_diagnosis 的 fromChat 参数：没写返回 undefined；写了 true 或对象都算，confirm 只认对象里的布尔 */
function chatInput(input: Record<string, unknown>): { confirm: boolean } | undefined {
  const raw = input.fromChat
  if (raw === true) return { confirm: false }
  if (!raw || typeof raw !== 'object') return undefined
  return { confirm: (raw as { confirm?: unknown }).confirm === true }
}

export type ChatPick = { said: ChatQuote[]; confirm: boolean }

/**
 * 交报告带了 fromChat：核对上一份报告之后用户确实在对话里说过话，取出原话。
 * 没带返回 undefined；带了但对不上返回 error（交给 Agent 的话）
 */
export function chatOf(
  task: Pick<Task, 'messages'>,
  input: Record<string, unknown>,
  list: Diagnosis[],
): ChatPick | { error: string } | undefined {
  const want = chatInput(input)
  if (!want) return undefined
  const prev = list.at(-1)
  const said = chatSaid(task.messages, prev?.at ?? '')
  if (!said.length)
    return {
      error: prev
        ? `第 ${revOf(prev)} 版报告（报告 #${prev.version}）之后用户没有在对话里直接说过话，不能写 fromChat：按用户在报告上的决定交，或者去掉 fromChat。`
        : '还没有交过报告，不用写 fromChat：照常交第一份。',
    }
  // 同意加日志要面板先给日志计划里的文件拍快照（取消修复后核对删干净用），只能在报告上点
  if (want.confirm && input.phase === 'evidence')
    return {
      error:
        '论证（要加的日志）这一版要用户在报告上同意，fromChat 不能带 confirm：去掉 confirm 再交，等用户在报告上同意加日志。',
    }
  return { said, confirm: want.confirm }
}

/** 等用户确认的上一份，用户在对话里说过话、它要按对话更新时可以顶掉（diagnosisProblem 的「不要重复交」放行） */
export const chatReplaces = (prev: Diagnosis | undefined, chat: ChatPick | undefined) =>
  !!chat && prev?.status === 'pending'

/**
 * 新交的这一版带上原话；带 confirm 的直接记为确认。返回对话里那一行，以及确认了时交给 Agent 的话（和用户点同意时同一段）
 */
export function applyChat(
  d: Diagnosis,
  chat: ChatPick,
  list: Diagnosis[],
  now: string,
): { line: string; feedback?: string } {
  d.chat = chat.said
  const n = labelOf(d, list).ver
  const phase = phaseName(d)
  if (!chat.confirm) return { line: t('它按你在对话里说的更新了诊断报告：第 {n} 版{phase}，等你确认', { n, phase }) }
  const last = chat.said[chat.said.length - 1]
  d.status = 'approved'
  d.approvedBy = { kind: 'chat', id: last.id, at: last.at }
  d.decidedAt = now
  return {
    line: t('它按你在对话里说的更新了诊断报告：第 {n} 版{phase}，你在对话里确认过', { n, phase }),
    feedback: `用户在对话里确认过，面板已把这一版记为用户确认（报告上写明了依据的原话，用户看错了会在报告上撤回）。不用结束这一轮，照下面接着做：\n\n${phaseFeedback(d)}`,
  }
}

const phaseName = (d: Diagnosis) =>
  ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), fix: t('修复'), verify: t('验证') })[phaseOf(d)]

const quoteLines = (said: ChatQuote[]) =>
  said.map((x) => `- ${x.at.slice(11, 16)}：「${x.text.replace(/\s+/g, ' ').slice(0, 400)}」`).join('\n')

/** 「按对话更新」怎么交：提示词、拦截说法、用户点按钮交过去的话共用 */
const HOW = `按现在的实际情况交新的一版 submit_diagnosis，带上 fromChat（面板会附上用户的原话，你不用抄）：
- 方案换了（用户在对话里改了修法、范围）：交 phase: plan，照常写全候选比较、选定和理由、要改的文件、影响面和验证。
- 已经照新的做法改完了：先交 phase: plan，再交 phase: fix（changes 写每个改了的文件改了什么、为什么），面板取实际 diff。
- 用户在对话里明确让你照这个改、或者说了已经修好了：fromChat 写 { confirm: true }，面板记为用户确认，交完不用结束这一轮，接着往下做；用户还没定的不带 confirm，交完结束这一轮等用户在报告上确认。`

/**
 * 每轮提示词里的一段（只在最新一版报告之后用户直接说过话时有）：提醒它把对话里定下的交回报告，不要让报告停在旧的一版
 */
export function bugChatPart(host: { task: Pick<Task, 'bug' | 'messages'> & Partial<Pick<Task, 'changes'>> }): string {
  const s = chatStale(host.task)
  if (!s) return ''
  const v = revOf(s.d)
  const state = s.d.status === 'pending' ? '还在等用户确认' : '用户已经确认'
  return `## 诊断报告要跟上对话
第 ${v} 版报告（${PHASE_TEXT[phaseOf(s.d)]}，报告 #${s.d.version}）${state}，用户在那之后直接在对话里说了 ${s.said.length} 句话。用户的话改了报告里的结论、方案或做法（换了修法、让你照新的改、说已经修好了）时，先把它交回报告，再接着做；只是提问、闲聊，或者是已确认方案里的细节调整（改的还是方案里的文件），不用交。
${HOW}
不要用脚本或命令绕过面板的改文件拦截。`
}

/**
 * 改文件被拦时的说法：报告在等确认、用户却在那之后直接在对话里说了话，原来的「先等用户的回复」不成立（用户已经回复了），
 * 告诉它正路（带 fromChat 交一版），免得它用脚本绕过拦截（用户 2026-11-13 报的实例）。不是这种情况返回原话
 */
export function chatDeny(task: Pick<Task, 'bug'> & Partial<Pick<Task, 'messages'>>, deny: string): string {
  const d = task.bug?.diagnoses?.at(-1)
  if (!d || (d.status !== 'pending' && d.status !== 'questioned')) return deny
  const said = chatSaid(task.messages ?? [], d.at)
  if (!said.length) return deny
  return `第 ${revOf(d)} 版报告（报告 #${d.version}）还没有用户确认，但用户在那之后直接在对话里说了话。用户让你照新的改：先把它交回报告，确认后就能改。用户只是在问、还没让你改：先回答，不改文件。
${HOW}
不要用脚本或命令绕过这个拦截写文件。`
}

/**
 * 用户在报告上点「让它按对话更新报告」：对话里记一行，返回交给它的话（页面再作为消息发过去，和报告上的决定同一条路）
 */
export function syncChat(
  task: Pick<Task, 'bug' | 'messages'> & Partial<Pick<Task, 'changes'>>,
  line: (version: number, text: string) => void,
): { ok: true; message: string } | { ok: false; error: string } {
  const s = chatStale(task)
  if (!s) return { ok: false, error: t('报告之后你没有在对话里说过话，不用更新') }
  const list = task.bug?.diagnoses ?? []
  line(s.d.version, t('你请它按对话更新第 {n} 版诊断报告', { n: labelOf(s.d, list).ver }))
  const files = s.files.length ? `\n\n这段时间还改了报告没覆盖的文件：${s.files.join('、')}。` : ''
  return {
    ok: true,
    message: `用户请你把在对话里定下的整理进诊断报告。第 ${revOf(s.d)} 版报告（${PHASE_TEXT[phaseOf(s.d)]}，报告 #${s.d.version}）之后，用户在对话里说了这些话：
${quoteLines(s.said)}${files}

${HOW}
只是提问、没改结论的：交同一阶段的一版，把回答补进报告（不带 confirm）。`,
  }
}

/**
 * 用户在报告上点「不是这个意思」：撤回在对话里的确认，这一版回到等用户确认。
 * 只能撤回最新一版、而且是按对话确认的；返回交给它的话
 */
export function retractChat(
  task: Pick<Task, 'bug'>,
  version: number,
  line: (version: number, text: string) => void,
): { ok: true; message: string } | { ok: false; error: string } {
  const list = task.bug?.diagnoses ?? []
  const d = list.at(-1)
  if (!d || d.version !== version || d.status !== 'approved' || d.approvedBy?.kind !== 'chat')
    return { ok: false, error: t('这一版不是按对话确认的，或者后面已经交了新的一版') }
  d.status = 'pending'
  d.approvedBy = undefined
  d.decidedAt = undefined
  line(d.version, t('你撤回了在对话里对第 {n} 版的确认，等你在报告上决定', { n: labelOf(d, list).ver }))
  return {
    ok: true,
    message: `用户撤回了在对话里对第 ${revOf(d)} 版（${PHASE_TEXT[phaseOf(d)]}，报告 #${d.version}）的确认：你对用户那几句话的理解不对，这一版回到等用户确认。先停下，不再改文件，结束这一轮；用户会在报告上给决定，或者在对话里接着说清楚。`,
  }
}
