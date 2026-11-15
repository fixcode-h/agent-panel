import { type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { Task } from '../../../../shared/schema.ts'
import { gitNumstat, undoSpans } from '../../../exec/git.ts'
import { createWorktree } from '../../../exec/worktree.ts'
import { convChanges } from '../../../../shared/conv-changes.ts'
import { taskLog } from '../../log.ts'
import { log } from '../../../log.ts'
import { settleBefore } from '../../helpers.ts'
import { taskChanges } from '../../../own-changes.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { forkedTask, rewoundTask, userMessageIndex } from '../../../../shared/restore/rewind.ts'
import { readTask } from '../../read.ts'

/** 停着的对话任务（没在执行）：分叉、撤回、压缩、审查都要先停下 */
async function idleTask(s: TasksScope, c: Context, chatOnly = true) {
  const id = c.req.param('id')!
  const prev = s.live.get(id)
  await settleBefore(prev)
  if (s.live.has(id)) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
  const task = await s.store.get(id)
  if (!task) return s.bad(c, t('任务不存在'), 404)
  if (task.imported) return s.bad(c, s.READONLY, 409)
  if (chatOnly && task.mode !== 'chat') return s.bad(c, t('只有对话任务可以这样做'))
  return task
}

/** 撤回时：这条消息之后开的子对话停下并归档，返回停了几个 */
async function dropLaterChildren(s: TasksScope, id: string, at: string) {
  const kids = (await s.store.list()).filter((x) => x.parentTaskId === id && x.createdAt >= at && !x.archived)
  for (const k of kids) {
    await s.stopTree(k.id, 'parent').catch(() => {})
    const cur = await readTask(s, k.id)
    if (!cur) continue
    cur.archived = true
    cur.updatedAt = new Date().toISOString()
    await s.store.update(k.id, cur)
  }
  return kids.length
}

/**
 * 分叉出来的顶层对话在哪个目录做：以前一律回到项目目录，和原对话（或同项目别的对话）改同一个目录会互相覆盖。
 * 原对话在独立分支里：从它的分支再开一个（看得到它已经提交的改动，合回原对话合回的那个分支；没提交的改动不带）；
 * 没开的按项目设置的默认（isolateByDefault）决定开不开。开不了（不是 git 仓库、没有提交）就照旧在项目目录里做
 */
async function forkWorktree(s: TasksScope, task: Task, id: string, title: string) {
  if (!task.projectId || task.parentTaskId) return null
  const project = await s.deps.projects.get(task.projectId)
  const from = task.worktree?.state === 'active' ? task.worktree : null
  if (!project || (!from && !project.isolateByDefault)) return null
  try {
    const wt = await createWorktree(from?.path ?? project.path, id, title)
    return from ? { ...wt, baseBranch: from.baseBranch } : wt
  } catch (e) {
    log.info('task', '分叉的对话开不了独立分支，在项目目录里做', { task: id, error: (e as Error).message })
    return null
  }
}

/** 停着的对话上的操作：撤回到某条消息、分叉、压缩上下文、审查改动 */
export function registerHistoryRoutes(s: TasksScope) {
  /**
   * 撤回到某条消息：这条和之后的对话都去掉，下一轮从它之前接着聊；返回被撤回的那条，方便改了再发。
   * files：连同被撤掉那几轮改的文件一起撤（每一轮记下的 turnChanges，和「撤销整个对话」同一套 undoSpans）——
   * 以前只截对话，代码还停在撤掉的那几轮之后，用户要再去「更改」里一个个撤（设计报告的 Agent P0-2）。
   * 撤不干净（之后用户或别的对话又改过同一处）时什么都不动，把冲突交回页面。
   * 被撤掉那几轮里建的计划作废、开的子对话停下并归档：它们是为被撤掉的要求做的，留着会接着往下推。
   * 第一条也能撤：等于清空对话重新开始（会话从头开）
   */
  s.routes.post('/:id/rewind', async (c) => {
    const task = await idleTask(s, c)
    if (task instanceof Response) return task
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: string; files?: boolean }
    const i = userMessageIndex(task, body.messageId)
    if (i < 0) return s.bad(c, t('找不到这条消息'))
    const removed = task.messages[i]
    const cut = convChanges(task.messages.slice(i))
    let reverted: string[] = []
    if (body.files && cut.files.length) {
      const dir = await s.taskDir(task)
      if (!dir) return s.bad(c, t('任务没有工作目录'), 404)
      let r: Awaited<ReturnType<typeof undoSpans>>
      try {
        r = await undoSpans(
          dir,
          cut.spans,
          cut.files.map((f) => f.path),
        )
      } catch (e) {
        return s.bad(c, t('撤销失败：{error}', { error: (e as Error).message }))
      }
      if (!r.ok) return c.json({ ok: false, conflicts: r.conflicts })
      reverted = r.files
    }
    const kids = await dropLaterChildren(s, task.id, removed.at)
    const dir = reverted.length ? await s.taskDir(task) : ''
    // 对话怎么截、计划和推送授权怎么撤：和演示后端同一份（shared/restore/rewind.ts）
    const base = rewoundTask(task, i)
    const changes = dir ? ((await taskChanges(dir, base).catch(() => null)) ?? base.changes) : base.changes
    const updated = await s.store.update(task.id, { ...base, changes })
    taskLog(task.id, '撤回到一条消息', {
      files: reverted.length || undefined,
      children: kids || undefined,
    })
    return c.json({ ok: true, task: updated, text: removed.text, attachments: removed.attachments ?? [] })
  })

  // 从某条消息分叉：新建一个对话，带着到这条消息为止的对话（含它的回复），原对话不动
  s.routes.post('/:id/fork', async (c) => {
    const task = await idleTask(s, c)
    if (task instanceof Response) return task
    const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    const i = userMessageIndex(task, messageId)
    if (i < 0) return s.bad(c, t('找不到这条消息'))
    // 新对话带哪些字段：和演示后端同一份（shared/restore/rewind.ts）；独立分支在这里按项目设置开
    const fork = forkedTask(task, i, randomUUID)
    const id = randomUUID()
    const forked = await s.store.create({ ...fork, id, worktree: await forkWorktree(s, task, id, fork.title) })
    return c.json(forked, 201)
  })

  // 压缩上下文：让 CLI 把这个对话的会话压缩（不能压缩的 CLI 写一份摘要，下一轮开新会话带上）
  s.routes.post('/:id/compact', async (c) => {
    const id = c.req.param('id')
    const e = s.live.get(id)
    // 正在回复：现有的 CLI 都没法不打断这一轮就压缩，等这一轮结束（界面上按钮这时是灰的）
    if (e?.task.working) return s.bad(c, t('Agent 正在回复，这一轮结束后才能压缩'), 409)
    // 回复完停在等下一句（保活）：先关掉等着的进程，压缩那一轮再续接会话
    if (e) await s.closeWaiting(id, e)
    const task = await idleTask(s, c)
    if (task instanceof Response) return task
    if (!task.sessions[task.agentId] && !task.rewind) return s.bad(c, t('还没有会话，不需要压缩'))
    const got = s.reserve(task)
    if (!got.fresh) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const entry = got.value
    // 不插居中的「压缩上下文」：压缩一开始 runner 就放一行转圈的工具调用，压缩完成换成前后大小
    try {
      return c.json(await s.start(entry, '', false, await s.deps.agents.list(), { kind: 'compact' }))
    } catch (e) {
      s.release(entry)
      throw e
    }
  })

  // 审查改动：Codex 用自己的审查模式，其他 CLI 按审查的要求跑一轮；只审查，不改文件
  s.routes.post('/:id/review', async (c) => {
    const task = await idleTask(s, c, false)
    if (task instanceof Response) return task
    // 占执行位放在检查目录这些 await 之前：两条「审查」请求不会各自通过检查再各启动一遍
    const got = s.reserve(task)
    if (!got.fresh) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const entry = got.value
    const body = (await c.req.json().catch(() => ({}))) as { base?: string }
    const target = body.base ? { type: 'base' as const, branch: body.base } : { type: 'uncommitted' as const }
    if (!(await s.taskDir(task)) || (await gitNumstat(await s.taskDir(task), '').catch(() => null)) === null) {
      s.release(entry)
      return s.bad(c, t('项目不是 git 仓库，没法审查改动'))
    }
    const text = body.base ? t('审查相对 {branch} 的改动', { branch: body.base }) : t('审查还没提交的改动')
    entry.task.messages.push({
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text,
      tools: [],
      at: new Date().toISOString(),
    })
    try {
      return c.json(await s.start(entry, text, false, await s.deps.agents.list(), { kind: 'review', target }))
    } catch (e) {
      s.release(entry)
      throw e
    }
  })
}
