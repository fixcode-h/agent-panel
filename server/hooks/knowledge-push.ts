import path from 'node:path'
import type { Agent, Project, Task, ToolUse } from '../../shared/schema.ts'
import type { ProjectExperience } from '../../shared/experience.ts'
import type { HookFacts } from '../../shared/hooks/index.ts'
import {
  blockText,
  blockingLesson,
  budgetHits,
  commandLessons,
  errorLessons,
  pathLessons,
  pushText,
  searchExperience,
  type PushHit,
} from '../../shared/knowledge/push.ts'
import { searchText } from '../../shared/knowledge/match/normalize.ts'
import { loadProjectLessons } from '../projects/lessons.ts'
import { withConvLessons } from '../knowledge/agent-record.ts'
import { recordKnowledgeHits } from '../knowledge-hits.ts'
import { taskMap } from '../runtime/task-state.ts'
import { taskLog } from '../tasks/log.ts'
import { knowledgeCapture, notePushedCommand, ranFailed } from './knowledge-capture.ts'

/**
 * 内置钩子「推送项目教训和经验」（push-lessons）：设计稿「经验与教训重新设计」一期 ②③④⑦。
 * 以前只在改完文件之后推管这个文件的教训，现在：
 * - 跑命令、改文件之前（tool.before）：命令对得上教训里写的命令、路径对得上教训的 paths 就推；
 * - 搜索之前（tool.before）：搜索词对得上经验的关键词就把答案推过去，不拦；
 * - 工具失败之后（tool.after）：按报错的特征匹配教训的正文。
 * 同一个对话里一条只推一次；推了的记命中，并在对话里那一行工具调用下面标出来（ToolUse.knowledge）。
 * 匹配规则都在 shared/knowledge/push.ts（回放评测共用）
 */

/** 每个对话里推过的条目 id：同一条只推一次 */
const pushed = taskMap<Set<string>>('hooks.knowledge-push 推过的条目') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再推一次
/** 推了、却还没在对话里找到对应那一行工具调用的标签：下一次钩子事件再找（工具行可能比钩子晚到一点） */
const pending = taskMap<{ facts: HookFacts; hits: PushHit[]; at: number }[]>('hooks.knowledge-push 待标的工具行') // 运行时（task-state 登记，对话删掉时跟着清）：丢了只是少画一个标签

/** 条目最多隔这么久重读一次：别的对话刚记下的、这一轮刚记下的，下一次工具调用就能推到 */
const RELOAD_MS = 2000

export interface KnowledgePushCtx {
  task: Task
  project: Project
  agents: Agent[]
  cwd: string
  step: string
  /** 设置里关了经验时没有（和面板工具同一个开关） */
  experience?: () => Promise<ProjectExperience[]>
  /** 记进设置页的「最近触发」 */
  note: (event: 'tool.before' | 'tool.after', detail: string) => void
  /** 对话改了（标签加上了），推给页面 */
  changed: () => void
  /** 一次最多推几条：按模型档位加强扶持时比默认多（shared/models/support.ts）；不给用 PUSH_RULES 的 */
  maxItems?: number
}

const rel = (cwd: string, p: string) => {
  if (!p) return ''
  const r = path.relative(cwd, path.resolve(cwd, p))
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replace(/\\/g, '/')
}

