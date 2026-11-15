import { diagnosisPending, trackWait } from '../../../../shared/task.ts'
import { settleStopped } from '../../../../shared/tasks/settle.ts'
import { subtreeTaskIds } from '../../../../shared/run/usage.ts'
import { dropRequests } from '../../../exec/requests.ts'
import { cancelWait, forgetNotes } from '../../../exec/steering.ts'
import { taskLog } from '../../log.ts'
import { cancelUserActions } from '../../user-actions.ts'
import { log } from '../../../log.ts'
import { settleBefore } from '../../helpers.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { currentTask } from '../../read.ts'

/**
 * 诊断报告等确认的对话（ADR 0045）这一轮多半已经说完、CLI 不在跑，停止整棵树碰不到它，状态还是「完成」，
 * 报告又让它一直算在运行（convState 的 diagnosis）：停止按钮一直在、点了没有变化（用户报过）。
 * 用户停止时把这棵树里报告还在等确认的对话落成已停止：报告留着，之后照样能确认，确认后发的消息会接着拉起它。
 * 子对话也记成 user：没有用户的确认它接着跑也只能再等，父对话继续时不用把它白拉起来一轮
 */
async function parkDiagnoses(s: TasksScope, id: string) {
  const all = await s.store.list()
  for (const tid of subtreeTaskIds(all, id)) {
    const first = s.live.get(tid)?.task ?? all.find((x) => x.id === tid)
    if (!first || !diagnosisPending(first)) continue
    // 还在收尾的先等它收完，不和引擎抢着写盘
    await settleBefore(s.live.get(tid))
    const e = s.live.get(tid)
    const tk = e?.task ?? (await s.store.get(tid))
    if (!tk || tk.working || tk.status === 'stopped') continue
    Object.assign(tk, settleStopped(tk, 'user'), { updatedAt: new Date().toISOString() })
    if (e) e.rev++
    taskLog(tid, '停止：诊断报告还在等确认，落成已停止')
    await s.store.update(tid, tk)
  }
}

/** 用户停止这个对话：停止按钮、提问窗口的关闭都走这里 */
async function userStop(s: TasksScope, id: string) {
  // 停止就是这棵对话树都别干了：自下而上先停子对话（连同它们的子任务、工作流），最后停这个对话，
  // CLI 进程直接结束，不等各自收尾。进程没了就算停下了（见 keepalive.ts 的 watchStop），点一次停止就够。
  // 这个对话自己记成 user（用户点「暂停」是唯一标成 user 的路径），名下的记成 parent
  await s
    .stopTree(id, 'user')
    .catch((e) => log.warn('task', '停止整棵对话树失败', { task: id, error: (e as Error).message }))
  // 还在等回答的提问、确认马上作废并落盘：不然返回的任务还带着它们，提问窗口关不掉。
  // 停止是停掉这个对话附属的一切：名下子对话的提问、确认、请用户决定的选择也一起作废
  const kids = await s.store.childrenOf(id)
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

/** 停止：停止按钮，以及子对话请用户决定的提问被关掉（不回答、终止子对话） */
export function registerStopRoutes(s: TasksScope) {
  s.routes.post('/:id/stop', async (c) => {
    const id = c.req.param('id')
    taskLog(id, '用户停止', { force: c.req.query('force') ? true : undefined })
    await userStop(s, id)
    // 等这个对话停稳再回：返回的就是停下后的状态，按钮马上从「停止」变回来，不用等下一次推送（用户报过）。
    // 进程已经结束，一般几十毫秒；收不完的最迟由 watchStop 收口（settleBefore 有上限）
    await settleBefore(s.live.get(id))
    await parkDiagnoses(s, id)
    await cancelUserActions(s, id)
    // 强制停止：连 CLI 进程一起结束。平时停止只收这一轮，等下一句的进程留着（下一句直接交给它）；
    // 进程不该再留着时（卡住、换机器前的清理）用这个
    if (c.req.query('force')) {
      cancelWait(id)
      forgetNotes(id)
    }
    return c.json(await currentTask(s, id))
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
    await userStop(s, id)
    cancelWait(id)
    forgetNotes(id)
    return c.json(await currentTask(s, id))
  })
}
