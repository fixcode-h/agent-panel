import { randomUUID } from 'node:crypto'
import { Task, type DeliveryHow, type TaskMessage } from '../../shared/schema.ts'
import { delegatePrompt } from '../../shared/task.ts'
import { autoAnswerQuestions, steerTask } from '../exec/runner.ts'
import { hasHeld, holdForNextTurn } from '../exec/delivery.ts'
import type { Live } from './types.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { TaskBusyError } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 提问和确认：子对话的提问交给父对话或用户、父对话代答、回答落到对应对话；叫醒对话（wakeConv）也在这里。
 */
export function createAsks(s: TasksScope) {
  /**
   * 父对话把消息交给子对话时：这个子对话还没人回答的提问算父对话回答了，卡片收起。
   * 给了 msgId 只收这一张（用户在弹窗里一个个回答时，别的提问还在等）
   */
  function settleAsks(
    parent: Task,
    childId: string,
    answer: string,
    by: 'user' | 'parent',
    msgId?: string,
    declined = false,
  ) {
    const ids: string[] = []
    for (const m of parent.messages)
      if (m.panel === 'ask' && m.ask?.from === childId && m.ask.answer === undefined && (!msgId || m.id === msgId)) {
        m.ask = { ...m.ask, answer: answer.slice(0, 2000), by, ...(declined ? { declined } : {}) }
        ids.push(m.id)
      }
    if (ids.length)
      void dropChildAsks(childId, ids).catch((e) =>
        log.warn('task', '没能收起子对话的选择弹窗', { task: childId, error: (e as Error).message }),
      )
    return ids.length > 0
  }

  /** 子对话上挂着的提问（选择弹窗）：父对话那边回答了或交出去了就去掉 */
  async function dropChildAsks(childId: string, ids: string[]) {
    const entry = s.live.get(childId)
    const child = entry?.task ?? (await s.store.get(childId))
    if (!child?.parentAsks?.some((x) => ids.includes(x.id))) return
    child.parentAsks = child.parentAsks.filter((x) => !ids.includes(x.id))
    if (entry) entry.rev++
    else await s.store.update(child.id, child)
  }

  /** 交给子对话没成功：把刚收起的提问挂回去，用户还能再答一次 */
  async function restoreChildAsk(childId: string, ask: NonNullable<Task['parentAsks']>[number]) {
    const entry = s.live.get(childId)
    const child = entry?.task ?? (await s.store.get(childId))
    if (!child || child.parentAsks?.some((x) => x.id === ask.id)) return
    child.parentAsks = [...(child.parentAsks ?? []), ask]
    if (entry) entry.rev++
    else await s.store.update(child.id, child)
  }

  /**
   * 用户直接在子对话里回复：这就算回答了它挂在父对话里的提问。
   * 以前只有「在父对话卡片上点选」和「父对话转发」两条路会收起卡片，用户自己进子对话答完，
   * 父对话里的卡片仍停在「待决定」，还得再答一次
   */
  async function settleAskFromChild(childId: string, answer: string) {
    const child = s.live.get(childId)?.task ?? (await s.store.get(childId))
    if (!child?.parentTaskId) return
    const entry = s.live.get(child.parentTaskId)
    const parent = entry?.task ?? (await s.store.get(child.parentTaskId))
    if (!parent || !settleAsks(parent, childId, answer, 'user')) return
    // 父对话的 AI 也从收件箱收到过这个问题：换成「用户已回答」，免得它再决定一遍
    parent.inbox = parent.inbox.filter((x) => !(x.from === childId && x.text.startsWith('（提问）')))
    parent.inbox.push({
      from: childId,
      title: child.title,
      text: `（用户已回答你收到的提问）${answer}`,
      at: new Date().toISOString(),
    })
    parent.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await s.store.update(parent.id, parent)
  }

  /**
   * 让父对话马上处理一件事（子对话的提问交给它决定之类），并把「到底交到了没有」如实告诉调用方。
   * 父对话正在这一轮里：走和用户消息一样的实时交付 —— CLI 停在等下一句就直接续上、能插话就插话、
   * 收不下就记下来这一轮结束后处理。不再只看 working：等下一句、收尾中、预热时 working 都是 false，
   * 但执行位仍然占着，以前直接 followUp 会抛 TaskBusyError、被吞成一条日志，界面上就是「点了没反应」。
   * 完全空闲才开新一轮；开不起来时返回原因，由界面显示给用户。
   */
  async function nudgeParent(parent: Task, text: string) {
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      panel: 'child',
      at: new Date().toISOString(),
    }
    // 刚开始预热、CLI 还没停在等下一句：这一轮收不下，也不能干等它启动完，让用户稍后重试
    if (s.live.get(parent.id)?.task.prewarming) return { ok: false as const, error: t('父对话正在启动，稍后再试') }
    for (let i = 0; i < 2; i++) {
      const entry = runningConv(parent.id)
      if (entry?.task.status === 'running') {
        const r = await s.deliver(entry, msg, text, [])
        return { ok: true as const, how: r.how }
      }
      if (!entry) break
      // 进程还占着执行位但没在跑这一轮（刚结束、正在收尾）：等它收完再开新一轮
      await entry.done?.catch(() => {})
      if (!s.live.has(parent.id)) break
    }
    try {
      await s.followUp(parent.id, { text, attachments: [], panel: 'child' })
      return { ok: true as const, how: 'next' as const }
    } catch (e) {
      if (e instanceof TaskBusyError) return { ok: false as const, error: t('父对话正在执行，等它这一轮结束后重试') }
      return { ok: false as const, error: (e as Error).message }
    }
  }

  /**
   * 对话「正在运行」：占着执行位 —— 执行中、CLI 停在等下一句、预热中、这一轮刚结束还在收尾。
   * 往对话里交消息、判断能不能直接开新一轮，只认这一个判定（用户 2026-10-25 定的）。
   * 不要看 working：它只表示 CLI 正在处理这一轮，等下一句、收尾、预热时都是 false，执行位却还占着，
   * 拿它当「空闲」去 followUp 会被「任务正在执行」拒掉，消息就交不到 CLI。
   * 返回占着执行位的那一份；没在运行时为空，这时才能直接开新一轮
   */
  function runningConv(id: string): Live | undefined {
    return s.live.get(id)
  }

  /**
   * 面板替别人把一件事交给一个对话（子对话的提问交给父对话决定、计划在等的结果、后台命令的结果……），
   * 按 runningConv 走和用户发消息同一套交付：
   * - 正在运行、这一轮还在（执行中、等下一句、预热中）→ deliver：等下一句就直接续上，能插话就插话，收不下就排到这一轮结束后；
   * - 正在运行、这一轮已经结束还在收尾 → 记进对话、排到下一轮，等它收完；收尾已经过了接着开的那一步就由这里补开；
   * - 没在运行 → 直接开新一轮。
   * 这一轮没正常结束（失败、被停止）时排着的会被丢掉：抛错让调用方在对话里留警告。返回这条实际怎么交出去的
   */
  async function wakeConv(
    id: string,
    text: string,
    extra: Pick<TaskMessage, 'panel' | 'peer' | 'child' | 'worktree'> = {},
  ): Promise<DeliveryHow> {
    for (let i = 0; i < 3; i++) {
      const entry = runningConv(id)
      if (!entry) {
        try {
          await s.followUp(id, { text, attachments: [], ...extra })
          return 'next'
        } catch (e) {
          // 并发进来的另一条先占了执行位：下一圈按「正在运行」交给它
          if (!(e instanceof TaskBusyError)) throw e
          continue
        }
      }
      // 没有 panel 的是一条普通的用户消息（父对话交代给子对话的话）
      const msg: TaskMessage = {
        id: randomUUID(),
        role: extra.panel ? 'system' : 'user',
        agentId: '',
        step: '',
        text,
        tools: [],
        ...(extra.panel ? { panel: extra.panel } : {}),
        ...(extra.peer ? { peer: extra.peer } : {}),
        ...(extra.child ? { child: extra.child } : {}),
        ...(extra.worktree ? { worktree: extra.worktree } : {}),
        at: new Date().toISOString(),
      }
      if (entry.task.status === 'running') return (await s.deliver(entry, msg, text, [])).how
      entry.task.messages.push(msg)
      holdForNextTurn(id, msg)
      entry.rev++
      await s.store.update(id, entry.task)
      await entry.done?.catch(() => {})
      if (entry.task.status !== 'done' && !runningConv(id))
        throw new Error(t('这一轮没有正常结束，消息留在对话里，发一条消息或点「继续执行」会处理'))
      if (hasHeld(id) && !runningConv(id))
        await s.followUp(id).catch((e) => {
          // 又被别的消息开了新的一轮：排着的这条由那一轮结束后接着处理
          if (!(e instanceof TaskBusyError)) throw e
        })
      return 'held'
    }
    throw new TaskBusyError('任务正在执行，请等它完成或先停止')
  }

  /**
   * 「提问」关掉时，父对话里还没人回答的子对话提问（历史卡片）一起交给父对话的 AI 决定：
   * 卡片记成已交出、子对话那边的选择弹窗收掉，父对话空闲时开一轮作答。
   * 不做这一步，关掉开关后这些卡片仍停在「等你选择」/「交给父对话决定」，子对话也会一直等着
   */
  async function handChildAsksToParent(parent: Task, working: boolean) {
    const waiting = parent.messages.filter(
      (m) => m.panel === 'ask' && m.ask && m.ask.answer === undefined && !m.ask.delegated,
    )
    if (!waiting.length) return false
    const lines: string[] = []
    for (const m of waiting) {
      const ask = m.ask!
      m.ask = { ...ask, delegated: true }
      await dropChildAsks(ask.from, [m.id])
      lines.push(
        `- 子对话「${ask.title}」${ask.kind === 'suggestion' ? '的收尾建议' : '的提问'}：${ask.question}${
          ask.options.length ? `（可选做法：${ask.options.join(' / ')}）` : ''
        }（交给它用 send_to_conversation，id: ${ask.from}）`,
      )
    }
    const text = `用户关掉了「提问」，下面这些子对话的问题不会再有人回答，请你按已有信息选最合理的做法，把「你替它们决定了什么、依据、不对怎么改」写清楚，再用 send_to_conversation 交给它们：\n${lines.join('\n')}`
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      panel: 'child',
      at: new Date().toISOString(),
    }
    // 插不进去（或者没在执行）时按实时交付叫起父对话：停在等下一句、收尾中、预热时 working 是 false 但执行位还占着
    const how = working ? await steerTask(parent, text, msg).catch(() => false) : false
    if (!how)
      await wakeConv(parent.id, text, { panel: 'child' }).catch((e) => {
        log.warn('task', '关闭提问时没能开始一轮作答', { error: (e as Error).message })
        s.alertOn(parent.id, 'delivery', t('关掉「提问」后没能开一轮去回答子对话的问题'))(e)
      })
    return true
  }

  /**
   * 改一个对话的「提问」：关掉时把还没回答的问题交给 AI 自己选，执行中时把新设置插话给正在跑的 CLI。
   * 父对话按钮、右键菜单、联动到子对话都走这里，不另写一套
   */
  async function applyAskUser(task: Task, on: boolean, working: boolean) {
    if (!on) {
      autoAnswerQuestions(task)
      // 子对话已经问出去、还挂在父对话里的那些，也一起交给 AI：否则卡片仍停在「等你选择」
      await handChildAsksToParent(task, working)
    }
    if (!working) return
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: on ? t('「提问」已打开，后续问题会交给你回答') : t('「提问」已关闭，后续问题由 AI 自己决定'),
      tools: [],
      // 执行中改的：画成 AI 回复里的一行，不在回复中间插一条居中提示
      panel: 'note',
      at: new Date().toISOString(),
    }
    void steerTask(
      task,
      on
        ? '用户打开了「提问」：接下来有问题时用提问工具交给用户回答，不要自己替用户决定。'
        : '用户关闭了「提问」：接下来有问题时自己选最合适的做法，不要再等用户回答。',
      msg,
    ).catch(() => {})
  }

  /**
   * 父对话的「提问」/「子对话也提问」联动到名下已有的子对话：改它们各自的 askUser（引擎按它判断允不允许提问），
   * 并马上落盘——只改界面上的勾选不够，引擎还按旧值决定让不让它问
   */
  async function applyChildAskUser(parent: Task, on: boolean) {
    const kids = (await s.store.list()).filter((k) => k.parentTaskId === parent.id && !k.imported)
    for (const kid of kids) {
      const entry = s.live.get(kid.id)
      const child = entry?.task ?? kid
      if (child.askUser === on) continue
      child.askUser = on
      await applyAskUser(child, on, !!entry?.task.working)
      // 执行中平时按节点落盘，这里要马上写下去，刷新或重启后引擎仍按新设置走
      await s.store.update(child.id, child)
      if (entry) entry.rev++
    }
  }

  /**
   * 把一张提问卡片交给父对话的 AI 决定：先记 delegated 并落盘（刷新后仍是「交给父对话决定」），
   * 再用实时交付叫起父对话（等下一句、收尾中、刚预热时都要交得到），交不到时把原因写回卡片。
   * 用户点卡片上的按钮走这个函数。
   */
  async function delegateAsk(parentId: string, msgId: string) {
    const found = s.live.get(parentId)
    const parent = found?.task ?? (await s.store.get(parentId))
    const m = parent?.messages.find((x) => x.id === msgId && x.panel === 'ask')
    if (!parent || !m?.ask) return null
    const ask = m.ask
    // 已经交出去、也真的叫起过：重复点击不再叫一次（用户会连点好几下）
    if (ask.delegated && ask.delegatedAt) {
      await dropChildAsks(ask.from, [m.id])
      return { task: parent, nudge: { ok: true as const, how: 'already' as const } }
    }
    // 先记成「已交给父对话决定」并落盘：叫父对话时它会重新读这份任务，不先写下去这一步会被新副本盖掉
    ask.delegated = true
    if (found) found.rev++
    await s.store.update(parent.id, parent).catch(() => {})
    await dropChildAsks(ask.from, [m.id])
    // 问题全文一起交过去：父对话续上等下一句的那次调用时，收件箱不会重新读，只写「在收件箱里」它拿不到内容
    const nudge = await nudgeParent(parent, delegatePrompt(ask))
    const cur = s.live.get(parent.id)?.task ?? parent
    const at = new Date().toISOString()
    if (nudge.ok) {
      // 记下叫起的时间，重复点击据此判断；问题已经随消息交出去了，收件箱里不再留一份免得又答一遍
      const done = cur.messages.find((x) => x.id === msgId)?.ask
      if (done) {
        done.delegatedAt = at
        delete done.delegatedError
      }
      cur.inbox = cur.inbox.filter(
        (x) => !(x.from === ask.from && x.text.startsWith('（提问）') && x.text.includes(ask.question)),
      )
    } else {
      // 没能叫起父对话：问题留在收件箱里，父对话下一轮还能读到；卡片上另外显示原因和重试
      if (!cur.inbox.some((x) => x.from === ask.from && x.text.startsWith('（提问）') && x.text.includes(ask.question)))
        cur.inbox.push({ from: ask.from, title: ask.title, text: `（提问）${ask.question}`, at })
      const failed = cur.messages.find((x) => x.id === msgId)?.ask
      if (failed) failed.delegatedError = nudge.error
    }
    const live2 = s.live.get(parent.id)
    if (live2) live2.rev++
    await s.store.update(parent.id, cur).catch(() => {})
    return { task: cur, nudge }
  }

  /**
   * 用户在父对话的提问卡片上回答：答案直接交给子对话，并告诉父对话的 AI 不用再回答；
   * 不回答而是交给父对话决定时（delegate），走 delegateAsk
   */
  async function answerChildAsk(parentId: string, msgId: string, answer: string, delegate: boolean) {
    const found = s.live.get(parentId)
    const parent = found?.task ?? (await s.store.get(parentId))
    const m = parent?.messages.find((x) => x.id === msgId && x.panel === 'ask')
    if (!parent || !m?.ask) return { error: t('找不到这个提问') }
    if (m.ask.answer !== undefined) return { error: t('这个提问已经回答过了') }
    const { from, title, question } = m.ask
    const suggestion = m.ask.kind === 'suggestion'
    if (delegate) {
      const r = await delegateAsk(parent.id, m.id)
      if (!r) return { error: t('找不到这个提问') }
      return r
    }
    // 先把子对话上的选择弹窗收起来再交给它：新一轮会从存储里读一份任务快照，
    // 先开始的话它跑完落盘的那份会把刚收起的弹窗又写回去（父对话卡片已回答，子对话的弹窗却一直留着）。
    // 交不出去时挂回去，父对话卡片还等着用户再答一次
    const ask = { id: m.id, question, options: m.ask.options, kind: m.ask.kind }
    await dropChildAsks(from, [m.id])
    let r: { ok: boolean; info: string }
    try {
      r = await s.sendToChild(
        parent.id,
        from,
        suggestion ? `关于你刚才的收尾建议，用户的决定：\n${answer}` : `关于你刚才的提问，用户的决定：\n${answer}`,
        undefined,
        'answer',
      )
    } catch (e) {
      await restoreChildAsk(from, ask).catch(() => {})
      throw e
    }
    if (!r.ok) {
      await restoreChildAsk(from, ask).catch(() => {})
      return { error: r.info }
    }
    const cur = s.live.get(parent.id)?.task ?? parent
    settleAsks(cur, from, answer, 'user', m.id) // 父对话的 AI 也收到过这个问题：告诉它用户已经回答了，不要再答一遍
    const note = suggestion
      ? `用户已经决定了子对话「${title}」建议的下一步，不用再回答。\n建议：${question}\n用户的选择：${answer}`
      : `用户已经直接回答了子对话「${title}」的提问，不用再回答。\n问题：${question}\n用户的决定：${answer}`
    const live2 = s.live.get(parent.id)
    const steered = live2?.task.working
      ? await steerTask(live2.task, note, {
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: note,
          tools: [],
          panel: 'child',
          at: new Date().toISOString(),
        }).catch(() => false)
      : false
    if (!steered) {
      // 只去掉这一个问题：同一个子对话别的提问还在等
      cur.inbox = cur.inbox.filter((x) => !(x.from === from && x.text.startsWith(`（提问）${question}`)))
      cur.inbox.push({ from, title, text: `（用户已回答你收到的提问）${answer}`, at: new Date().toISOString() })
    }
    cur.updatedAt = new Date().toISOString()
    if (live2) live2.rev++
    await s.store.update(cur.id, cur)
    return { task: cur }
  }

  return { answerChildAsk, applyAskUser, applyChildAskUser, runningConv, settleAskFromChild, settleAsks, wakeConv }
}
