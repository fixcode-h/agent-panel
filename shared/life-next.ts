/**
 * 「状态」窗口最上面那一句：在等谁、等了多久、下一步点什么（分析稿 U11）。
 *
 * 状态窗口（shared/lifecycle.ts）内容很全，但最上面只写「这一轮已说完」「在等你处理：确认操作或回答提问」，
 * 用户第一眼看不出该怎么办。这里按节点的事实拼一句「等你回答 · 已等 12 分钟」，后面跟一个按钮
 * （去回答、继续、重试、换个模型重试、查看在等的子对话）。
 * 短词和标题栏、侧栏同一处取（shared/tasks/word.ts 的 taskWord，服务端收集事实时填进 LifeFacts.word），
 * 判定不另写：状态只读 LifeFacts.state（convState），等了多久读服务端记下的 since。
 */
import { t } from './i18n.ts'
import type { Task } from './schema.ts'
import { pendingAction } from './user-action.ts'
import { stopReasonText } from './task.ts'
import { taskWord } from './tasks/word.ts'
import { untilText } from './quota-resume.ts'
import type { LifeFacts } from './lifecycle.ts'

/** 下一步按钮做什么：go 回到那个对话（去回答、去确认、去操作、去回复）；resume 继续 / 重试；pick 在树上选中另一个节点 */
export interface LifeNextAction {
  kind: 'go' | 'resume' | 'pick'
  label: string
  /** pick：要选中的节点 id（对话就是任务 id） */
  node?: string
}

export interface LifeNext {
  text: string
  tone: 'warning' | 'accent' | 'danger' | 'subtle' | 'success'
  action?: LifeNextAction
  /** 失败的对话再给一个「换个模型重试」（只给 Chat 模式的对话：工作流节点的模型跟着节点走） */
  retryModel?: boolean
}

/** 等了多久：只到分钟（秒级的零头在这句里没有意义），一分钟以内写秒 */
export function waitedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('{n} 秒', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('{n} 分钟', { n: m })
  return t('{h} 小时 {m} 分钟', { h: Math.floor(m / 60), m: m % 60 })
}

/**
 * 服务端（和演示后端）收集对话事实时补的几项：短词、等你处理的是哪一类、这个状态从什么时候开始。
 * since 的口径：等你处理取请求发出 / 等你操作挂上的时间，失败、中断取停下的时间，其余取这一轮结束的时间；
 * 执行中不写（等模型等了多久看模型请求轨迹）；都没有就不写（界面不显示「已等」）
 */
export function lifeWordFacts(
  tk: Parameters<typeof taskWord>[0] &
    Pick<Task, 'mode' | 'turnDoneAt' | 'updatedAt'> &
    Partial<Pick<Task, 'waitStartedAt' | 'userActions' | 'quotaResume'>>,
): Pick<LifeFacts, 'word' | 'need' | 'report' | 'since' | 'mode' | 'quotaUntil'> {
  const w = taskWord(tk)
  const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN)
  let since = NaN
  if (w.state === 'needs') {
    const act = pendingAction(tk)
    since = Math.min(...[ms(tk.waitStartedAt), ms(act?.at)].filter(Number.isFinite))
    if (!Number.isFinite(since)) since = ms(tk.turnDoneAt)
  } else if (w.state === 'failed' || w.state === 'stopped')
    // 失败、中断时任务记录最后一次更新就是停下的那一刻；turnDoneAt 可能还是更早那一轮的
    since = ms(tk.updatedAt)
  else if (w.state !== 'running') since = ms(tk.turnDoneAt) || ms(tk.updatedAt)
  return {
    word: w.word,
    ...(w.need && { need: w.need }),
    ...(w.report && { report: true }),
    ...(Number.isFinite(since) && { since }),
    mode: tk.mode,
    ...(w.state === 'failed' && tk.quotaResume?.until && { quotaUntil: Date.parse(tk.quotaResume.until) }),
  }
}

