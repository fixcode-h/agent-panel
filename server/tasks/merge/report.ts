import { goneModulesNote } from '../../module-map.ts'
import { childReport } from '../../../shared/task.ts'
import { hasHeld } from '../../exec/delivery.ts'
import { log } from '../../log.ts'
import { t } from '../../../shared/i18n.ts'
import { refreshChildWait, syncKids, type PlanKid } from '../../../shared/plan/index.ts'
import { type Task } from '../../../shared/schema.ts'
import { isolated } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'
import { freshTask, readTask } from '../read.ts'
import type { FinishResult, MergeCtx } from './context.ts'
import { finishChildStep } from './integrate.ts'

/** finish_child 最多等多久再回话：CLI 的工具调用一分钟超时，要在那之前回（见 finishChild） */
const FINISH_WAIT_MS = 45_000

/**
 * finish_child 的唯一入口：每次收尾（合进去、没合进去、早就完成了、还不能收）结束后都强制刷新一次父对话的计划，
 * 并把刷新后的计划附在工具结果里。用户 2026-10-24 定的硬要求：「每次子对话请求收尾，父对话收尾完成都需要刷新一下计划列表」。
 * 以前只有独立分支合进去的那条路改父计划、而且一合进去就把那一步标完成（子对话还没收口也算），
 * 共用目录的子对话收尾完父计划一直挂着等待，父对话的 Agent 也看不到计划变成什么样
 */
export async function finishChild(ctx: MergeCtx, parent: Task, childId: string): Promise<FinishResult> {
  const { sc } = ctx
  const work = (async () => {
    const r = await finishChildStep(ctx, parent, childId)
    const plan = await syncParentPlan(sc, parent.id, childId).catch((e) => {
      log.warn('task', '收尾后刷新父对话计划失败', { task: parent.id, error: (e as Error).message })
      sc.alertOn(parent.id, 'panel', t('收尾子对话后刷新计划失败'))(e)
      return ''
    })
    // 合回后模块的源码没了（删除、移走）：提醒父对话派「文档」清理模块文档（ADR 0048）
    const gone = r.ok
      ? await goneModulesNote(await sc.taskDir(parent), await sc.deps.agents.list()).catch(() => '')
      : ''
    return { ...r, info: [r.info, plan, gone].filter(Boolean).join('\n\n') }
  })()
  // 限时回话：收尾要等子对话的 CLI 退出、删独立分支，慢的时候会撞上 CLI 工具调用一分钟的超时，
  // 父对话只看到「The operation timed out」，不知道收尾到底成没成，又反复调用。过了时限先说清楚，收尾在后台接着做
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), FINISH_WAIT_MS)
    timer.unref?.()
  })
  try {
    const r = await Promise.race([work, late])
    if (r) return r
  } finally {
    clearTimeout(timer)
  }
  void work.catch((e) => {
    log.error('task', '收尾子对话失败', { task: childId, error: (e as Error).message })
    sc.alertOn(parent.id, 'panel', t('收尾子对话失败'), 'error')(e)
  })
  log.warn('task', '收尾子对话超过时限，转到后台接着做', { task: childId, waitMs: FINISH_WAIT_MS })
  return {
    ok: true,
    info: '收尾还在进行（在等子对话的进程退出），面板会在后台做完，不用再调用 finish_child。过一会儿用 list_conversations 看它是不是已完成。',
  }
}

/**
 * 收尾之后把父计划里等这个子对话的那一步对齐到子对话现在的状态，和 reportChild 用同一个判据（childReport）：
 * 已完成标完成，失败、中断退回进行中，其余（合进去了还在收口、没合进去退回给它了）继续等并写清在等什么。
 * 不按上报去重：每次收尾都刷新、都落盘并推给界面。返回给父对话 Agent 看的计划文字（没有计划时为空）
 */
/** 名下的子对话（计划对齐用，见 plan.ts 的 linkKids）：正在跑的用内存里的最新状态 */
export async function planKids(sc: TasksScope, parentId: string): Promise<PlanKid[]> {
  const kids = await sc.store.childrenOf(parentId)
  return kids.map((k) => {
    const cur = freshTask(sc, k)
    return {
      id: cur.id,
      title: cur.title,
      createdAt: cur.createdAt,
      done: !!cur.resolved,
      endedAt: cur.resolved ? cur.updatedAt : '',
    }
  })
}

export async function syncParentPlan(sc: TasksScope, parentId: string, childId: string): Promise<string> {
  const pEntry = sc.live.get(parentId)
  const pTask = pEntry?.task ?? (await sc.store.get(parentId))
  if (!pTask) return ''
  const tk = await readTask(sc, childId)
  let report: ReturnType<typeof childReport> | undefined
  if (tk?.parentTaskId === parentId) {
    const jobs = sc.background
      .list(childId)
      .filter((j) => j.state === 'queued' || j.state === 'running')
      .map((j) => j.name)
    const project = isolated(tk) ? await sc.deps.projects.get(tk.projectId) : null
    report = childReport(tk, {
      background: jobs,
      more: sc.startQueue.has(childId) || hasHeld(childId),
      unmerged: await sc.childUnmerged(tk, project ?? null),
    })
  }
  const text = refreshChildWait(pTask, { id: childId, title: tk?.title ?? childId }, report)
  // 顺带把计划和名下所有子对话对齐：别的步骤等的子对话早就完成了、或者 Agent 只在备注里写了「等 xxx」也一起收口
  syncKids(pTask, await planKids(sc, parentId))
  // 计划没变也写一次：rev 变了界面才会重取，保证每次收尾后看到的都是最新的计划
  pTask.updatedAt = new Date().toISOString()
  if (pEntry) pEntry.rev++
  await sc.store.update(pTask.id, pTask, { now: true })
  return text
}
