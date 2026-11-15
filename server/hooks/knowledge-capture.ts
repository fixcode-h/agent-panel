import type { HookFacts } from '../../shared/hooks.ts'
import type { ErrorPrint, ProjectLesson } from '../../shared/schema.ts'
import { addEpisode, candidateLesson, dropCandidate, episodePrompt, purposeOf } from '../../shared/knowledge/capture.ts'
import { errorPrint } from '../../shared/knowledge/match/fingerprint.ts'
import { errorLessons } from '../../shared/knowledge/push.ts'
import { recordKnowledgeFeedback } from '../knowledge-hits.ts'
import { recordLessonDraft } from '../knowledge/recorder.ts'
import { updateKnowledgeState } from '../knowledge/store.ts'
import { taskMap } from '../runtime/task-state.ts'
import { taskLog } from '../tasks/log.ts'

/**
 * 当场捕获和推送反馈（设计稿 4.5、4.7，三期）：push-lessons 钩子的 tool.after 里调。全是机械判定，只看工具调用和结果，
 * 不看模型回复的文字（ADR 0041、0049）。
 * - 捕获：一条命令失败、之后 6 次命令内同目的的另一条成功 → 记一条候选，当场提示 Agent 记（每轮最多 2 次，Q1）；
 *   同一个坑在另一个对话里又出现 → 自动转正成教训（Q2）。报错已经有教训覆盖的不捕获（那是反馈要管的）。
 * - 反馈：跑命令前推了教训，这条命令一次就过 → helped；还是报了这条教训记下的错 → violated；
 *   报错对上了某条教训、事前却没推到 → missed
 */

/** 失败后几次命令内改对了才算「换了做法才成」 */
const FIX_WITHIN = 6
/** 每轮最多当场提示几次 */
const PROMPTS_PER_TURN = 2

interface Fail {
  purpose: string
  cmd: string
  print: ErrorPrint
  left: number
}
/** 每个对话最近失败的命令：等它被改对 */
const fails = taskMap<Fail[]>('hooks.knowledge-capture 最近失败的命令') // 运行时（task-state 登记，对话删掉时跟着清）：丢了只是少捕获一次
/** 每个对话里跑命令前推过教训的命令 → 教训 id：等这条命令的结果判反馈 */
const pushedFor = taskMap<Map<string, string[]>>('hooks.knowledge-capture 推过教训的命令') // 运行时（task-state 登记，对话删掉时跟着清）：丢了只是少记一次反馈
/** 每个对话里已经记过 helped 的教训：一个对话只算一次 */
const helpedIn = taskMap<Set<string>>('hooks.knowledge-capture 帮上过的教训') // 运行时（task-state 登记，对话删掉时跟着清）

const keyOf = (cmd: string) => cmd.replace(/\s+/g, ' ').trim().slice(0, 300)

export interface CaptureCtx {
  taskId: string
  projectId: string
  /** 顶层对话 id：候选按它判断「另一个对话」 */
  root: string
  lessons: () => ProjectLesson[]
  /** 这个对话推过的条目（push 的去重集合）：判 missed 用 */
  pushedIds: () => Set<string>
}

/** 跑命令前推了这几条教训：记下来等结果 */
export function notePushedCommand(taskId: string, command: string, ids: string[]) {
  if (!ids.length) return
  const m = pushedFor.get(taskId) ?? new Map<string, string[]>()
  m.set(keyOf(command), [...new Set([...(m.get(keyOf(command)) ?? []), ...ids])])
  pushedFor.set(taskId, m)
}

export function knowledgeCapture(c: CaptureCtx) {
  let prompts = 0

  /** 反馈：在推送本次报错的教训之前调（事前推没推过要按推之前的集合算） */
  const feedback = (cmd: string, failed: boolean, output: string) => {
    const m = pushedFor.get(c.taskId)
    const before = m?.get(keyOf(cmd)) ?? []
    if (m && before.length) m.delete(keyOf(cmd))
    if (!failed) {
      const done = helpedIn.get(c.taskId) ?? new Set<string>()
      helpedIn.set(c.taskId, done)
      const ids = before.filter((id) => !done.has(id))
      ids.forEach((id) => done.add(id))
      if (ids.length) void recordKnowledgeFeedback(c.projectId, ids, 'helped')
      return
    }
    const hit = errorLessons(c.lessons(), output).map((h) => h.id)
    const violated = hit.filter((id) => before.includes(id))
    const seen = c.pushedIds()
    // 漏推：这条教训管得了这个报错，这个对话里却从没推过它
    const missed = hit.filter((id) => !before.includes(id) && !seen.has(id))
    if (violated.length) void recordKnowledgeFeedback(c.projectId, violated, 'violated')
    if (missed.length) void recordKnowledgeFeedback(c.projectId, missed, 'missed')
    if (violated.length || missed.length) taskLog(c.taskId, '知识反馈', { violated, missed })
  }

  /** 捕获：返回要补给模型的一段话（当场提示或「已自动记成教训」），没有就是空串 */
  const capture = async (cmd: string, failed: boolean, output: string): Promise<string> => {
    const purpose = purposeOf(cmd)
    if (!purpose) return ''
    const list = fails.get(c.taskId) ?? []
    if (failed) {
      const print = errorPrint(output)
      // 已经有教训管这个报错：不当新坑
      if (!print.codes.length && !print.words.length) return ''
      if (errorLessons(c.lessons(), output).length) return ''
      fails.set(c.taskId, [{ purpose, cmd, print, left: FIX_WITHIN }, ...list.filter((f) => f.cmd !== cmd)].slice(0, 5))
      return ''
    }
    const live = list.map((f) => ({ ...f, left: f.left - 1 })).filter((f) => f.left > 0)
    const fixed = live.find((f) => f.purpose === purpose && keyOf(f.cmd) !== keyOf(cmd))
    fails.set(
      c.taskId,
      live.filter((f) => f !== fixed && f.purpose !== purpose),
    )
    if (!fixed || !c.projectId) return ''
    const now = new Date().toISOString()
    const r = await updateKnowledgeState(c.projectId, (s) => {
      const x = addEpisode(s, { failed: fixed.cmd, fixed: cmd, purpose, print: fixed.print }, c.root, now)
      return { next: x.recurred ? dropCandidate(x.next, x.cand.id) : x.next, out: x }
    })
    taskLog(c.taskId, '当场捕获', { candidate: r.cand.id, recurred: r.recurred })
    if (r.recurred) {
      const saved = await recordLessonDraft(c.projectId, {
        ...candidateLesson(r.cand),
        cause: [r.cand.cause, `面板自动记下：同样的坑在 ${r.cand.convs.length} 个对话里出现过`]
          .filter(Boolean)
          .join('\n'),
        source: 'agent',
        taskId: c.root,
      })
      return saved.ok
        ? `【面板】这个坑（${purpose}）在别的对话里也踩过，面板已经把它记成了项目教训：${r.cand.title}。可以用 knowledge_record 带 id 把规则改写得更准确。`
        : ''
    }
    if (prompts >= PROMPTS_PER_TURN) return ''
    prompts++
    return episodePrompt(r.cand)
  }

  return {
    async after(facts: HookFacts): Promise<string> {
      const tool = facts.tool
      if (tool?.kind !== 'shell' || !tool.result || !c.projectId) return ''
      const cmd = String(tool.input.command ?? '')
      if (!cmd.trim()) return ''
      const failed = !!tool.result.failed
      const output = tool.result.output ?? ''
      feedback(cmd, failed, output)
      return capture(cmd, failed, output).catch((e) => {
        console.warn('当场捕获失败：', e)
        return ''
      })
    },
  }
}
