// 一轮执行结束后的收尾（重构文档第 3 条：从 createRun 的 start 里拆出来）。
//
// failRun：执行抛错时把任务标失败、还在转圈的节点 / 子任务收口，并在对话里写清错误；预热失败不打扰对话。
// settleRun：不管成败都要做的收尾——清运行时标记、预热没处理消息时恢复原状、换了 CLI 时丢掉旧进程的记录、
// 子对话回报父对话、放执行位、接着处理执行中收到的消息、额度用完时按设置换模型或等待。
import { randomUUID } from 'node:crypto'
import type { Agent, Settings, Task } from '../../shared/schema.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { endRun, taskDeleted, withTaskModel } from '../../shared/task.ts'
import { agentRun } from '../../shared/settings.ts'
import { pauseHelper, pauseUnit } from '../../shared/run-stops.ts'
import { t } from '../../shared/i18n.ts'
import { dropHeld, hasHeld, markHeld } from '../exec/delivery.ts'
import { forgetNotes } from '../exec/steering.ts'
import { log } from '../log.ts'
import { taskLog } from '../task-log.ts'
import { TaskBusyError } from './helpers.ts'
import type { Live } from './types.ts'
import type { TasksScope } from './scope.ts'

/** 收尾要用到的：执行位、这一轮开始前的状态、启动时的角色选择和几个 createRun 里的函数 */
export interface SettleCtx {
  sc: TasksScope
  entry: Live
  task: Task
  prewarm: boolean
  /** 这一轮开始前的任务状态（预热失败或没处理消息时恢复成它） */
  before: Task['status']
  beforeUpdatedAt: string
  beforeTurnDoneAt: string
  startAgent: Agent | undefined
  /** 这一轮启动时的 CLI / 模型 / 强度：收尾时比对用户有没有换 */
  startedRun: ReturnType<typeof agentRun> | undefined
  settings: Settings
  /** 落盘（见 run.ts 的 flush） */
  flush: (keepUpdatedAt?: boolean, now?: boolean) => Promise<void>
  /** 接着处理执行中收到的消息（见 run.ts 的 followUp） */
  followUp: (id: string) => Promise<unknown>
  /** 子对话这一轮结束：改过的文件记到名下、撞了交给父对话（见 spawn-child.ts） */
  checkCollisions: (task: Task) => Promise<unknown>
}

/** 执行抛错：标失败、收口还在转圈的节点和子任务，并在对话里写清错误 */
export function failRun(c: SettleCtx, e: unknown) {
  const { entry, task, prewarm, before } = c
  log.error('task', '任务执行出错', { task: task.id, error: e })
  taskLog(task.id, '执行出错', { error: e as Error })
  // 预热失败不打扰对话：恢复原来的状态，等用户发消息时再按正常流程报错
  if (prewarm) {
    entry.task.status = before
    return
  }
  entry.task.status = 'failed'
  // 还画成在跑的节点、子任务一起收口：不然它们一直转圈、没有输出，终止按钮又说已经结束了
  // 子任务中断并暂停（继续执行时在原记录里接着跑，ADR 0042），工作流节点记失败
  const at = new Date().toISOString()
  for (const s of entry.task.steps)
    if (s.status !== 'running') continue
    else if (pauseHelper(task.id, s)) pauseUnit(s)
    else [s.status, s.endedAt] = ['failed', at]
  entry.task.messages.push({
    id: randomUUID(),
    role: 'system',
    agentId: '',
    step: '',
    text: t('执行出错：{error}', { error: (e as Error).message }),
    tools: [],
    error: true,
    alert: makeAlert('error', (e as Error).stack ?? (e as Error).message, 'panel'),
    at: new Date().toISOString(),
  })
}

