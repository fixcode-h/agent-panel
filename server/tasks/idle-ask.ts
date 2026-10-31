import { randomUUID } from 'node:crypto'
import { type TaskMessage } from '../../shared/schema.ts'
import { childIdleAsk, childLastActivity, childWait } from '../../shared/task.ts'
import { childAskUnanswered, childToolRunning } from '../../shared/stuck-child.ts'
import { createStuckChild } from './stuck-child.ts'
import { getSettings } from '../settings.ts'
import { hasHeld, removeHeld } from '../exec/delivery.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

/**
 * 子对话没有输出时以父对话的名义自动问它状态（阈值和次数上限在 shared/task.ts 的 childIdleAsk）；
 * 问过之后到时间还没回复就停掉它、接回会话重启，重启没恢复就换新的子对话接手（见 ./stuck-child.ts）。
 */
export function createIdleAsk(s: TasksScope) {
  const stuck = createStuckChild(s)
  /** 自动询问状态时一分钟按多少毫秒算：测试用环境变量缩短（和 runner 的 idle 检测同一种做法） */
  const askUnitMs = Number(process.env.AGENT_PANEL_MINUTE_MS) || 60_000
  /** 下一次扫描的定时器：服务退出时清掉 */
  let askTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 子对话静默到设置的时间就自动问它状态：阈值、防抖和次数上限都在 shared/task.ts 的 childIdleAsk，
   * 这里只扫内存里还在执行的子对话，经 deliver 以父对话的名义发出去。
   *
   * 走 deliver 而不是新开一轮：非阻塞地先试插话 / 交给正在跑的 CLI，收不下就排到这一轮结束后，
   * 不会占住用户消息的通道。用户的消息还排着（hasHeld）时这一轮不问，先让用户的消息走。
   * 返回下一次扫描的间隔：阈值的四分之一，最多一分钟，设置改了下一轮就按新的来。
   */
  async function askIdleChildren(): Promise<number> {
    let minutes = 0
    try {
      minutes = (await getSettings()).childIdleAskMinutes
    } catch (e) {
      log.warn('task', '读取自动询问的设置失败', (e as Error).message)
    }
    if (!minutes) return 60_000
    const next = Math.min(60_000, Math.max(200, (minutes * askUnitMs) / 4))
    if (s.shuttingDown) return next
    // 先核对面板重启过的子对话：动起来了就放手，没起来就换人接手
    await stuck.checkRestarted()
    const now = Date.now()
    for (const entry of [...s.live.values()]) {
      const tk = entry.task
      // 只管子对话：顶层对话静默由 idleTimeoutMinutes 那一条提醒
      if (!tk.parentTaskId || tk.archived) continue
      if (s.live.get(tk.id) !== entry) continue
      // 用户的消息还排着：先让用户的消息走，这一轮不问（下一轮再判断）
      if (hasHeld(tk.id)) continue
      // 正在重启、正在换人接手的：等那边出结论
      if (stuck.recovering(tk.id)) continue
      const lastActivityAt = childLastActivity(tk)
      const wait = childWait(tk, { background: s.pendingJobs(tk.id), cliAlive: true })
      // 问过状态、到时间还没回复：不再接着问，停掉它接回会话重启
      if (
        childAskUnanswered(
          {
            minutes,
            working: tk.working,
            lastActivityAt,
            wait,
            autoAsk: tk.autoAsk,
            toolRunning: childToolRunning(tk),
            unitMs: askUnitMs,
          },
          now,
        )
      ) {
        const since = Date.parse(lastActivityAt)
        const silent = Math.max(1, Math.round((now - (Number.isFinite(since) ? since : now)) / askUnitMs))
        await stuck.restartStuck(entry, silent)
        continue
      }
      const decision = childIdleAsk(
        { minutes, working: tk.working, lastActivityAt, wait, autoAsk: tk.autoAsk, unitMs: askUnitMs },
        now,
      )
      if (!decision.ask) continue
      const parent = s.live.get(tk.parentTaskId)?.task ?? (await s.store.get(tk.parentTaskId))
      // 读父对话的时候它可能已经被停止、替换掉了：这一轮就不问了
      if (!parent || s.shuttingDown || s.live.get(tk.id) !== entry) continue
      const mins = Math.max(1, Math.round(decision.idleMs / askUnitMs))
      const text =
        `【状态询问】你已经 ${mins} 分钟没有输出了。请简短报告：现在在做什么、是否卡住；` +
        `卡住请说明卡在哪一步、需要什么才能继续。没有卡住就说明下一步还要多久，然后接着做。`
      const msg: TaskMessage = {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text,
        tools: [],
        // 不是用户说的话：CLI 卡住、重启后走 followUp 时也按说明记，不占用户轮次，也不当 rewind 点
        panel: 'note',
        peer: await s.peerOf(parent, 'parent', 'question', '状态询问：这么久没有输出，是否卡住'),
        at: new Date().toISOString(),
      }
      try {
        const sentAt = Date.now()
        const r = await s.deliver(entry, msg, text, [])
        // CLI 已经被标成没有响应，询问交付时就停掉它接回会话重开了：一样核对重开后有没有动起来
        if (r.how === 'restart') stuck.noteRestart(tk.id, sentAt)
        // deliver 可能已经重启了卡住的 CLI（换了一份任务）：记在现在的那一份上，别覆盖掉新状态
        const after = s.live.get(tk.id)?.task ?? r.task
        // 这一轮收不下（CLI 没有插话 / 取补充，或者刚好在收尾）：撤掉这条询问。
        // 留在 held 队列里会让它排在用户消息前面，还会在这一轮结束时开新一轮，把刚收尾的子对话打回未完成。
        // 算一次尝试，从这一刻起再等一个阈值才重试，满 3 次停手
        if (r.how === 'held') {
          removeHeld(tk.id, msg.id)
          after.messages = after.messages.filter((m) => m.id !== msg.id)
          after.autoAsk = { at: new Date().toISOString(), count: decision.count, held: true }
          await s.store.update(after.id, after)
          log.info('task', '子对话这一轮收不下自动询问，跳过', {
            task: tk.id,
            parent: tk.parentTaskId,
            minutes: mins,
            count: decision.count,
          })
          continue
        }
        // 记成询问交付后的最后活动时间：询问自己的那条消息会把时间刷新到这一刻，
        // 之后有输出才显示成「已经回复」；重启路径下 followUp 另记的那条也不会让「等回复」立刻消失
        after.autoAsk = { at: childLastActivity(after) || msg.at, count: decision.count }
        await s.store.update(after.id, after)
        log.info('task', '子对话没有输出，自动问了它的状态', {
          task: tk.id,
          parent: tk.parentTaskId,
          minutes: mins,
          count: decision.count,
          how: r.how,
        })
      } catch (e) {
        // 没交出去也算一次尝试：不然每次扫描都会重试，绕过「最多 3 次」。
        // intoTurn 可能已经把它 push 进对话和 held 队列、落盘时才抛错：照样撤掉，别留到收尾时开新一轮
        const after = s.live.get(tk.id)?.task ?? entry.task
        removeHeld(tk.id, msg.id)
        after.messages = after.messages.filter((m) => m.id !== msg.id)
        after.autoAsk = { at: new Date().toISOString(), count: decision.count, held: true }
        await s.store.update(after.id, after).catch(() => {})
        log.warn('task', '自动询问没能交给子对话', { task: tk.id, error: (e as Error).message })
      }
    }
    return next
  }

  /** 按设置里的间隔扫：启动就扫一次，之后每次用上一次算出的间隔，不改设置也能马上生效 */
  function armIdleAsk() {
    const tick = async () => {
      if (s.shuttingDown) return
      let next = 60_000
      try {
        next = await askIdleChildren()
      } catch (e) {
        log.warn('task', '自动询问子对话状态时出错', (e as Error).message)
      }
      if (s.shuttingDown) return
      askTimer = setTimeout(tick, next)
      askTimer.unref?.()
    }
    void tick()
  }

  /** 服务退出：清掉下一次扫描的定时器 */
  function disarmIdleAsk() {
    clearTimeout(askTimer)
  }

  return { armIdleAsk, disarmIdleAsk, childRecovering: stuck.recovering }
}
