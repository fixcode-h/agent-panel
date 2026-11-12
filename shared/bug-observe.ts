/**
 * 偶发 Bug 的观察期（分析稿 B13）：偶发的 Bug 验证通过就关了，过几天又出现时没人知道它修过，
 * 新开的子对话从头查一遍，原来的修法和证据也接不上。
 * - 偶发的 Bug 修好后标「观察中」OBSERVE_DAYS 天：按修好的时间现算，不另存状态（改天数不用迁移旧数据）。
 * - 观察期里同一个项目又派了 Bug，关键词对得上就自动关联：新 Bug 的派单附上原来的根因和修法，
 *   原来那个记一笔「又报了」，总览页把它列进「等你处理」，提示重开。
 * 状态只看报告的阶段、用户的决定和面板记的字段（bugOutcome），不看回复文字（ADR 0041、0049）。
 * 「偶发」从现象卡（symptom，立案时 Agent 按「多久出一次」写的）和验证结果的运行次数（result.runs）判断
 */
import { phaseOf } from './bug-phase.ts'
import { bugOutcome } from './bug-stats.ts'
import { t } from './i18n.ts'
import type { Task, TaskMessage } from './schema.ts'

/** 观察几天 */
export const OBSERVE_DAYS = 7

const DAY = 86400000

type ObserveTask = Pick<Task, 'id' | 'createdAt' | 'updatedAt' | 'bug' | 'bugCase' | 'diagnoses'> & {
  resolved?: boolean
}

/** 现象卡写了偶发：「多久出一次（必现 / 偶发）」是立案时必填的一项 */
const SOMETIMES =
  /偶发|偶尔|偶现|有时(候)?|时好时坏|间歇|随机|不稳定|概率|不一定|不是每次|intermittent|flaky|sometimes|occasional|randomly/i
/** 明说了不是偶发的：「必现，不是偶发」这种写法里也有「偶发」两个字 */
const ALWAYS = /(不是|并非|非)偶发|必现/

/** 这个 Bug 是偶发的：现象卡里写了偶发，或者验证记了按频率跑了几次（只有偶发的要写 runs） */
export function intermittent(tk: Pick<Task, 'bugCase' | 'diagnoses'>): boolean {
  const symptom = [tk.bugCase?.symptom ?? '', ...(tk.diagnoses ?? []).map((d) => d.symptom)].join('\n')
  if (SOMETIMES.test(symptom) && !ALWAYS.test(symptom)) return true
  const runs = [tk.bugCase?.result?.runs, ...(tk.diagnoses ?? []).map((d) => d.result?.runs)]
  return runs.some((r) => !!r?.trim())
}

/** 修好的时间：验证那一版用户点了结束的时间；标了已解决（父对话收尾合并）的按最后更新的时间 */
function fixedAt(tk: ObserveTask): string | undefined {
  if (bugOutcome({ id: tk.id, createdAt: tk.createdAt, resolved: tk.resolved, diagnoses: tk.diagnoses }) !== 'fixed')
    return undefined
  const d = tk.diagnoses?.at(-1)
  if (d && phaseOf(d) === 'verify' && d.status === 'approved') return d.decidedAt ?? d.at
  return tk.updatedAt
}

/** 观察期的起止：偶发的、修好了的才有；过期了也返回（调用方按 now 判断还在不在观察） */
export function observation(tk: ObserveTask, days = OBSERVE_DAYS): { since: string; until: string } | undefined {
  if (!tk.bug || !intermittent(tk)) return undefined
  const since = fixedAt(tk)
  const ms = since ? new Date(since).getTime() : NaN
  if (!Number.isFinite(ms)) return undefined
  return { since: since!, until: new Date(ms + days * DAY).toISOString() }
}

/** 现在还在观察期里：返回观察到哪天 */
export function observingUntil(tk: ObserveTask, now = new Date().toISOString(), days = OBSERVE_DAYS) {
  const o = observation(tk, days)
  return o && o.until > now ? o.until : undefined
}

/** 太常见、对不上具体问题的词：中文按两个字一组切，英文按词 */
// 模块状态：常量，加载后不改
const STOP_CJK = new Set(
  '用户 一个 时候 没有 出现 问题 现在 这个 那个 但是 然后 之后 以后 已经 还是 就是 不是 可以 应该 显示 点击 打开 页面 报错 一下 有时 偶尔 偶发 每次 几次 正常 不会 不能 会出 的时 时候'.split(
    ' ',
  ),
)
// 模块状态：常量，加载后不改
const STOP_EN = new Set(
  'the and for with not but when then that this from have has was are bug error null true false undefined after before'.split(
    ' ',
  ),
)

/** 一段话里的关键词：英文标识符和路径（小写）记 a:，中文连续的字两两一组记 c: */
export function bugTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z_][\w.\-/]{2,}/g)) {
    const w = m[0].toLowerCase().replace(/[.\-/]+$/, '')
    if (w.length >= 3 && !STOP_EN.has(w)) out.add(`a:${w}`)
  }
  for (const m of text.matchAll(/[一-鿿]{2,}/g)) {
    const s = m[0]
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2)
      if (!STOP_CJK.has(g)) out.add(`c:${g}`)
    }
  }
  return out
}