/** 一轮执行结束（成功、失败、停止都走这里） */
export async function settleRun(c: SettleCtx) {
  const { sc, entry, task, prewarm, before, beforeUpdatedAt, beforeTurnDoneAt, startAgent, startedRun } = c
  const { settings, flush, followUp, checkCollisions } = c
  // 面板已经放弃了这份执行（杀了进程、落了停止、让出了执行位）：后面的收尾都已经做过，再做会盖掉新的一轮
  if (entry.orphaned) {
    taskLog(task.id, '已放弃的执行这时才收完，不再收尾', { status: entry.task.status })
    return
  }
  log.info('task', `任务结束：${entry.task.status}`, { task: task.id })
  taskLog(task.id, '执行结束', {
    status: entry.task.status,
    stopReason: entry.stop ? entry.stopReason : undefined,
    restart: entry.restart || undefined,
    held: hasHeld(task.id) || undefined,
  })
  entry.task.working = false
  entry.task.awaitingUser = false
  entry.task.prewarming = false
  // 排队等 API 名额的标记在 runner 里拿到或停止时就去掉；这里兜底，免得停下的对话还显示在排队
  // 写 undefined、不用 delete：落盘按字段合并，delete 掉的字段在盘上还留着，停止时排队标记已经落过盘就清不掉
  entry.task.apiWait = undefined
  for (const s of entry.task.steps) s.apiWait = undefined
  // 预热收尾要把原来的列表时间写回去，不能让它变成现在
  let keepTime = false
  // 预热只是把 CLI 启动好，没有处理新消息就退出时不要算完成，也不要把列表时间改成现在
  if (prewarm && (entry.task.turnDoneAt ?? '') === beforeTurnDoneAt) {
    // 引擎这时不会标完成，任务还停在 running；状态和时间都回到打开前
    if (entry.task.status === 'done' || entry.task.status === 'running') entry.task.status = before
    entry.task.updatedAt = beforeUpdatedAt
    // 引擎收尾没有走 changed，这里补一次推送
    entry.rev++
    keepTime = true
  }
  // 工作流跑完一整轮才算完成；对话在 CLI 回复完时已经记了 turnDoneAt
  if (!prewarm && entry.task.mode !== 'chat' && entry.task.status === 'done')
    entry.task.turnDoneAt = new Date().toISOString()
  // 执行中用户换了 CLI/模型/强度：旧进程的命令和上下文不能留给新的选择
  const nowRun =
    !prewarm && entry.task.mode === 'chat' && startAgent
      ? agentRun(withTaskModel(startAgent, entry.task), settings)
      : undefined
  const switchedRun =
    !!startedRun &&
    !!nowRun &&
    (startedRun.cli !== nowRun.cli || startedRun.model !== nowRun.model || startedRun.effort !== nowRun.effort)
  if (switchedRun) {
    entry.task.command = []
    delete entry.task.usage.agents[entry.task.agentId]
  }
  endRun(entry.task)
  // 工作流跑完（成功或失败）才有结果可看，这时起标题
  if (!prewarm) sc.nameOnce(entry.task, startedRun?.cli ?? '')
  // 子对话这一轮结束：认领不放、改过的文件记到它名下，撞了交给父对话（见 checkCollisions）。预热的一轮什么都不动
  if (entry.task.parentTaskId && !prewarm) await checkCollisions(entry.task).catch(() => {})
  // 更新摘要并回报父对话（父对话卡片和消息流据此显示进度）
  if (!prewarm && entry.task.parentTaskId) {
    entry.task.summary = sc.lastReply(entry.task)
    // 这一轮结束：消息立即落盘，不等合并窗口（进程保活等下一句时这可能是最后一次写）
    await flush(keepTime, true)
    await sc.reportToParent(entry.task)
  } else await flush(keepTime, true)
  // 只删自己的执行位：这一轮收尾时如果已经有新的一轮占住了，不能把它删掉
  sc.release(entry)
  // 工作流运行这一轮收完：等决定、待合回、完成时给父对话写信（放执行位之后：父对话收信马上合回、退回时不会撞上）
  if (!prewarm && entry.task.flowRun)
    void sc.flowRuns
      .afterTurn(entry.task)
      .catch((e) => log.warn('task', '工作流运行回信失败', { task: task.id, error: (e as Error).message }))
  // 整轮结束了，没被节点取走的补充不会再有人取
  forgetNotes(task.id)
  // 项目里的顶层对话：整个对话（含子对话）都完成了就学经验（几秒内又跑起来就等下一轮结束）。
  // 保活的 CLI 在 onTurnEnd 里已经排过；这里接住不保活的 CLI 和工作流（工作流整轮跑完才到这里），重复排只会重置计时
  if (!prewarm && !entry.task.parentTaskId && entry.task.projectId) void sc.learnExperience(task.id)
  // 这一轮顺利完成：执行中收不下的消息，马上开始新一轮接着处理；失败或暂停时消息留在对话里等用户决定
  // 收尾停掉的（父对话 finish_child、用户点解决：stopReason finish）不是出错：收尾时交来的新任务照样接着处理
  const endedOk = entry.task.status === 'done' || (entry.stop && entry.stopReason === 'finish')
  if (endedOk && hasHeld(task.id) && !sc.shuttingDown) {
    // 这一轮跑着的时候对话被删了（进了回收站或彻底删掉）：排着的消息没有对话可接，直接丢掉，不当成故障报
    const cur = await sc.store.peek(task.id)
    if (!cur || taskDeleted(cur)) dropHeld(task.id)
    else {
      const next = followUp(task.id).catch((e) => {
        // 并发进来的另一条已经开了新的一轮：排着的这条由那一轮接着处理，不是故障
        if (e instanceof TaskBusyError) return
        log.error('task', '接着处理执行中收到的消息失败', { task: task.id, error: (e as Error).message })
        sc.alertOn(task.id, 'delivery', t('收尾后没能接着处理排着的消息'))(e)
      })
      // 正在收尾（completeChild 在等这一份执行收完）：followUp 要先等收尾结束，收尾又在等这里结束，
      // 在这里 await 就互相等死——子对话永远停在「收尾那一刻」，父对话交代的任务也永远开不起来。
      // 这时不等，让这一份执行先收完，收尾结束后 followUp 再开新一轮
      if (!sc.completing.has(task.id)) await next
    }
  } else if (!endedOk) {
    // 这一轮没能正常结束（失败、被停止）：排着的消息不会再被自动处理了。
    // 在对话里把它们改成「没送出去」，用户才知道要重新发一次，而不是一直等着
    const lost = dropHeld(task.id)
    if (lost.length) {
      markHeld(entry.task.messages, lost, 'lost')
      await sc.store
        .update(task.id, entry.task)
        .catch((e) => log.warn('task', '标记没送出去的消息失败', { task: task.id, error: (e as Error).message }))
    }
  }
  // 额度用完 / 被限流失败：按设置换备用模型或等到点继续（默认关；每一步都在对话里写一行）
  if (!prewarm && entry.task.mode === 'chat' && entry.task.status === 'failed' && !sc.shuttingDown)
    void sc.quotaAfterFail(task.id)
  // 没在等下一轮时按新的选择直接预热，下一条消息不会再交给旧 CLI；
  // PATCH 自己负责的重启不要在这里重复做
  if (switchedRun && !entry.restart && entry.task.status === 'done' && !hasHeld(task.id) && !sc.shuttingDown)
    void sc.prewarmChat(entry.task, true).catch((e) => console.error(`按新的选择预热失败：${(e as Error).message}`))
}
