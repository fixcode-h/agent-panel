import { randomUUID } from 'node:crypto'
import { Task, type AskKind, type TaskMessage } from '../../shared/schema.ts'
import { askOptions } from '../../shared/task.ts'
import { steerTask } from '../exec/runner.ts'
import { type HelperSpec, type Orchestra } from '../../shared/engine.ts'
import { makeAlert } from '../../shared/alerts.ts'
import type { ForwardedSpawn } from './types.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import type { TasksScope } from './scope.ts'

/** 子对话请父对话安排修复的报错（engine 的 toParent 带 wait_fix 时加的开头）：要父对话马上动手，不并进一轮结束的汇报 */
const FIX_HEAD = /^【报错不是我改出来的/

/**
 * 子对话和父对话之间的消息：子对话传话给父对话、转交子任务请求、把排着的转交接到父对话这一轮的 Orchestra 上。
 */
export function createPeer(s: TasksScope) {
  /**
   * 子对话给父对话发消息：父对话正在执行就实时交给它，否则记进父对话，下一轮一起处理。
   * 汇报只交给父对话的 AI（界面上在子对话自己的对话里看）；提问、收尾建议在父对话里显示成可以直接选择的卡片。
   * kind 为 suggestion 时是这一轮做完的收尾建议：说法不一样，没给选项时补上默认的两个
   */
  async function messageParent(
    child: Task,
    text: string,
    question: boolean,
    options: string[] = [],
    kind: AskKind = 'question',
  ) {
    const parent = s.live.get(child.parentTaskId)?.task ?? (await s.store.get(child.parentTaskId))
    if (!parent) {
      // 交回失败：父对话已经没了（被删、数据丢了），子对话的结果交不出去。
      // 只写日志不够：界面要和「子对话自己跑挂了」分得开，所以在子对话里留一张「消息没有送到」的卡
      log.warn('task', '子对话的汇报没能交给父对话：找不到父对话', {
        task: child.id,
        parent: child.parentTaskId,
      })
      const note: TaskMessage = {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: t(
          '这条汇报没能交给父对话：它已经不在了（可能被删了）。结果还在这个对话里，需要的话交给别的对话或自己处理。',
        ),
        tools: [],
        alert: makeAlert('error', t('找不到父对话（id {id}）', { id: child.parentTaskId }), 'delivery'),
        at: new Date().toISOString(),
      }
      const entry = s.live.get(child.id)
      const target = entry?.task ?? child
      target.messages.push(note)
      if (entry) entry.rev++
      else
        await s.store
          .update(child.id, target)
          .catch((e) => log.warn('task', '记下「汇报没交出去」失败', { task: child.id, error: (e as Error).message }))
      return { ok: false, info: '找不到父对话（它可能已经被删了），这条消息没能交回去；子对话自己的结果还在本对话里' }
    }
    // 阶段汇报不单独发（ADR 0034：一轮只交一封）：记在子对话上，这一轮结束面板上报状态时并进去当「结果」。
    // 要父对话动手的（提问、收尾建议、请它安排修复）照旧马上发
    if (!question && !FIX_HEAD.test(text)) {
      const ce = s.live.get(child.id)
      const target = ce?.task ?? child
      target.pendingReport = [target.pendingReport, text.trim()].filter(Boolean).join('\n\n').slice(-4000)
      if (ce) ce.rev++
      else await s.store.update(child.id, target).catch(() => {})
      return {
        ok: true,
        info: '已记下。这一轮结束时面板会把它和你的状态合成一封交给父对话（一轮只交一封），不用再重复发；要父对话决定或动手的事把 question 设为 true。',
      }
    }
    const suggestion = question && kind === 'suggestion'
    // 子对话自己没开「提问」：它的提问和收尾建议不往上交，由它自己选（用户 2026-10-31 定的）。
    // 记进这一轮的汇报，父对话从一轮结束那封信里看到它替自己决定了什么
    if (question && !child.askUser) {
      const ce = s.live.get(child.id)
      const target = ce?.task ?? child
      const note = `（${suggestion ? '收尾建议' : '提问'}，「提问」关着由我自己决定）${text.trim()}`
      target.pendingReport = [target.pendingReport, note].filter(Boolean).join('\n\n').slice(-4000)
      if (ce) ce.rev++
      else await s.store.update(child.id, target).catch(() => {})
      return {
        ok: true,
        info: suggestion
          ? '你的「提问」关着，收尾建议不交给别人选：这一轮可以结束，结论里写清建议和推荐做法，父对话会从这一轮的汇报里看到。'
          : `你的「提问」关着，问题不交给父对话或用户：按${options.length ? `你判断最合适的做法（没把握就选「${options[0]}」）` : '你判断最合适的做法'}直接继续，结论里写一句你替自己决定了什么、依据是什么。`,
      }
    }
    // 子对话开着「提问」、父对话的「提问」关着：子对话的提问和收尾建议不交给用户，直接交给父对话的 AI 决定。
    // 这时不产生 ask 卡片：卡片和「交给父对话决定」的折叠行都是给用户准备的，用户已经不回答问题了，
    // 留着它只会让父对话里多出一条等人点「去选择」的东西；只有 panel 为 child 的汇报记一条给 AI 看
    const auto = question && !parent.askUser
    const head = question
      ? suggestion
        ? `子对话「${child.title}」的收尾建议`
        : `子对话「${child.title}」提问`
      : `子对话「${child.title}」汇报`
    const opts = question ? askOptions(options, kind) : []
    const body = opts.length ? `${text}\n\n可选的做法：\n${opts.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : text
    // 自动交给父对话时把「谁来答」写进正文：父对话的 AI 之后从对话历史和收件箱读到的就是这句
    const why = auto ? '\n\n（「提问」关着，用户不会回答：请你按最合理的做法直接决定，别再问用户）' : ''
    // 提问卡片（ask）自己就说明了是谁问的；其余（汇报、自动交给父对话 AI 的提问）画成「接收消息」
    const peer = await s.peerOf(child, 'child', question ? 'question' : 'report', text)
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: `${head}：\n${body}${question ? `\n\n（决定后用 send_to_conversation 交给这个子对话，id: ${child.id}）` : ''}${why}`,
      tools: [],
      panel: question && !auto ? 'ask' : 'child',
      ...(!(question && !auto) && { peer }),
      ...(question && !auto
        ? {
            ask: {
              from: child.id,
              title: child.title,
              question: text,
              options: opts,
              kind: suggestion ? ('suggestion' as const) : ('question' as const),
            },
          }
        : {}),
      at: new Date().toISOString(),
    }
    // 提问、收尾建议同时挂在子对话上：子对话的输入框换成选择弹窗，用户进子对话就能直接选
    // 自动交给父对话的不挂：不产生要用户回答的弹窗，也不计入「需要你处理」
    if (question && !auto) {
      child.parentAsks = [...(child.parentAsks ?? []), { id: msg.id, question: text, options: opts, kind }]
      const ce = s.live.get(child.id)
      if (ce) ce.rev++
      else await s.store.update(child.id, child).catch(() => {})
    }
    const entry = s.live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, msg.text, msg).catch(() => false) : false
    if (!how) {
      parent.messages.push(msg)
      parent.inbox.push({ from: child.id, title: child.title, text: question ? `（提问）${body}` : text, at: msg.at })
    } else if (!parent.messages.some((x) => x.id === msg.id)) {
      // 正在跑的父对话已经从插话里收到问题：也记一条（自动交出时 panel 是 child，界面不画），它下一轮还能看到
      parent.messages.push(msg)
    }
    parent.updatedAt = msg.at
    if (entry) entry.rev++
    else await s.store.update(parent.id, parent).catch(() => {})
    // 自动交给父对话的 AI 作答：已经从插话里收到的不再叫；其余的按实时交付叫起它（答案从收件箱里看全文）。
    // 不能只看 working：父对话停在等下一句、正在收尾、预热时 working 是 false 但执行位还占着，直接开新一轮会被拒
    if (auto) {
      await s.store.update(parent.id, parent).catch(() => {})
      if (!how)
        void s
          .wakeConv(
            parent.id,
            `子对话「${child.title}」${suggestion ? '的收尾建议' : '在等你决定'}（在收件箱里，「提问」关着，用户不会回答）。按已有信息选最合理的做法，把「你替它决定了什么、依据、不对怎么改」写清楚，再用 send_to_conversation 交给它（id: ${child.id}）。`,
            { panel: 'child', peer },
          )
          .catch((e) => {
            log.warn('task', '自动交给父对话决定时没能开始新的一轮', { error: (e as Error).message })
            s.alertOn(parent.id, 'delivery', t('子对话等你决定，但没能开一轮来处理，问题在收件箱里'))(e)
          })
    }
    if (auto)
      return {
        ok: true,
        info: suggestion
          ? '「提问」关着，这条建议自动交给父对话决定（不问用户）。这一轮可以结束了，不要再把建议重复写进结论里等它。'
          : `「提问」关着、用户不会回答：这条提问已经交给父对话的 AI 决定${how ? '（它正在执行，已经实时收到）' : '（它空闲时会接着作答）'}。你按${opts.length ? `第 1 个做法「${opts[0]}」` : '最稳妥的做法'}继续往下做，不要停下来等；结论里写一句「提问已按默认处理：${opts.length ? opts[0] : '按最稳妥的做法继续'}」。`,
      }
    if (how) return { ok: true, info: '已实时交给父对话' }
    return {
      ok: true,
      info: question
        ? suggestion
          ? '父对话现在没在执行，这条收尾建议已经记在父对话里，用户会在面板上直接选。选完会自动交回给你；这一轮可以结束了，不要再把建议重复写进结论里等它。'
          : '父对话现在没在执行，问题已经记在父对话里，用户或父对话下一轮会回答。不要停下来等：先按最稳妥的做法继续，或者结束这一轮并写清需要决定的事。'
        : '已记在父对话里，它下一轮会看到',
    }
  }

  /** 转交给父对话创建的一条子任务：记下是哪个子对话请求的，父对话那一侧要能看到来源 */
  /** 排着的转交请求，按父对话 id 分组：父对话下一轮建 Orchestra 时直接派（见 attachOrchestra） */
  const forwards = new Map<string, ForwardedSpawn[]>()

  /** 父对话里那条「子对话请求创建子任务」的说明：子任务卡片就挂在这条消息上，用户点开能看到是谁要的 */
  function forwardMessage(held: ForwardedSpawn): TaskMessage {
    const role = held.spec.agent?.trim() || ''
    return {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t(
        '子对话「{from}」请求创建子任务「{title}」{role}。这个角色禁止子对话执行，面板已经替你派出，结果会交回你，不用再调 spawn_agents。\n\n它的要求：\n{instructions}',
        {
          from: held.fromTitle,
          title: held.spec.title,
          role: role ? t('（角色：{role}）', { role }) : '',
          instructions: held.spec.instructions || t('（没有写具体要求）'),
        },
      ),
      tools: [],
      panel: 'child',
      at: new Date().toISOString(),
    }
  }

  /**
   * 子对话点名一个「禁止子对话执行」（runIn: 'parent'）的角色：不在子对话里跑，
   * 转交父对话创建这个子任务（见 ADR 0019）。
   * 同步返回，排进父对话的队列就算交出去了：子对话立即标完计划步骤、继续往下做，不被它卡住。
   */
  function forwardSpawn(child: Task, spec: HelperSpec): { ok: boolean; info: string; id?: string } {
    const parentId = child.parentTaskId
    if (!parentId)
      return {
        ok: false,
        info: '这个对话没有父对话：这个角色禁止子对话执行，只能由父对话派它。这一件请自己做，或在结果里说明没做成',
      }
    const parent = s.live.get(parentId)?.task ?? s.store.known(parentId)
    if (!parent || parent.archived) return { ok: false, info: '找不到可用的父对话，这个子任务没法转交' }
    // 父对话自己也是被派出来的子对话：它同样不能执行这个角色，再往上转会一直套下去
    if (parent.parentTaskId)
      return {
        ok: false,
        info: `父对话「${parent.title}」自己也是被派出来的子对话，不能执行「${spec.agent ?? '这个角色'}」。这一件自己做，或者交给用户决定`,
      }
    const held: ForwardedSpawn = { from: child.id, fromTitle: child.title, spec, at: new Date().toISOString() }
    const entry = s.live.get(parentId)
    // 父对话的 AI 正在处理这一轮（orch 只在 runAgent 期间挂着，working 是双保险）：
    // 直接派进去，子任务进这一轮的 st.helpers，gate 会等它、结果能交回。
    // 其它阶段（等下一句、等子任务结果、跑计划）走排队 + 唤醒，由下一轮开始调 AI 时派
    if (entry?.orch && entry.task.working) {
      entry.task.messages.push(forwardMessage(held))
      const r = entry.orch.spawn([spec], undefined, { local: true })
      if (r.error) {
        // 说明已经写成了「已经替你派出」：效果不符时补一条，不让它静默消失
        entry.task.messages.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: t('上面那条没能派出：{error}。这件子任务需要另外安排', { error: r.error }),
          tools: [],
          panel: 'note',
          at: new Date().toISOString(),
        })
        entry.rev++
        return { ok: false, info: r.error }
      }
      entry.rev++
      return { ok: true, id: r.ids[0], info: `已在父对话「${parent.title}」里创建这个子任务` }
    }
    // 没在跑：先排着，再叫起一轮——它的 Orchestra 一建立就由 attachOrchestra 派，不等 AI 自己想起来调 spawn_agents。
    const queued = forwards.get(parentId) ?? []
    queued.push(held)
    forwards.set(parentId, queued)
    // 唤醒只发一句短提示：请求正文由 attachOrchestra 写成正式记录，两处都发全文会让父对话里出现两条一模一样的请求
    void s
      .wakeConv(
        parentId,
        t(
          '子对话「{from}」把一件子任务交给你创建，面板已经安排派出，具体要求已经交给那个子任务，你不用再派；结果会交回你。',
          {
            from: held.fromTitle,
          },
        ),
        { panel: 'child' },
      )
      .catch((e) => {
        log.warn('task', '转交的子任务没能交给父对话', { error: (e as Error).message })
        s.alertOn(parentId, 'delivery', t('子对话转交来的子任务没能交给父对话，它下一轮会再派'))(e)
      })
    return { ok: true, info: `已转交父对话「${parent.title}」：它下一轮开始时创建这个子任务` }
  }

  /**
   * 引擎每次开始调对话 AI / 调完时回调（见 shared/engine.ts 的 onOrchestra）：
   * 开始调的时候把排着的转交请求直接派出去，调完（undefined）清掉引用——只有「AI 正在处理这一轮」时才接活。
   * 见 ADR 0019。
   */
  function attachOrchestra(taskId: string, orch: Orchestra | undefined) {
    const entry = s.live.get(taskId)
    if (entry) entry.orch = orch
    if (!orch || !entry) return
    const queued = forwards.get(taskId)
    if (!queued?.length) return
    forwards.delete(taskId)
    for (const held of queued) {
      entry.task.messages.push(forwardMessage(held))
      const r = orch.spawn([held.spec], undefined, { local: true })
      if (r.error)
        entry.task.messages.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: t('上面那条没能派出：{error}。这件子任务需要另外安排', { error: r.error }),
          tools: [],
          panel: 'note',
          at: new Date().toISOString(),
        })
    }
    entry.rev++
  }

  return { attachOrchestra, forwardSpawn, messageParent }
}