/** 一个 Bug 用来对关键词的文字：标题和现象（不含根因：再报的人只知道现象） */
const bugText = (tk: Pick<Task, 'title' | 'bugCase' | 'diagnoses'>) =>
  [tk.title, tk.bugCase?.symptom ?? '', tk.diagnoses?.at(-1)?.symptom ?? ''].join('\n')

/**
 * 两组关键词像不像：英文标识符一个算 3 分（文件名、函数名对上了基本就是同一处），中文两字组一个算 1 分。
 * 至少 4 分，并且占较短那一组的三成以上，才算同一类问题——只对上一两个常见词的不算
 */
export function termsMatch(a: Set<string>, b: Set<string>): number {
  const weight = (k: string) => (k.startsWith('a:') ? 3 : 1)
  let shared = 0
  for (const k of a) if (b.has(k)) shared += weight(k)
  const total = (s: Set<string>) => [...s].reduce((n, k) => n + weight(k), 0)
  const small = Math.min(total(a), total(b))
  if (!small || shared < 4 || shared / small < 0.3) return 0
  return shared / small
}

/**
 * 新报的 Bug 和观察期里的哪个是同一类：同一个项目、还在观察期、关键词对得上，取最像的一个。
 * text 是新 Bug 的标题和派单（现象、用户原话）
 */
export function findRelapse<T extends ObserveTask & Pick<Task, 'title' | 'projectId' | 'deletedAt'>>(
  tasks: T[],
  fresh: { id?: string; projectId: string; text: string },
  now = new Date().toISOString(),
): T | undefined {
  const mine = bugTerms(fresh.text)
  let best: { tk: T; score: number } | undefined
  for (const tk of tasks) {
    if (tk.id === fresh.id || tk.projectId !== fresh.projectId || tk.deletedAt) continue
    if (!observingUntil(tk, now)) continue
    const score = termsMatch(mine, bugTerms(bugText(tk)))
    if (score && (!best || score > best.score)) best = { tk, score }
  }
  return best?.tk
}

/** 原来那个 Bug 记一笔「观察期里又报了」：对话里一条系统消息，档案里记新 Bug 的 id（同一个只记一次） */
export function markRelapse(
  orig: Pick<Task, 'bugCase' | 'messages'>,
  fresh: { id: string; title: string },
  id: string,
  now = new Date().toISOString(),
) {
  if (!orig.bugCase) return
  const list = orig.bugCase.relapses ?? []
  if (list.some((x) => x.id === fresh.id)) return
  orig.bugCase.relapses = [...list, { id: fresh.id, title: fresh.title.slice(0, 200), at: now }].slice(-20)
  const msg: TaskMessage = {
    id,
    role: 'system',
    agentId: '',
    step: '',
    text: t('观察期里又报了同类问题「{title}」：这个 Bug 可能没修好，已自动关联，可以重开接着查', {
      title: fresh.title,
    }),
    tools: [],
    at: now,
  }
  orig.messages.push(msg)
}

/** 新 Bug 的派单后面附上原来那个的记录：按原来的根因和修法先核对，别从头查（发给 Agent，不翻译） */
export function relapseNote(orig: Pick<Task, 'id' | 'title' | 'bugCase' | 'diagnoses'>, until: string) {
  const c = orig.bugCase
  const files = c?.files.length ? c.files.map((f) => `\`${f}\``).join('、') : '（没记）'
  const result = c?.result
  return `

## 观察期里的同类 Bug（面板按关键词自动关联）
「${orig.title}」（对话 id ${orig.id}）是偶发的 Bug，修好后在观察期里（到 ${until.slice(0, 10)}），现在又报了同类现象，很可能没修好或没修全：
- 原来的根因：${c?.rootCause.trim() || '（没记）'}
- 原来改的文件：${files}
- 原来的验证：${result?.runs.trim() || result?.reproAfter.trim().slice(0, 300) || '（没记）'}
先核对原来的修法还在不在、这次的现象是不是同一个原因（同一个原因就是没修全，归因写清漏在哪；不是就写依据，按新 Bug 查），不要从头重查。`
}

/** 给父对话的话：已经关联了，告诉用户可以重开原来那个 */
export const relapseInfo = (orig: Pick<Task, 'id' | 'title'>) =>
  `这个现象和观察期里的 Bug「${orig.title}」（id ${orig.id}）关键词对得上，面板已自动关联：新子对话的派单附上了原来的根因和修法，原来那个对话里也记了一笔。告诉用户这个偶发 Bug 在观察期里又出现了、可能没修好；用户要在原来的对话里接着查，就用 send_to_conversation 交给原来那个对话（写 kind: "bug"），再把新开的这个停掉。`
