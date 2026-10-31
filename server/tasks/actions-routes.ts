import { type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TaskPatch, Task, RequestAnswer, defaultAgent } from '../../shared/schema.ts'
import { childHoldText, helpersWorking, trackWait, withTaskModel } from '../../shared/task.ts'
import { agentRun } from '../../shared/settings.ts'
import { childAskEffect } from '../../shared/child-ask.ts'
import { getSettings } from '../settings.ts'
import { gitChanges, gitNumstat, gitRevertFile, undoSpans } from '../exec/git.ts'
import { answerRequest, dropRequests, cancelWait, forgetNotes } from '../exec/runner.ts'
import { taskLog } from '../task-log.ts'
import { placedFiles } from '../attachments.ts'
import { applyFixesInDir } from '../files.ts'
import { FixApplyInput } from '../../shared/diagnosis.ts'
import { t } from '../../shared/i18n.ts'
import type { TasksScope } from './scope.ts'

/**
 * 对话上的操作：应用排查结论的修复、撤销改动、回答子对话提问和权限确认、改对话设置、倒回、分叉、压缩、评审、停止。
 */
export function registerActionRoutes(s: TasksScope) {
  /**
   * 排查结论的「应用这 N 处修改」：在被分析的那个对话的工作目录里按原文替换（分析的就是它的代码，
   * 它有独立分支时 taskDir 给的是 worktree）；和对话无关的排查（没有 analysisOf）改分析对话自己的目录。
   * 被分析的对话找不到了不退回别的目录：改错地方比不改更糟，报出来让用户自己处理
   */
  s.routes.post('/:id/apply-fixes', async (c) => {
    const body = FixApplyInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const tk = await s.current(c.req.param('id'))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const owner = tk.analysisOf && tk.analysisOf !== tk.id ? await s.current(tk.analysisOf) : tk
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
  s.routes.post('/:id/revert', async (c) => {
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
    const changes = (await gitChanges(dir, tk.baseline, tk.baseRef, placedFiles(tk)).catch(() => null)) ?? tk.changes
    return c.json(await s.store.update(id, { ...tk, changes }))
  })

  // 撤销一轮的改动（总结下面「已更改 N 个文件」的撤销）：只撤这一轮自己改的，之后用户或后面几轮又改的保留；
  // 有文件撤不干净（同一处后来又改过）时一个都不动，把冲突的文件和原因交回页面
  s.routes.post('/:id/turn-revert', async (c) => {
    const id = c.req.param('id')
    const { msg } = (await c.req.json().catch(() => ({}))) as { msg?: string }
    const tk = await s.current(id)
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
    const changes =
      (await gitChanges(dir, base.baseline, base.baseRef, placedFiles(base)).catch(() => null)) ?? base.changes
    if (live) live.changes = changes
    const saved = await s.store.update(id, { ...base, changes }, { now: true })
    return c.json({ ok: true, task: saved, files: r.files })
  })

  // 回答子对话交给父对话决定的提问：直接把决定交给子对话，或者交给父对话的 AI 决定
  s.routes.post('/:id/child-asks/:mid', async (c) => {
    const body = z
      .object({ answer: z.string().default(''), delegate: z.boolean().default(false) })
      .safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const answer = body.data.answer.trim()
    if (!answer && !body.data.delegate) return s.bad(c, t('回答是空的'))
    const r = await s.answerChildAsk(c.req.param('id'), c.req.param('mid'), answer, body.data.delegate)
    if ('error' in r) return s.bad(c, r.error ?? '')
    // 带上 nudge：交给父对话决定时到底叫没叫起来，界面据此显示结果或原因（不能只写日志）
    return c.json({ task: r.task, nudge: 'nudge' in r ? r.nudge : undefined })
  })

  // 回答 Agent 的请求：允许 / 拒绝一个操作，或者回答问题
  s.routes.post('/:id/requests/:rid', async (c) => {
    const e = s.live.get(c.req.param('id'))
    const body = RequestAnswer.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    if (!e || !answerRequest(e.task, c.req.param('rid'), body.data, randomUUID))
      return s.bad(c, t('这个请求已经结束了'), 404)
    e.task.updatedAt = new Date().toISOString()
    trackWait(e.task)
    await s.store.update(e.task.id, e.task)
    return c.json(e.task)
  })

  /** 导入的任务上也能改的字段：只是标记，不碰执行 */
  const MARK_KEYS = new Set(['title', 'archived', 'pinned'])
  s.routes.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const p = TaskPatch.safeParse(await c.req.json())
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const e = s.live.get(id)
    const cur = e?.task ?? (await s.store.get(id))
    if (!cur) return s.bad(c, t('任务不存在'), 404)
    // 导入的任务只能看：标题、归档、置顶这类只是标记，照样能改
    if (cur.imported && Object.keys(p.data).some((k) => !MARK_KEYS.has(k))) return s.bad(c, s.READONLY, 409)
    // 子对话标记完成：它的独立分支跟着删掉。改动还没合回原分支时不标，免得把没合的改动一起删了
    if (p.data.resolved === true && cur.parentTaskId) {
      // 用户点「解决」只是发起这一趟流转：判定和置完成在子对话那一侧，还有没收口的东西就拒绝并说清卡在哪一项，
      // 不在这里直接写子对话的最终状态。fromUser 表示这一趟是用户手动点解决的：计划里没做完的步骤一并收口，
      // 不再因为「计划没做完」返回 409（父对话收尾、一轮结束收口仍按原样拦，见 advanceChildTo）
      const { holds, info } = await s.advanceChildTo(id, { fromUser: true })
      if (holds.length) return s.bad(c, info || childHoldText(holds), 409)
      Object.assign(cur, {
        resolved: true,
        worktree: (s.live.get(id)?.task ?? (await s.store.get(id)) ?? cur).worktree,
      })
    }
    // 取消完成：再完成一次时该重新上报父对话
    if (p.data.resolved === false && cur.parentTaskId) {
      s.reportedDone.delete(id)
      s.mergeNudged.delete(id)
    }
    // 归档：只拦正在执行这一轮的；CLI 只是活着（等下一句、预热）时照样归档，顺手结束这个进程和它名下的子对话
    if (p.data.archived === true && e) {
      if (e.task.working) return s.bad(c, t('对话正在执行，等这一轮结束或停止后再归档'), 409)
      if (!cancelWait(id)) s.stopTask(id, 'archive')
      else void s.closeChildren(id)
    }
    // 归档的对话不再接收结果：后台命令（连同名下子对话的）一起停掉
    if (p.data.archived === true) await s.endBackground(id)
    const beforeAgentId = cur.agentId
    const agentChanged = p.data.agentId !== undefined && p.data.agentId !== beforeAgentId
    const touchesRun =
      p.data.cli !== undefined || p.data.model !== undefined || p.data.effort !== undefined || agentChanged
    if (touchesRun && cur.mode !== 'chat') return s.bad(c, t('只有对话任务可以这样做'))
    const settings = touchesRun ? await getSettings() : undefined
    const agents = touchesRun ? await s.deps.agents.list() : undefined
    if (p.data.agentId && !agents?.some((a) => a.id === p.data.agentId)) return s.bad(c, t('找不到这个角色'))
    const runOf = (t: Task) => {
      const agent = t.agentId ? agents?.find((a) => a.id === t.agentId) : { ...defaultAgent(), id: '' }
      return agent && settings ? agentRun(withTaskModel(agent, t), settings) : undefined
    }
    const beforeRun = runOf(cur)
    // 换 CLI 前记下会话是哪个 CLI 的（以前的任务没记），下一轮才知道要开新会话
    if (p.data.cli !== undefined && !cur.sessionCli && cur.sessions[cur.agentId]) {
      const agent = cur.agentId ? agents?.find((a) => a.id === cur.agentId) : { ...defaultAgent(), id: '' }
      if (agent && settings) cur.sessionCli = agentRun(withTaskModel(agent, cur), settings).cli
    }
    const task = cur
    const { childRun, applyChildAsk, ...rest } = p.data
    // 「提问」联动（见 shared/child-ask.ts）：按钮关父对话时已有子对话一起关，右键菜单改的是「之后新建」的默认值，
    // 勾上时再按用户选的「应用到已创建」决定已有的要不要一起开。先算出结论，下面一起应用
    const askEffect = childAskEffect({
      askUser: p.data.askUser,
      childAskUser: p.data.childAskUser,
      applyExisting: applyChildAsk,
    })
    Object.assign(task, rest)
    if (askEffect.askUser !== undefined) task.askUser = askEffect.askUser
    if (askEffect.childAskUser !== undefined) task.childAskUser = askEffect.childAskUser
    // null 表示改回按执行角色自己的配置
    if (childRun !== undefined) task.childRun = childRun ?? undefined
    // 用户自己起了名：之后不再自动换标题
    if (p.data.title !== undefined) task.autoTitle = false
    if (agentChanged) {
      // 换了角色后旧会话里是另一个 Agent 的设定：清掉会话，下一轮新开会话并带上之前的对话摘要
      delete task.sessions[task.agentId]
      delete task.sessions[beforeAgentId]
      delete task.sessionDirs[task.agentId]
      delete task.sessionDirs[beforeAgentId]
      task.sessionCli = undefined
      const history = task.messages
        .filter((m) => !m.transient && m.text.trim())
        .slice(-20)
        .map((m) => `${m.role === 'user' ? '用户' : 'Agent'}：${m.text.trim().slice(0, 300)}`)
        .join('\n')
      task.rewind = history
        ? { session: '', through: null, latest: false, summary: history }
        : { session: '', through: null, latest: false }
    }
    if (askEffect.askUser !== undefined) await s.applyAskUser(task, askEffect.askUser, !!e?.task.working)
    // 右键菜单选了「应用到已创建的子对话」才改已有的（引擎按各自的 askUser 判断，界面靠推送和定时刷新跟着变）
    if (askEffect.existingChildren !== undefined) await s.applyChildAskUser(task, askEffect.existingChildren)
    // 执行中的任务平时按节点落盘，改名这类操作要马上写下去，否则重启后会丢。
    // 只改置顶时不动列表时间：置顶只是标记，不该让这条聊天在别处（最近活动、未读）显得「刚更新过」
    const onlyPin = Object.keys(p.data).every((k) => k === 'pinned')
    await s.store.update(id, task, onlyPin ? { keepUpdatedAt: true } : undefined)
    if (!touchesRun) return c.json(task)
    const afterRun = runOf(task)
    const runChanged =
      agentChanged ||
      (!!beforeRun &&
        !!afterRun &&
        (beforeRun.cli !== afterRun.cli || beforeRun.model !== afterRun.model || beforeRun.effort !== afterRun.effort))
    if (!runChanged) return c.json(task)
    // 正在回复这一轮、或者在等派出的子任务（它们跑在这个进程的这一轮里）：不能现在换进程；
    // 这一轮结束时 start 的收尾、下一条消息交付时都会按新的选择重开
    if (e?.task.working || (e && helpersWorking(e.task))) return c.json(task)
    // 空闲的常驻 CLI：让它结束，按新的选择重新预热，命令和上下文不再显示旧 CLI
    if (e) {
      e.restart = true
      const canceled = cancelWait(id)
      if (!canceled) s.stopTask(id, 'switch')
      if (!e.done) return c.json(task)
      await e.done
      // 子对话不跟着重启：它们有自己的 CLI 和模型，还在跑的被杀就是误杀
      // 这一轮结束后要处理的消息由收尾的 followUp 用新的选择接着跑，不要在这里和它抢执行位
      if (s.live.has(id)) return c.json(s.live.get(id)!.task)
      if (!canceled) task.status = 'done'
    }
    task.command = []
    delete task.usage.agents[task.agentId]
    task.working = false
    task.awaitingUser = false
    task.prewarming = false
    await s.store.update(id, task)
    return c.json(await s.prewarmChat(task, true))
  })

  /** 停着的对话任务（没在执行）：分叉、撤回、压缩、审查都要先停下 */
  async function idleTask(c: Context, chatOnly = true) {
    const id = c.req.param('id')!
    const prev = s.live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (s.live.has(id)) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.imported) return s.bad(c, s.READONLY, 409)
    if (chatOnly && task.mode !== 'chat') return s.bad(c, t('只有对话任务可以这样做'))
    return task
  }

  /** 第 i 条用户消息之前（不含）最近一条用户消息的那一轮，没有时为 null；latest：那一轮是会话的最后一轮 */
  function turnBefore(task: Task, i: number) {
    const prev = [...task.messages.slice(0, i)].reverse().find((m) => m.role === 'user' && !m.step)
    if (!prev?.turn) return { through: null, session: '', latest: false }
    const th = prev.turn
    const at = task.messages.indexOf(prev)
    const latest = !task.messages.slice(at + 1).some((m) => m.turn?.session === th.session)
    return { through: th, session: th.session, latest }
  }

  // 撤回到某条消息：这条和之后的对话都去掉，下一轮从它之前接着聊（文件改动不会撤销）；返回被撤回的那条，方便改了再发
  s.routes.post('/:id/rewind', async (c) => {
    const task = await idleTask(c)
    if (task instanceof Response) return task
    const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    const i = task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)
    if (i < 0) return s.bad(c, t('找不到这条消息'))
    if (!task.messages.slice(0, i).some((m) => m.role === 'user'))
      return s.bad(c, t('第一条消息不能撤回，可以新建一个对话'))
    const removed = task.messages[i]
    const updated = await s.store.update(task.id, {
      ...task,
      messages: task.messages.slice(0, i),
      rewind: { ...turnBefore(task, i), cut: removed.turn ?? null },
      status: 'done',
      todos: [],
    })
    return c.json({ task: updated, text: removed.text, attachments: removed.attachments ?? [] })
  })

  // 从某条消息分叉：新建一个对话，带着到这条消息为止的对话（含它的回复），原对话不动
  s.routes.post('/:id/fork', async (c) => {
    const task = await idleTask(c)
    if (task instanceof Response) return task
    const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    const i = task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)
    if (i < 0) return s.bad(c, t('找不到这条消息'))
    // 留到下一条用户消息之前：这条消息和它的回复都带上
    const next = task.messages.findIndex((m, k) => k > i && m.role === 'user' && !m.step)
    const kept = task.messages.slice(0, next < 0 ? task.messages.length : next)
    const { through, session, latest } = turnBefore(task, next < 0 ? task.messages.length : next)
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = task
    const agents = Object.fromEntries(
      Object.entries(task.usage.agents).map(([k, v]) => [k, { ...v, tps: 0, lastTps: 0, outputTokens: 0, genMs: 0 }]),
    )
    const forked = await s.store.create({
      ...rest,
      title: t('{title}（分叉）', { title: task.title }).slice(0, 80),
      autoTitle: false,
      // 消息 id 换新的，免得两个任务里的消息 id 相同
      messages: kept.map((m) => ({ ...m, id: randomUUID() })),
      // 下一条用户消息那一轮是丢掉的第一轮：只能分叉到某一轮之前的 CLI 按它截
      rewind: { through, session, latest, cut: next < 0 ? null : (task.messages[next].turn ?? null) },
      status: 'done',
      runMs: 0,
      runStartedAt: '',
      requests: [],
      todos: [],
      worktree: null,
      archived: undefined,
      usage: { agents, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    })
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
    const task = await idleTask(c)
    if (task instanceof Response) return task
    if (!task.sessions[task.agentId] && !task.rewind) return s.bad(c, t('还没有会话，不需要压缩'))
    const got = s.reserve(task)
    if (!got.fresh) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const entry = got.value
    entry.task.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t('压缩上下文'),
      tools: [],
      at: new Date().toISOString(),
    })
    try {
      return c.json(await s.start(entry, '', false, await s.deps.agents.list(), { kind: 'compact' }))
    } catch (e) {
      s.release(entry)
      throw e
    }
  })

  // 审查改动：Codex 用自己的审查模式，其他 CLI 按审查的要求跑一轮；只审查，不改文件
  s.routes.post('/:id/review', async (c) => {
    const task = await idleTask(c, false)
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

  /** 用户停止这个对话：停止按钮、提问窗口的关闭都走这里 */
  async function userStop(id: string) {
    // 用户点「暂停」是唯一标成 user 的路径：别处停任务必须写清是谁结束的（见 StopReason）
    s.stopTask(id, 'user')
    // 还在等回答的提问、确认马上作废并落盘：不然返回的任务还带着它们，提问窗口关不掉。
    // 停止是停掉这个对话附属的一切：名下子对话的提问、确认、请用户决定的选择也一起作废
    const kids = (await s.store.list()).filter((x) => x.parentTaskId === id)
    for (const tid of [id, ...kids.map((k) => k.id)]) {
      const e = s.live.get(tid)
      const tk = e?.task ?? (await s.store.get(tid))
      if (!tk) continue
      const asked = !!tk.parentAsks?.length
      if (asked) tk.parentAsks = []
      if (!dropRequests(tk) && !asked) continue
      tk.updatedAt = new Date().toISOString()
      if (e) {
        trackWait(e.task)
        e.rev++
      }
      await s.store.update(tk.id, tk)
    }
    // 停止就是这个对话先别干了：它和名下子对话的后台命令一起停掉，不然跑完的结果推回来又会开新的一轮
    void s.endBackground(id)
  }

  s.routes.post('/:id/stop', async (c) => {
    const id = c.req.param('id')
    taskLog(id, '用户停止', { force: c.req.query('force') ? true : undefined })
    await userStop(id)
    // 强制停止：连 CLI 进程一起结束。平时停止只收这一轮，等下一句的进程留着（下一句直接交给它）；
    // 进程不该再留着时（卡住、换机器前的清理）用这个
    if (c.req.query('force')) {
      cancelWait(id)
      forgetNotes(id)
    }
    return c.json(await s.current(id))
  })

  // 子对话请用户决定的提问，用户点了关闭：这些提问不回答，子对话终止。
  // 父对话里的提问卡片记成「不回答」，它的 AI 也从收件箱知道，不会再替用户决定
  s.routes.post('/:id/parent-asks/close', async (c) => {
    const id = c.req.param('id')
    const e = s.live.get(id)
    const child = e?.task ?? (await s.store.get(id))
    if (!child) return s.bad(c, t('任务不存在'), 404)
    const asks = child.parentAsks ?? []
    if (asks.length && child.parentTaskId) {
      const pe = s.live.get(child.parentTaskId)
      const parent = pe?.task ?? (await s.store.get(child.parentTaskId))
      if (parent) {
        s.settleAsks(parent, id, t('不回答，终止了子对话'), 'user', undefined, true)
        parent.inbox = parent.inbox.filter((x) => !(x.from === id && x.text.startsWith('（提问）')))
        parent.inbox.push({
          from: id,
          title: child.title,
          text: '（用户不回答你收到的提问，终止了这个子对话，不用再替用户决定）',
          at: new Date().toISOString(),
        })
        parent.updatedAt = new Date().toISOString()
        if (pe) pe.rev++
        await s.store.update(parent.id, parent)
      }
    }
    // 子对话这边马上去掉：settleAsks 收起弹窗是异步的，返回的任务里不能再带着它
    child.parentAsks = []
    child.updatedAt = new Date().toISOString()
    if (e) e.rev++
    await s.store.update(child.id, child)
    // 终止：连等下一句的 CLI 进程一起结束（同强制停止），子对话这一轮多半已经说完、停在等回答
    await userStop(id)
    cancelWait(id)
    forgetNotes(id)
    return c.json(await s.current(id))
  })
}
