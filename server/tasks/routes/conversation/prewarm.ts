import { Hono } from 'hono'
import { defaultAgent, type Task } from '../../../../shared/schema.ts'
import { withTaskModel } from '../../../../shared/tasks/run.ts'
import { agentRun } from '../../../../shared/settings.ts'
import { getCli } from '../../../../shared/clis.ts'
import { getSettings } from '../../../settings.ts'
import { taskLog } from '../../log.ts'
import { touchPresence } from '../../../presence.ts'
import type { Live } from '../../types.ts'
import { existsSync } from 'node:fs'
import { log } from '../../../log.ts'
import { t } from '../../../../shared/i18n.ts'
import { killTree } from '../../../exec/process.ts'
import { killTaskClis } from '../../../exec/orphans.ts'
import type { TasksScope } from '../../scope.ts'
import { PREWARM_PROMPT } from '../../helpers.ts'
import { currentTask } from '../../read.ts'

/**
 * 执行位还占着、但这一轮已经结束（status 已标完 done、收尾还在落盘）时，预热不能直接把它原样返回：
 * 那样拿到的是 done，CLI 根本没启动。还在真跑（执行中 / 停在等下一句 / 正在预热）的才复用，
 * 收尾中的等它释放；等完之后又被新的一轮占住就返回那一份，没有就返回 undefined 走正常启动流程
 */
async function reusedPrewarmEntry(s: TasksScope, id: string): Promise<Task | undefined> {
  const entry = s.live.get(id)
  if (!entry) return undefined
  const now = entry.task
  if (now.status === 'running' || now.awaitingUser || now.prewarming) return now
  await entry.done?.catch(() => {})
  return s.live.get(id)?.task
}

/**
 * 在后台用 --resume 启动对话的 CLI，让它停在等下一句的工具上。
 * force：用户刚换了 CLI/模型/强度，即使会话属于旧 CLI 也要按新的选择重开，
 * 把之前的对话带过去，下一条消息直接交给新进程。
 */
export async function prewarmChat(s: TasksScope, task: Task, force = false): Promise<Task> {
  // 执行位收尾中（已经 done）时等它释放，别把没启动的 done 原样交回去
  const reused = await reusedPrewarmEntry(s, task.id)
  if (reused) return reused
  if (task.imported || task.mode === 'workflow') return task
  // 独立分支的工作区已经被回收（合并完、标记完成）：预热不了，也不自动去建分支，
  // 等用户真发消息时再重建（后台打开对话页面不应该多出一个分支）
  const wt = task.worktree
  if (wt && (wt.state === 'active' || wt.state === 'merged') && !existsSync(wt.path)) return task
  // 没有会话、刚撤回时下一轮本来就要重开，预热没有意义
  if (!task.sessions[task.agentId] || task.rewind) return task
  // 落盘里还写着「执行中」但内存里没有这个任务：进程早就不在了（面板重启、崩溃），
  // 当成空闲处理，否则重新打开对话时永远不会把 CLI 启动回来
  if (task.status === 'running') {
    task.status = 'stopped'
    task.stopReason = 'restart'
    task.working = false
    task.awaitingUser = false
    task.prewarming = false
  }
  let entry: Live | undefined
  try {
    const settings = await getSettings()
    const agents = await s.deps.agents.list()
    // 没选 Agent 的对话（agentId 为空）直接跟默认 CLI 对话，用默认 Agent 的配置预热；
    // CLI、模型按对话里选的那一套，和真正发消息时一致
    const noAgent = !task.agentId
    const found = noAgent ? defaultAgent() : agents.find((a) => a.id === task.agentId)
    if (!found) return task
    if (!noAgent && !found.enabled) return task
    const agent = withTaskModel(noAgent ? { ...found, id: '' } : found, task)
    const run = agentRun(agent, settings)
    const def = getCli(run.cli)
    // 能保活（keepAlive）的对话才值得先启动进程等着：不然预热了也用不上，每轮还是重启
    if (!def?.keepAlive) return task
    // Claude Code、Codex 有自己的协议，不走面板的等待工具
    if (def.rpc?.nativeAsk) return task
    if (!force && task.sessionCli && task.sessionCli !== run.cli) return task
    // 走到这里之前可能又有别的请求占住执行位：真在跑就复用，收尾中就先等它释放
    const again = await reusedPrewarmEntry(s, task.id)
    if (again) return again
    const got = s.reserve(task)
    entry = got.value
    // 另一个请求已经先占住（真正发消息或另一次预热）：复用它的执行位，不再开第二个 CLI
    if (!got.fresh) return entry.task
    taskLog(task.id, '预热', { cli: run.cli, force: force || undefined })
    return await s.start(entry, PREWARM_PROMPT, false, agents, undefined, false, true)
  } catch (e) {
    taskLog(task.id, '预热失败', { error: e as Error })
    if (entry) s.release(entry)
    log.warn('task', '对话预热失败', { task: task.id, error: (e as Error).message })
    s.alertOn(task.id, 'cli_exit', t('提前启动 Agent 失败：发消息时会再启动一次，仍然失败会在这里报错'))(e)
    return task
  }
}

