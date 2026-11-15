import { setChild } from '../../../shared/children/task-child.ts'
import { childSelfDrives, childReport, type ConvState } from '../../../shared/task.ts'
import type { Task } from '../../../shared/schema.ts'
import { diagnosisInFlow } from '../../../shared/bug/phase.ts'
import { childStatusLetter, fullSummaryAt, reportNextText } from '../../../shared/prompt/letters/child-report.ts'
import { saveToHandoff } from '../inbox-file.ts'
import { planProgressKey } from '../../../shared/drive.ts'
import { MERGE_STALL_REPORTS, nextMergeStall, type MergeStall } from '../../../shared/merge-stall.ts'
import { hasHeld } from '../../exec/delivery.ts'
import { log } from '../../log.ts'
import { inLang } from '../../../shared/i18n.ts'
import { activePlan, holdWait, planProgress, openWork } from '../../../shared/plan/index.ts'
import { isolated } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'
import { letterResult } from '../../../shared/children/letter.ts'
import { childSummaryCards } from '../../../shared/summary/card.ts'
import { readTask } from '../read.ts'
import type { ChildrenCtx } from './context.ts'
import { childCountsOf } from './count.ts'

/** 子对话的状态上报给父对话（ADR 0005）：去重的键、那封【子对话状态】信、父计划里等它那一步的说明 */

/**
 * 上报去重的键：同一个结论只报一次。「未完成」按计划进度算（每轮结束都报的话，一个子对话来回跑几轮
 * 父对话就收到一串「未完成」，用户报过 20 分钟 13 条）；其余按这一轮算（每次失败、中断都要知道）
 */
export const reportKey = (tk: Task, state: ConvState) => {
  if (state === 'wrapup') return `wrapup|${tk.child?.wrapRequest?.at ?? ''}`
  if (state === 'unfinished') {
    const plan = activePlan(tk)
    return `unfinished|${plan ? planProgressKey(plan) : ''}|${openWork(tk).length}`
  }
  return `${state}|${tk.turnDoneAt}`
}

/**
 * 子对话的状态交给父对话：每轮结束、请求收尾、合并、置完成都走这一个出口（ADR 0005）。
 * 状态只从 childReport（convState）来：父对话收到的说法、父计划里等它那一步的收口、子对话栏是同一个结论。
 * - 还在动（执行中、等结果、等用户回答）：只把父计划那一步的说明改成现在的状态，不刷消息
 * - 未完成、待收尾：那一步继续等，发一条状态（同一状态同一轮只发一次）
 * - 已完成：那一步标完成；失败、中断：那一步退回进行中，都发一条状态
 */
