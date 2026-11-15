import { Hono } from 'hono'
import { z } from 'zod'
import { gitNumstat, gitRevertFile, undoSpans } from '../../../exec/git.ts'
import { convChanges } from '../../../../shared/conv-changes.ts'
import { taskLog } from '../../log.ts'
import { taskChanges } from '../../../own-changes.ts'
import { applyFixesInDir } from '../../../files.ts'
import { FixApplyInput } from '../../../../shared/diagnosis.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { currentTask } from '../../read.ts'

/** 改文件的操作：应用排查结论的修复，撤销一个文件、一轮、整个对话的改动 */
export function revertRoutes(s: TasksScope): Hono {
  const app = new Hono()
  /**
   * 排查结论的「应用这 N 处修改」：在被分析的那个对话的工作目录里按原文替换（分析的就是它的代码，
   * 它有独立分支时 taskDir 给的是 worktree）；和对话无关的排查（没有 analysisOf）改分析对话自己的目录。
   * 被分析的对话找不到了不退回别的目录：改错地方比不改更糟，报出来让用户自己处理
   */
  app.post('/:id/apply-fixes', async (c) => {
    const body = FixApplyInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const tk = await currentTask(s, c.req.param('id'))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const owner = tk.analysisOf && tk.analysisOf !== tk.id ? await currentTask(s, tk.analysisOf) : tk
    if (!owner) return s.bad(c, t('被分析的对话已经不在了，不知道该改哪个目录'), 404)
    // 正在动手的对话可能也在改这几个文件，两边一起写会互相覆盖
    if (owner.working) return s.bad(c, t('「{title}」正在执行，等这一轮结束后再应用', { title: owner.title }), 409)
    let dir: string
    try {
      dir = await s.readableDir(owner.id)
    } catch (e) {
      return s.bad(c, (e as Error).message, (e as { status?: 400 | 404 }).status ?? 400)
    }
    return c.json({ dir, results: await applyFixesInDir(dir, body.data.fixes) })
  })

  // 撤销一个文件的改动：恢复成任务开始时的样子
  app.post('/:id/revert', async (c) => {
    const id = c.req.param('id')
    if (s.live.has(id)) return s.bad(c, t('任务正在执行，等它停下后再撤销'), 409)
    const tk = await s.store.get(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    const { path: file } = (await c.req.json().catch(() => ({}))) as { path?: string }
    if (!file || !tk.changes.some((x) => x.path === file)) return s.bad(c, t('这个文件不在任务的改动里'))
    const dir = await s.taskDir(tk)
    if (!dir || (await gitNumstat(dir, tk.baseRef).catch(() => null)) === null)
      return s.bad(c, t('项目不是 git 仓库，没法知道改动前的内容，不能自动撤销'))
    if (file in tk.baseline)
      return s.bad(c, t('这个文件在任务开始前就有没提交的改动，撤销会一起丢掉，请在编辑器里手动处理'))
    try {
      await gitRevertFile(dir, tk.baseRef, file)
    } catch (e) {
      return s.bad(c, t('撤销失败：{error}', { error: (e as Error).message }))
    }
    const changes = (await taskChanges(dir, tk).catch(() => null)) ?? tk.changes
    return c.json(await s.store.update(id, { ...tk, changes }))
  })

  // 撤销一轮的改动（总结下面「已更改 N 个文件」的撤销）：只撤这一轮自己改的，之后用户或后面几轮又改的保留；
  // 有文件撤不干净（同一处后来又改过）时一个都不动，把冲突的文件和原因交回页面
  app.post('/:id/turn-revert', async (c) => {
    const id = c.req.param('id')
    const { msg } = (await c.req.json().catch(() => ({}))) as { msg?: string }
    const tk = await currentTask(s, id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    // 保活等下一句时进程还在，但这时没人在改文件，可以撤；正在回复、子任务或工作流节点还在跑时会和它们抢着写同一批文件
    if (tk.working || tk.steps.some((x) => x.status === 'running'))
      return s.bad(c, t('对话正在执行，等这一轮结束后再撤销'), 409)
    const m = tk.messages.find((x) => x.id === msg)
    const ch = m?.turnChanges
    if (!m || !ch) return s.bad(c, t('这一轮没有记下改动'), 404)
    if (ch.revertedAt) return s.bad(c, t('这一轮的改动已经撤销过了'), 409)
    const dir = await s.taskDir(tk)
    if (!dir) return s.bad(c, t('任务没有工作目录'), 404)
    let r: Awaited<ReturnType<typeof undoSpans>>
    try {
      r = await undoSpans(
        dir,
        ch.spans,
        ch.files.map((f) => f.path),
      )
    } catch (e) {
      return s.bad(c, t('撤销失败：{error}', { error: (e as Error).message }))
    }
    if (!r.ok) return c.json({ ok: false, conflicts: r.conflicts })
    taskLog(id, '撤销了一轮的改动', { message: m.id, files: r.files.length })
    // 对话可能还在内存里（保活）：改内存那份，引擎下一次落盘才不会把撤销标记盖掉
    const at = new Date().toISOString()
    const live = s.live.get(id)?.task
    for (const x of [live, tk]) {
      const lm = x?.messages.find((y) => y.id === m.id)
      if (lm?.turnChanges) lm.turnChanges = { ...lm.turnChanges, revertedAt: at }
    }
    const base = live ?? tk
    const changes = (await taskChanges(dir, base).catch(() => null)) ?? base.changes
    if (live) live.changes = changes
    const saved = await s.store.update(id, { ...base, changes }, { now: true })
    return c.json({ ok: true, task: saved, files: r.files })
  })

  // 撤销整个对话的改动（对话停下后最后面那张改动卡片的撤销）：各轮从后往前一起撤，规则和撤一轮相同——
  // 之后用户自己又改的保留，有文件撤不干净时一个都不动，把冲突交回页面
  app.post('/:id/conv-revert', async (c) => {
    const id = c.req.param('id')
    const tk = await currentTask(s, id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    if (tk.working || tk.steps.some((x) => x.status === 'running'))
      return s.bad(c, t('对话正在执行，等这一轮结束后再撤销'), 409)
    const ch = convChanges(tk.messages)
    if (!ch.files.length) return s.bad(c, t('这个对话没有要撤销的改动'), 404)
    const dir = await s.taskDir(tk)
    if (!dir) return s.bad(c, t('任务没有工作目录'), 404)
    let r: Awaited<ReturnType<typeof undoSpans>>
    try {
      r = await undoSpans(
        dir,
        ch.spans,
        ch.files.map((f) => f.path),
      )
    } catch (e) {
      return s.bad(c, t('撤销失败：{error}', { error: (e as Error).message }))
    }
    if (!r.ok) return c.json({ ok: false, conflicts: r.conflicts })
    taskLog(id, '撤销了整个对话的改动', { turns: ch.turns.length, files: r.files.length })
    const at = new Date().toISOString()
    const live = s.live.get(id)?.task
    for (const x of [live, tk])
      for (const lm of x?.messages ?? [])
        if (lm.turnChanges && ch.turns.includes(lm.id)) lm.turnChanges = { ...lm.turnChanges, revertedAt: at }
    const base = live ?? tk
    const changes = (await taskChanges(dir, base).catch(() => null)) ?? base.changes
    if (live) live.changes = changes
    const saved = await s.store.update(id, { ...base, changes }, { now: true })
    return c.json({ ok: true, task: saved, files: r.files })
  })
  return app
}
