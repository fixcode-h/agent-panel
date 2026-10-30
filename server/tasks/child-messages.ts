import { randomUUID } from 'node:crypto'
import { Task, type PeerFrom, type PeerKind, type TaskMessage } from '../../shared/schema.ts'
import { type ConvState, taskDeleted } from '../../shared/task.ts'
import { steerTask } from '../exec/runner.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import {
  activePlan,
  bindWait,
  releaseParentWait,
  ensureChildStep,
  settleWait,
  syncKids,
  waitNote,
} from '../../shared/plan.ts'
import type { PlanWait } from '../../shared/schema.ts'
import type { TasksScope } from './scope.ts'

/**
 * 父子之间的通知：子对话状态变化写进父计划 / 收件箱（noteParent）、用户直接对子对话说的要求、新要求进计划、父对话交给子对话（sendToChild）。
 */
export function createChildMessages(sc: TasksScope) {
  /**
   * 父对话的聊天里记一条系统消息并放进收件箱：它正在执行就实时交给它。
   * settle：父对话计划里有步骤在等这个子对话时，按结果标完成或退回进行中，并马上让父对话处理（空闲就开一轮），不放进收件箱干等
   * onlyIfWaiting：只有计划里真的在等它时才说一声。子对话每跑完一轮都走这里收口，没在等它时不能往父对话里刷消息
   */
  async function noteParent(
    parentId: string,
    from: Task,
    body: string,
    inboxText = body,
    settle?: { kind: PlanWait['kind']; ref: string; ok: boolean; onlyIfWaiting?: boolean },
    /** 子对话的状态上报：带上是谁、什么状态（行右边写状态，点开能跳到子对话） */
    child?: { id: string; title: string; state: ConvState },
    /** 发件对话：父对话里画成一行「接收消息」 */
    peer?: PeerFrom,
    /** 停下时独立分支里还有没提交的改动：父对话里那一行直接写几个文件、目录在哪，并给「继续」 */
    worktree?: TaskMessage['worktree'],
    /** 父对话得动手的上报（例如子对话只剩合回却没请收尾）：计划里没等它也叫起父对话，不只放进收件箱 */
    wake = false,
  ) {
    const parent = sc.live.get(parentId)?.task ?? (await sc.store.get(parentId))
    if (!parent) {
      // 交回失败：父对话没了，这份上报（计划和状态）没地方记。和「子对话这一轮失败」区分开，日志上单独一条
      log.warn('task', '子对话的上报没能交给父对话：找不到父对话', { from: from.id, parent: parentId })
      return
    }
    const hit = settle ? settleWait(parent, settle.kind, settle.ref, settle.ok) : []
    // 子对话的上报顺带把计划和名下子对话对齐：只在备注里写了「等 xxx」、没挂上等待的步骤也跟着收口
    if (child && syncKids(parent, await sc.planKids(parent.id))) {
      parent.updatedAt = new Date().toISOString()
      const e = sc.live.get(parent.id)
      if (e) e.rev++
      if (settle?.onlyIfWaiting && !hit.length) await sc.store.update(parent.id, parent).catch(() => {})
    }
    if (settle?.onlyIfWaiting && !hit.length) return
    const text = waitNote(hit) + body
    // 用户亲手停下的父对话：子对话的结果不把它叫起来（用户让它停的），记进收件箱，用户点「继续执行」时一起处理
    const userStopped = parent.status === 'stopped' && parent.stopReason === 'user' && !sc.runningConv(parent.id)
    // 子对话是跟着父对话一起停下的（用户停止、归档父对话时 closeChildren 记成 parent）：它的「已中断」同样不叫起父对话。
    // 不能只看上面父对话自己的状态：父对话这一轮已经答完、停在等下一句（或进程已退出）时被停下，收尾记成 done、
    // 不记停止原因；还在收尾时执行位也还占着。这两种都会漏过 userStopped，父对话就被子对话的中断上报叫起来又跑一轮（用户报过）
    const cascaded = child?.state === 'stopped' && from.stopReason === 'parent'
    if ((hit.length || wake) && !userStopped && !cascaded) {
      const entry = sc.live.get(parent.id)
      parent.updatedAt = new Date().toISOString()
      if (entry) entry.rev++
      await sc.store.update(parent.id, parent).catch(() => {})
      try {
        await sc.wakeConv(parent.id, text, {
          panel: 'child',
          ...(child && { child }),
          ...(peer && { peer }),
          ...(worktree && { worktree }),
        })
        return
      } catch (e) {
        // 父对话这会儿被别的操作占着：退回收件箱，它下一轮开始时一起处理
        log.warn('task', '计划步骤等的结果没能马上交给父对话', { task: parent.id, error: (e as Error).message })
        sc.alertOn(parent.id, 'delivery', t('子对话的结果没能马上交给这个对话，已放进收件箱，下一轮会处理'))(e)
      }
    }
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      // 父对话里画成一行「接收消息」（像一次工具调用），点开看全文
      panel: 'child',
      ...(child && { child }),
      ...(peer && { peer }),
      ...(worktree && { worktree }),
      at: new Date().toISOString(),
    }
    // 父对话正在执行：实时交给它；交不了的记进收件箱，父对话下一轮开始时一起处理
    const entry = sc.live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, text, msg).catch(() => false) : false
    // 写进「现在」的那一份：上面读的是磁盘上的旧对象，等待期间父对话可能已经开始执行（执行器拿的是一份拷贝），
    // 再往旧对象里写、拿旧对象落盘，收件箱这条会被执行器下一次落盘盖掉，父对话永远收不到这个子对话的回报
    const target = sc.live.get(parent.id)?.task ?? parent
    if (!how) {
      target.messages.push(msg)
      target.inbox.push({ from: from.id, title: from.title, text: inboxText, at: msg.at })
    }
    target.updatedAt = new Date().toISOString()
    const now = sc.live.get(parent.id)
    if (now) now.rev++
    // 父对话空闲时也要马上落盘，否则页面刷新后看不到子对话的回报
    await sc.store
      .update(parent.id, target)
      .catch((e) => log.warn('task', '回报父对话失败', { error: (e as Error).message }))
  }

  /**
   * 用户直接在子对话里发了消息：父对话计划里挂一步等这个子对话（和父对话 send_to_conversation 同一套，
   * 计划已结束就重开、没有能挂的一步就补一步），并在父对话里记一行说明。
   * 不挂的话子对话做完上报时父对话计划里没人在等它，上报只进收件箱，父对话收不到这个子对话的结果（用户报过）。
   * 父对话不用转交：子对话自己更新计划、自己做，做完由 reportChild 收口那一步并叫起父对话
   */
  async function trackUserToChild(child: Task, text: string) {
    if (!child.parentTaskId) return
    const entry = sc.live.get(child.parentTaskId)
    const parent = entry?.task ?? (await sc.store.get(child.parentTaskId))
    if (!parent || taskDeleted(parent)) return
    const now = new Date().toISOString()
    const at = ensureChildStep(parent, child.id, child.title, now)
    const wait = at ? bindWait(parent, at, { kind: 'child', ref: child.id, label: child.title }, now) : ''
    parent.updatedAt = now
    if (entry) entry.rev++
    await sc.store.update(parent.id, parent)
    // 这一轮重新算一次状态：上一次「已完成」的上报不能挡住这次做完后的上报
    sc.reportedState.delete(child.id)
    const step = at
      ? activePlan(parent)
          ?.steps.flatMap((s) => [s, ...s.children])
          .find((s) => s.id === at)
      : undefined
    const body = `【用户直接交代子对话】用户在子对话「${child.title}」（id ${child.id}）里直接发了新要求：${text.trim().slice(0, 600)}
它会自己更新计划接着做${step && wait ? `，你计划里的「${step.title}」在等它` : ''}，做完会把状态报给你。你不用转交，也不要另建子对话重做；等它的结果回来后按你的计划接着统筹。`
    await noteParent(
      parent.id,
      child,
      body,
      body,
      undefined,
      { id: child.id, title: child.title, state: 'running' },
      await sc.peerOf(child, 'child', 'report', `用户直接交代：${text.trim()}`),
    )
  }

  /**
   * 记下「最近一次带新要求性质的输入」（见 ADR 0020）：下一轮提示里会要求对话先判计划要不要改。
   * 用户消息、父对话交代的任务算；面板自己的推送（后台命令结果、子对话状态上报、催促）不算——
   * 那些对应的步骤面板已经自动推进过了，再要求「先判计划」只会让对话每轮都被追问。
   */
  function notePlanInput(tk: Task, skip = false, now = new Date().toISOString()) {
    if (skip) return false
    const plan = activePlan(tk)
    if (!plan) return false
    plan.lastInputAt = now
    // 新的输入要重新提醒一次（上一次输入已经提醒过的话）
    plan.inputNotedAt = ''
    return true
  }

  /**
   * 把一条消息交给子对话：它正在执行就实时送达，空闲就直接开新的一轮。
   * 父对话的 send_to_conversation 和面板自己推的编译结果都走这里
   */
  async function sendToChild(
    parentId: string,
    id: string,
    message: string,
    /** 面板自己推的结果（后台命令、合并编译）：对话里显示成 AI 回复里的一行，不是用户消息 */
    panel?: TaskMessage['panel'],
    /**
     * 父对话发来的是哪一类（交代任务、回答、收尾结果、编译结果）：子对话里画成「接收消息」，不当成用户说的话。
     * 不给时是面板自己的消息（后台命令结果、催合并），照旧画成面板的一行
     */
    kind?: PeerKind,
    failed = false,
  ): Promise<{ ok: boolean; info: string }> {
    const child = sc.live.get(id)?.task ?? (await sc.store.get(id))
    if (!child || child.parentTaskId !== parentId) return { ok: false, info: '找不到这个子对话' }
    if (child.imported) return { ok: false, info: sc.READONLY }
    // 父对话回话了：子对话计划里在等父对话安排修复的那一步退回进行中，让它重跑验证（见 releaseParentWait）。
    // 不在跑的子对话先落盘，下面 wakeConv 从盘上读
    if (kind && releaseParentWait(child).length) {
      const e = sc.live.get(id)
      if (e) e.rev++
      else await sc.store.update(child.id, child)
    }
    const parent = kind ? (sc.live.get(parentId)?.task ?? (await sc.store.get(parentId))) : undefined
    // 回答是「用户的决定：」换行再写答案：标题里接成一行
    const subject = kind === 'answer' ? message.replace(/：\n/, '：') : message
    const peer = parent && kind ? await sc.peerOf(parent, 'parent', kind, subject, failed) : undefined
    const running = sc.runningConv(id)
    if (running?.task.status === 'running') {
      // 和人工输入走同一套投递：能交给 CLI 就马上实时送达，交不出去就等这一轮结束后接着处理
      const msg: TaskMessage = {
        id: randomUUID(),
        role: panel ? 'system' : 'user',
        agentId: '',
        step: '',
        text: message,
        tools: [],
        ...(panel ? { panel } : {}),
        ...(peer && { peer }),
        at: new Date().toISOString(),
      }
      const r = await sc.deliver(running, msg, message, [])
      const how =
        r.how === 'wait'
          ? '已直接交给子对话，它正在处理'
          : r.how === 'steer'
            ? '子对话正在执行，已实时送达'
            : r.how === 'notes'
              ? '子对话正在执行，已实时送达，它执行中会读到'
              : r.how === 'next-node'
                ? '子对话正在执行，已实时送达，它接下来的步骤会带上'
                : '子对话正在执行，这一轮结束后会自动处理这条'
      return { ok: true, info: `「${child.title}」${how}` }
    }
    // 等它真的开起来再回话：起不来（CLI 没装、独立分支重建失败……）要把错误交回给发消息的一方。
    // 以前是发出去就不管、先回「已交给」，父对话以为它在做，它其实没起来（用户要求起不来必须报错）。
    // 上一轮刚结束、还在收尾时执行位还占着：wakeConv 记进对话排到下一轮，收尾过了那一步就由它补开，消息不能丢
    try {
      await sc.wakeConv(id, message, { ...(panel ? { panel } : {}), ...(peer && { peer }) })
    } catch (e) {
      const why = (e as Error).message
      log.error('task', '子对话没能开始执行', { task: id, error: why })
      sc.alertOn(id, 'panel', t('这个子对话没能开始执行'), 'error')(e)
      return {
        ok: false,
        info: `子对话「${child.title}」没能开始执行：${why}。它确实起不来时，可以另建一个子对话接手它的活（派单里写明接手的是「${child.title}」）。`,
      }
    }
    void (async () => {
      await sc.live.get(id)?.done
    })().catch((e) => {
      log.error('task', '子对话执行出错', { task: id, error: (e as Error).message })
      sc.alertOn(id, 'panel', t('执行这个子对话时出错'), 'error')(e)
    })
    return { ok: true, info: `已交给子对话「${child.title}」，它在后台执行` }
  }

  return { noteParent, notePlanInput, sendToChild, trackUserToChild }
}