/** 这次调用的推送：before / after 各返回一段要补给模型的说明（没有就是空串） */
export function knowledgePush(c: KnowledgePushCtx) {
  let loaded = 0
  let lessons: Awaited<ReturnType<typeof loadProjectLessons>>['lessons'] = []
  let exps: ProjectExperience[] = []
  const root = c.task.parentTaskId || c.task.id
  const load = async () => {
    if (Date.now() - loaded < RELOAD_MS) return
    loaded = Date.now()
    // 这个对话自己记下、还没被用户收下的也推（第 8 条）
    lessons = (
      await withConvLessons(
        c.project.id,
        (await loadProjectLessons(c.project, c.agents).catch(() => ({ lessons: [] }))).lessons,
        root,
      )
    ).filter((l) => l.enabled)
    exps = c.experience ? (await c.experience().catch(() => [])).filter((e) => e.enabled) : []
  }

  /** 去掉这个对话推过的，按预算挑，记命中、记触发、标到工具行上 */
  const deliver = (facts: HookFacts, event: 'tool.before' | 'tool.after', all: PushHit[], why: PushHit['why']) => {
    const seen = pushed.get(c.task.id) ?? new Set<string>()
    pushed.set(c.task.id, seen)
    const hits = budgetHits(
      all.filter((h) => !seen.has(h.id)),
      c.maxItems,
    )
    if (!hits.length) return ''
    for (const h of hits) seen.add(h.id)
    const ls = hits.filter((h) => h.kind === 'lesson').map((h) => h.id)
    const es = hits.filter((h) => h.kind === 'experience').map((h) => h.id)
    if (ls.length) void recordKnowledgeHits(c.project.id, 'lessons', ls, root)
    if (es.length) void recordKnowledgeHits(c.project.id, 'experience', es, root)
    const subject = subjectOf(c.cwd, facts)
    c.note(event, `${subject}：${hits.map((h) => h.title).join('、')}`)
    taskLog(c.task.id, '推送项目知识', { why, ids: hits.map((h) => h.id) })
    // 跑命令前推的教训：等这条命令的结果判帮没帮上（server/hooks/knowledge-capture.ts）
    if (why === 'command' && facts.tool) notePushedCommand(c.task.id, String(facts.tool.input.command ?? ''), ls)
    const list = pending.get(c.task.id) ?? []
    list.push({ facts, hits, at: Date.now() })
    pending.set(c.task.id, list)
    flushTags()
    return pushText(hits, why, subject)
  }

  /** 把待标的标签挂到对话里对应的工具行上；找不到的留着下次再找，超过 1 分钟的丢掉 */
  const flushTags = () => {
    const list = pending.get(c.task.id)
    if (!list?.length) return
    const left = list.filter((p) => !tagTool(c.task, c.step, p.facts, p.hits) && Date.now() - p.at < 60_000)
    if (left.length !== list.length) c.changed()
    if (left.length) pending.set(c.task.id, left)
    else pending.delete(c.task.id)
  }

  const capture = knowledgeCapture({
    taskId: c.task.id,
    projectId: c.project.id,
    root,
    lessons: () => lessons,
    pushedIds: () => pushed.get(c.task.id) ?? new Set<string>(),
  })

  return {
    /** 拦截档（用户升级成 block 的教训）：命令对得上就拒绝，返回拒绝理由；没有就是空串 */
    async blocked(facts: HookFacts): Promise<string> {
      const tool = facts.tool
      if (tool?.kind !== 'shell') return ''
      await load()
      const command = String(tool.input.command ?? '')
      const l = blockingLesson(lessons, command)
      if (!l) return ''
      void recordKnowledgeHits(c.project.id, 'lessons', [l.id], root)
      taskLog(c.task.id, '教训拦截命令', { id: l.id })
      return blockText(l, command)
    },
    async before(facts: HookFacts): Promise<string> {
      flushTags()
      const tool = facts.tool
      if (!tool) return ''
      await load()
      const q = lessons.length || exps.length ? searchText(tool.kind, tool.input) : null
      // 搜索：推经验（搜索命令本身不再按命令匹配教训，`rg xxx` 不会是教训要管的那种命令）
      if (q !== null) {
        if (!exps.length) return ''
        const where = typeof tool.input.path === 'string' ? rel(c.cwd, tool.input.path) : ''
        return deliver(facts, 'tool.before', searchExperience(exps, q, where), 'search')
      }
      if (!lessons.length) return ''
      if (tool.kind === 'shell')
        return deliver(facts, 'tool.before', commandLessons(lessons, String(tool.input.command ?? '')), 'command')
      if (tool.kind === 'edit') {
        const files = (tool.paths.length ? tool.paths : [tool.path]).map((p) => rel(c.cwd, p)).filter(Boolean)
        return deliver(
          facts,
          'tool.before',
          files.flatMap((f) => pathLessons(lessons, f)),
          'path',
        )
      }
      return ''
    },
    async after(facts: HookFacts): Promise<string> {
      flushTags()
      const tool = facts.tool
      if (!tool?.result) return ''
      await load()
      // 反馈和当场捕获（要在推本次报错的教训之前判：事前推没推过按推之前的算）
      const caught = await capture.after(facts)
      // 只认 CLI 报出来的失败（failed === true）和命令里自己 echo 的退出码，报不出失败的 CLI 不猜
      const pushedText =
        tool.result.output &&
        lessons.length &&
        (tool.kind === 'shell' ? ranFailed(String(tool.input.command ?? ''), tool.result) : tool.result.failed)
          ? deliver(facts, 'tool.after', errorLessons(lessons, tool.result.output), 'error')
          : ''
      return [pushedText, caught].filter(Boolean).join('\n\n')
    },
  }
}

/** 推送说明里「什么」的那一段：命令、文件或搜索词 */
function subjectOf(cwd: string, facts: HookFacts): string {
  const tool = facts.tool
  if (!tool) return ''
  const q = searchText(tool.kind, tool.input)
  if (q) return q
  if (tool.kind === 'shell') return String(tool.input.command ?? '').replace(/\s+/g, ' ')
  return rel(cwd, tool.path) || tool.path || tool.name
}

/** 钩子事实对应到对话里的哪种工具行 */
const ROW_KINDS: Record<string, ToolUse['kind'][]> = {
  shell: ['run', 'search'],
  edit: ['edit'],
  read: ['read', 'search'],
}

/**
 * 在这个对话（这一步）最近几条回复里，从后往前找和钩子事实对得上的那一行工具调用，把命中的条目挂上去。
 * 按工具行的输入或标题里有没有命令开头、文件名对上来认（钩子只给事实，不给工具行的编号）
 */
export function tagTool(task: Pick<Task, 'messages'>, step: string, facts: HookFacts, hits: PushHit[]): boolean {
  const tool = facts.tool
  if (!tool) return true
  const kinds = ROW_KINDS[tool.kind] ?? []
  const needle =
    tool.kind === 'shell'
      ? String(tool.input.command ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40)
      : path.basename(tool.path || tool.paths[0] || '') || searchText(tool.kind, tool.input) || ''
  if (!needle) return true
  let seenAgent = 0
  for (let i = task.messages.length - 1; i >= 0 && seenAgent < 3; i--) {
    const m = task.messages[i]
    if (m.role !== 'agent' || (m.step || '') !== (step || '')) continue
    seenAgent++
    for (let j = m.tools.length - 1; j >= 0; j--) {
      const t = m.tools[j]
      if (!kinds.includes(t.kind)) continue
      const hay = `${t.input ?? ''}\n${t.label}`.replace(/\s+/g, ' ')
      // 工具行的标题可能是截短的命令，反过来也比一次
      const label = t.label.replace(/\s+/g, ' ').trim()
      if (!hay.includes(needle) && !(label.length >= 8 && needle.includes(label.slice(0, 40)))) continue
      const have = new Set((t.knowledge ?? []).map((k) => k.id))
      t.knowledge = [
        ...(t.knowledge ?? []),
        ...hits.filter((h) => !have.has(h.id)).map((h) => ({ kind: h.kind, id: h.id, title: h.title, why: h.why })),
      ]
      return true
    }
  }
  return false
}