/** 打开对话页时的预热，以及对话菜单的「激活 Agent」「关闭 Agent」 */
export function prewarmRoutes(s: TasksScope): Hono {
  const app = new Hono()
  // 打开对话页时调用
  app.post('/:id/prewarm', async (c) => {
    const id = c.req.param('id')
    // 看到 done 就立刻预热的请求会撞在「状态标完、执行位还没释放」的那几毫秒上：
    // 先等它收尾，再按正常流程启动，不要返回一份没启动的 done
    const reused = await reusedPrewarmEntry(s, id)
    if (reused) return c.json(reused)
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    return c.json(await prewarmChat(s, task))
  })

  /**
   * 对话菜单「激活 Agent」：不发消息，先把这个对话的 CLI 用 --resume 拉起来停在等下一句上（和打开对话页的预热同一条路）。
   * 从侧栏点的时候页面可能没开着、早过了宽限：先当成刚有人看过，不然 CLI 一停到等待就退出了。
   * 不能提前启动的（没有会话、CLI 不支持停在等待上）原样返回，界面按返回的状态告诉用户
   */
  app.post('/:id/agent/activate', async (c) => {
    const id = c.req.param('id')
    const reused = await reusedPrewarmEntry(s, id)
    if (reused) return c.json(await s.withLive(reused))
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.archived) return s.bad(c, t('归档的对话不能激活，先取消归档'), 409)
    touchPresence(id)
    taskLog(id, '激活 Agent')
    return c.json(await s.withLive(await prewarmChat(s, task)))
  })

  /**
   * 对话菜单「关闭 Agent」：结束这个对话的 CLI 进程、释放资源，对话和会话都留着，下一条消息按 --resume 续接。
   * 正在执行这一轮的不关（和归档一样）：那是「暂停」的事，关进程会把这一轮掐断。
   * 名下子对话不跟着关：它们有自己的进程，只是父对话这边不再占着 CLI
   */
  app.post('/:id/agent/close', async (c) => {
    const id = c.req.param('id')
    const e = s.live.get(id)
    if (!e && !(await s.getMeta(id))) return s.bad(c, t('任务不存在'), 404)
    if (e?.task.working) return s.bad(c, t('对话正在执行，先暂停这一轮再关闭 Agent'), 409)
    if (e) await s.closeWaiting(id, e)
    // 执行位已经没了、进程登记还在（某条路径漏停、重启前留下的）：按登记结束，界面说关了就真的关了
    if (!s.live.has(id))
      await killTaskClis(id, killTree).catch((err) =>
        log.warn('task', '关闭 Agent 时结束残留进程失败', { task: id, error: (err as Error).message }),
      )
    log.info('task', '用户关闭了对话的 Agent', { task: id })
    taskLog(id, '关闭 Agent')
    const now = await currentTask(s, id)
    if (!now) return s.bad(c, t('任务不存在'), 404)
    return c.json(await s.withLive(now))
  })
  return app
}