/** 等你处理时按钮上的动词：和短词对应 */
const GO_LABEL: Record<NonNullable<LifeFacts['need']>, () => string> = {
  answer: () => t('去回答'),
  confirm: () => t('去确认'),
  stage: () => t('去确认'),
  action: () => t('去操作'),
  children: () => t('去处理'),
}

/**
 * 对话节点的下一步。子任务、工作流节点没有（它们跟着所在的对话走，按钮在对话那一行）。
 * now 是生成诊断的时刻（弹窗每 2 秒刷新）
 */
export function lifeNext(f: LifeFacts, now = Date.now()): LifeNext | undefined {
  if (f.kind !== 'conversation' || !f.state) return undefined
  const word = f.word || ''
  const waited = f.since ? waitedFor(now - f.since) : ''
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ')
  switch (f.state) {
    case 'needs':
      return {
        text: join(word, waited && t('已等 {d}', { d: waited })),
        tone: 'warning',
        action: { kind: 'go', label: GO_LABEL[f.need ?? 'children']() },
      }
    case 'running': {
      // 交了诊断报告等你确认（短词「报告待确认」）：等的是你
      if (f.report) return { text: word, tone: 'warning', action: { kind: 'go', label: t('去确认') } }
      // 在等模型：第一段输出还没来就是在等它回，写出等了几秒；有工具在跑就是在等工具
      const tr = f.trace
      if (f.runningTool) return { text: t('在等工具跑完：{tool}', { tool: f.runningTool }), tone: 'accent' }
      if (tr?.requestAt && !(tr.lastOutputAt && tr.lastOutputAt >= tr.requestAt))
        return { text: t('在等模型回复 · 已等 {d}', { d: waitedFor(now - tr.requestAt) }), tone: 'accent' }
      return { text: word || t('执行中'), tone: 'accent' }
    }
    case 'waiting': {
      // 在等计划里的子对话：点一下在左边的树上选中它，看它卡在哪
      const kid = f.waitsOn.find((k) => k.state === 'running' || k.state === 'waiting' || k.state === 'needs')
      const who = kid ? t('在等子对话「{title}」', { title: kid.title }) : word
      return {
        text: join(who, waited && t('已等 {d}', { d: waited })),
        tone: 'accent',
        ...(kid && { action: { kind: 'pick' as const, label: t('查看'), node: kid.id } }),
      }
    }
    case 'failed':
      // 额度用完在等到点自动继续：写出几点继续，按钮是「现在继续」（不想等就自己点）
      if (f.quotaUntil)
        return {
          text: t('等额度恢复 · {time} 自动继续', { time: untilText(f.quotaUntil, now) }),
          tone: 'warning',
          action: { kind: 'resume', label: t('现在继续') },
          retryModel: f.mode === 'chat',
        }
      return {
        text: join(t('这一轮失败了'), waited && t('{d}前', { d: waited })),
        tone: 'danger',
        action: { kind: 'resume', label: t('重试') },
        retryModel: f.mode === 'chat',
      }
    case 'stopped':
      return {
        text: join(t('已中断：{why}', { why: stopReasonText(f.stopReason) }), waited && t('{d}前', { d: waited })),
        tone: 'subtle',
        action: { kind: 'resume', label: t('继续') },
      }
    case 'wrapup':
      return { text: join(t('在等父对话收尾'), waited && t('已等 {d}', { d: waited })), tone: 'success' }
    case 'unfinished':
      return {
        text: join(t('计划还没做完，在等你说下一步'), waited && t('已等 {d}', { d: waited })),
        tone: 'warning',
        action: { kind: 'go', label: t('去对话') },
      }
    default:
      if (f.resolved) return { text: join(t('已完成'), waited && t('{d}前', { d: waited })), tone: 'success' }
      return {
        text: join(t('这一轮答完了，在等你的下一句'), waited && t('已等 {d}', { d: waited })),
        tone: 'success',
        action: { kind: 'go', label: t('去回复') },
      }
  }
}