export async function reportChild(ctx: ChildrenCtx, childId: string) {
  const { sc, mergeStalls, reportedState } = ctx
  // 面板正在退出：每个对话都在被停下，这时报「已中断」会在父对话里刷一串、还可能把父对话叫起来；
  // 重启后由恢复流程统一接着做（见 restartUnfinished / 父对话继续时连带恢复子对话）
  if (sc.shuttingDown) return
  // 卡住了、面板正在重启它或找人接手：结论出来前不报中断 / 失败（恢复了照常报，换人接手由那边写信）
  if (sc.childRecovering(childId)) return
  const tk = await readTask(sc, childId)
  if (!tk?.parentTaskId) return
  // 它完成、失败、没了都可能影响排在它后面的子对话（shared/children/after.ts）：顺带扫一遍
  void sc
    .releaseAfter(tk.parentTaskId)
    .catch((e) => log.warn('task', '检查排在后面的子对话失败', { task: tk.id, error: (e as Error).message }))
  // 父对话正在合并：合并结果出来时再报，这时报「待收尾」「未完成」会让父对话误判
  if (sc.merging.has(childId)) return
  const jobs = sc.background
    .list(childId)
    .filter((j) => j.state === 'queued' || j.state === 'running')
    .map((j) => j.name)
  // 这一轮结束后还要接着做：排队的要求、面板交过来的消息、刚开好独立分支马上在分支目录里接着做的
  const more = sc.startQueue.has(childId) || hasHeld(childId)
  const project = isolated(tk) ? await sc.deps.projects.get(tk.projectId) : null
  const facts = {
    background: jobs,
    more,
    unmerged: await sc.childUnmerged(tk, project ?? null),
    // 它下面的孙对话在等用户：报「等你处理」并说清是它的子对话，父对话不会当成它卡住了去催
    childNeeds: (await childCountsOf(ctx, tk.id)).needs,
  }
  const r = childReport(tk, facts)
  // 给父对话 AI 的那封信固定用中文（提示词不翻译）：界面切成英文时 r.why 是英文，混进去就成了半中半英（复查报告 A3）。
  // 界面上的状态和原因按结构存在消息的 child 上，由页面按当时的语言画，不再从信的正文里解析
  const agentWhy = inLang('zh', () => childReport(tk, facts).why)
  if (r.settle === 'hold') {
    await holdChildWait(sc, tk, r.why).catch((e) =>
      log.warn('task', '更新父对话计划的等待说明失败', { task: tk.id, error: (e as Error).message }),
    )
    if (!r.notify) return
    // 计划没做完就收尾：子对话自己按计划接着做（自驱，nudgePlan），不发消息打扰父对话——父对话收到也只能再催一遍。
    // 同一进度推满了还停在原地，才告诉父对话一次（ADR 0041）
    // 面板会推它的才不报（childSelfDrives）：挂着等待却没东西在跑时不报，它写给父对话的汇报就交不出去
    if (r.state === 'unfinished' && openWork(tk).length && !sc.stuckAfterNudge(tk) && childSelfDrives(tk)) return
  }
  // 面板重启时被停下的：不是出错，重启后由恢复流程接着做，不往父对话里报「已中断」
  if (r.state === 'stopped' && tk.stopReason === 'restart') return
  // 已经换新的子对话接手：换人那封信说过了，不再报「已中断」
  if (r.state === 'stopped' && tk.stopReason === 'replaced') return
  // 还没开始、在等前置子对话合回：父对话派它时就知道，不报「已中断」
  if (r.state === 'stopped' && tk.stopReason === 'after') return
  // 只剩合回却没请收尾：每停一次都要让父对话知道（带第几次），不能按「状态没变」吞掉，见 nextMergeStall
  const mergeOnly = r.state === 'unfinished' && !openWork(tk).length
  let stall: MergeStall | undefined
  if (mergeOnly) {
    const plan = activePlan(tk)
    stall = nextMergeStall(
      mergeStalls.get(childId),
      plan ? `${plan.id}:${planProgress(tk, plan).done}` : '',
      tk.turnDoneAt ?? '',
    )
    mergeStalls.set(childId, stall)
    // 报满了：父对话已经被告知最后一次、按那封信去问用户了，不再叫起它来回催
    if (stall.n > MERGE_STALL_REPORTS) return
  } else mergeStalls.delete(childId)
  const key = reportKey(tk, r.state) + (stall ? `|${stall.n}` : '')
  if (reportedState.get(childId) === key) return
  reportedState.set(childId, key)
  // 先取最新的回复：task.summary 要等整次执行收尾才更新，这一轮刚报完成（进程还在、或保活等下一句）时
  // 它还是上一轮的，上报会带着上一轮的结果
  // 这一轮 AI 自己用 message_parent 写的汇报并进这一封当「结果」（ADR 0034：一轮只交一封），没写才取最后一条回复
  // 只带要点（shared/children/letter.ts）：最后一条回复取全文从里面认总结，lastReply 只有开头 300 字、认不出末尾的总结
  const last = [...tk.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())?.text
  const reply = tk.child?.pendingReport?.trim() || last || tk.summary || ''
  // 结果优先用子对话写进它自己计划的总结（ADR 0041：总结写在各自的计划里，是它明确交的，不靠从回复里认）；
  // 计划还没收尾、没写总结时才退回最后的回复
  const plan = tk.plans?.at(-1)
  const src = (plan?.doneAt && plan.summary.trim()) || reply
  const brief = letterResult(src)
  const summary = brief.text
  // 父对话里由面板自动显示的卡片（父对话不再自己写）：标题取子对话这一轮总结的「类型｜结论」，
  // 点标题跳到子对话里的详细总结；没写总结时为空。卡片只做展示，从回复里画
  const cards = childSummaryCards(reply, tk.id)
  // 只剩合回却没请收尾：父对话不能直接 finish_child（要等它请求），点明下一步，免得父对话收到了也不知道该做什么
  // 停了几次：面板自己提醒过一次 submit_merge 的也算上，父对话据此判断要不要换个说法或去问用户
  const stops = stall ? stall.n + (sc.mergeNudged.has(tk.id) ? 1 : 0) : 0
  // 面板提醒不限次数（2026-11-05）：停在这里是它说了卡住、或者连着几次提醒都没动手（空转保护）
  const stuck = sc.stuckAfterNudge(tk)
  const next = reportNextText(
    mergeOnly
      ? {
          kind: 'merge-only',
          stops,
          nudged: sc.mergeNudged.has(tk.id),
          isolated: isolated(tk),
          last: stall!.n >= MERGE_STALL_REPORTS,
        }
      : r.state === 'unfinished' && diagnosisInFlow(tk)
        ? { kind: 'diagnosis', id: tk.id, stuck }
        : r.state === 'unfinished'
          ? { kind: 'unfinished', id: tk.id, stuck }
          : r.state === 'stopped' && tk.stopReason === 'user'
            ? { kind: 'user-stopped' }
            : r.state === 'failed' || r.state === 'stopped'
              ? { kind: 'retry', id: tk.id }
              : null,
  )
  // 用户直接在子对话里交代过新要求：不再单独发消息，这封汇报里带上原话
  const text = childStatusLetter({
    title: tk.title,
    id: tk.id,
    why: agentWhy,
    next,
    userDirect: tk.child?.userDirect,
    summary,
    fullAt: summary && brief.cut ? fullAt(tk.parentTaskId, tk.title, src) : undefined,
  })
  await sc.noteParent(
    tk.parentTaskId,
    tk,
    text,
    text,
    r.settle === 'hold' ? undefined : { kind: 'child', ref: tk.id, ok: r.settle === 'ok' },
    { id: tk.id, title: tk.title, state: r.state, reason: r.reason, result: summary },
    await sc.peerOf(tk, 'child', 'report', r.why, r.state === 'failed'),
    undefined,
    // 只有「只剩合回却没请收尾」要叫起父对话；失败、中断的重试提示照旧放进收件箱
    !!next && r.state === 'unfinished',
    cards,
  )
  // 并进去的阶段汇报、用户的原话已经交出去了，下一封不再重复带。
  // 随父对话（或用量上限）停下的那次 noteParent 只改计划、不发（见 noteParent 的 cascaded），留到继续后的那一封
  const sent = !(r.state === 'stopped' && (tk.stopReason === 'parent' || tk.stopReason === 'budget'))
  if (sent && (tk.child?.pendingReport || tk.child?.userDirect)) {
    const ce = sc.live.get(tk.id)
    const cur = ce?.task ?? tk
    setChild(cur, { pendingReport: undefined })
    setChild(cur, { userDirect: undefined })
    if (ce) ce.rev++
    else
      await sc.store
        .update(tk.id, cur)
        .catch((e) => log.error('task', '清掉已交出的阶段汇报时写盘失败', { task: tk.id, error: (e as Error).message }))
  }
}

/** 摘要截掉的全文存进父对话的交接目录，告诉它去哪读（ADR 0041 第 14 节）；存不了就说在子对话里 */
const fullAt = (parentId: string, title: string, src: string) => {
  try {
    return fullSummaryAt(title, saveToHandoff(parentId, `子对话「${title}」的总结`, src))
  } catch {
    return fullSummaryAt(title, null)
  }
}

/** 子对话还没交付完：父对话计划里等它的那一步继续等，note 写清它现在的状态 */
async function holdChildWait(sc: TasksScope, child: Task, why: string) {
  if (!child.parentTaskId) return
  const entry = sc.live.get(child.parentTaskId)
  const parent = entry?.task ?? (await sc.store.get(child.parentTaskId))
  if (!parent) return
  if (!holdWait(parent, 'child', child.id, why).length) return
  parent.updatedAt = new Date().toISOString()
  if (entry) entry.rev++
  await sc.store
    .update(parent.id, parent)
    .catch((e) => log.warn('task', '更新父对话计划的等待说明失败', { task: parent.id, error: (e as Error).message }))
}
