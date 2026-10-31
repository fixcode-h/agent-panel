import { stalledTurn } from '../exec/runner.ts'
import { log } from '../log.ts'
import { taskLog } from '../task-log.ts'
import { t } from '../../shared/i18n.ts'
import { taskDeleted } from '../../shared/task.ts'
import { settleStopped } from '../../shared/task-settle.ts'
import {
  CHILD_RESTART_MAX,
  agentOutputSince,
  rebindChildWait,
  restartOutcome,
  takeoverBrief,
  takeoverTitle,
} from '../../shared/stuck-child.ts'
import type { Live } from './types.ts'
import type { TasksScope } from './scope.ts'

/**
 * 卡住的子对话由面板接着处理（判定在 shared/stuck-child.ts）：
 * 自动询问后到时间还没回复 → 停掉 CLI、接回原会话重启（restartStuck）；
 * 重启后核对（checkRestarted）：有了输出就算恢复，起不来或者还是不回 → 对话里记警告、新开子对话接手（replace）。
 * 只停没有响应的子对话：能解释的等待（等用户、后台命令、子任务、工作流）在判定里就排除了（ADR 0012）。
 */
export function createStuckChild(s: TasksScope) {
  /** 面板重启过、还在等结论的子对话：id → 重启的时间。只在内存里：面板重启后对话都停了，没有要接着核对的 */
  const restarted = new Map<string, number>()
  /** 每个子对话被面板重启过几次：同一个子对话反复卡住就不再重启，直接找人接手 */
  const restarts = new Map<string, number>()
  /** 正在换人接手的子对话：停它、建新的这段时间不重复处理 */
  const replacing = new Set<string>()

  const recovering = (id: string) => restarted.has(id) || replacing.has(id)

  /** 状态询问交付时 deliver 已经因为 CLI 没响应重开过它（restartStalled）：一样要核对重开后有没有动起来 */
  function noteRestart(id: string, at: number) {
    restarts.set(id, (restarts.get(id) ?? 0) + 1)
    restarted.set(id, at)
  }

  /** 问过状态、到时间还没回复：停掉卡住的 CLI，接回原会话开新的一轮，让它说明卡在哪并接着做 */
  async function restartStuck(entry: Live, mins: number) {
    const id = entry.task.id
    const n = restarts.get(id) ?? 0
    if (n >= CHILD_RESTART_MAX) return replace(id, `面板已经重启过它 ${n} 次，又卡住了`)
    restarts.set(id, n + 1)
    const at = Date.now()
    // 先登记再停：这一轮停下时的「已中断」不报给父对话（reportChild 看 childRecovering）
    restarted.set(id, at)
    log.warn('task', '子对话问过状态后一直没有回复，停掉它接回会话重启', { task: id, minutes: mins, restarts: n + 1 })
    taskLog(id, '卡住：问过状态没回复，停掉重启', { minutes: mins })
    s.stopTask(id, 'stalled')
    if (entry.done) await entry.done.catch(() => {})
    // 停下的这段时间里已经开了新的一轮（用户发了消息、排着的消息接上了）：交给那一轮，照样核对它有没有动起来
    if (s.live.has(id)) return
    const cur = await s.store.get(id)
    const parent = cur?.parentTaskId
      ? (s.live.get(cur.parentTaskId)?.task ?? (await s.store.get(cur.parentTaskId)))
      : null
    if (!cur || !parent || taskDeleted(cur)) {
      restarted.delete(id)
      return
    }
    const text =
      `【卡住重启】你已经 ${mins} 分钟没有任何输出，状态询问也没有回复，面板判断 CLI 卡住了，已经停掉它并接回这个会话。` +
      `先用一句话说明刚才卡在哪一步，再从中断的地方接着做；已经做完的不用重做。`
    try {
      const next = await s.followUp(id, {
        text,
        attachments: [],
        panel: 'note',
        peer: await s.peerOf(parent, 'parent', 'question', '卡住重启：说明卡在哪，接着做'),
        delivery: 'restart',
      })
      // 新的一轮从头算静默：上一段的询问记录作废（清字段写 undefined，见 docs/lessons/data.md）
      const now = s.live.get(id)?.task ?? next
      now.autoAsk = undefined
      await s.store.update(id, now)
    } catch (e) {
      restarted.delete(id)
      log.warn('task', '卡住的子对话接回会话重启失败', { task: id, error: (e as Error).message })
      await replace(id, `接回原会话重启失败：${(e as Error).message}`)
    }
  }

  /** 核对重启过的子对话：动起来了就放手；没起来、起来了还是不回就换人接手 */
  async function checkRestarted() {
    for (const [id, at] of [...restarted]) {
      if (s.shuttingDown) return
      const e = s.live.get(id)
      const tk = e?.task ?? (await s.store.get(id))
      if (!tk || taskDeleted(tk) || tk.archived) {
        restarted.delete(id)
        continue
      }
      const r = restartOutcome(
        {
          output: agentOutputSince(tk, new Date(at).toISOString()),
          live: !!e,
          status: tk.status,
          stopReason: tk.stopReason,
          stalledSince: stalledTurn(id)?.since,
        },
        at,
      )
      if (r === 'wait') continue
      restarted.delete(id)
      if (r === 'failed') {
        await replace(
          id,
          e
            ? '重启后还是没有任何输出'
            : tk.status === 'failed'
              ? '接回原会话重启后这一轮失败了'
              : '接回原会话重启后没能运行起来',
        )
        continue
      }
      log.info('task', r === 'ok' ? '卡住的子对话重启后恢复了' : '卡住的子对话重启后被别的原因停下', {
        task: id,
        status: tk.status,
      })
      // 等结论期间压下的上报（这一轮已经结束了的）补上
      if (!e) await s.reportToParent(tk).catch(() => {})
    }
  }

  /**
   * 换人接手：停掉原来的子对话（记成「已由新的子对话接手」，父对话继续时不会再拉它），
   * 在原子对话和父对话里各记一条警告，按原任务和已有进展新开一个子对话，父计划里等它的步骤改成等新的，
   * 再给父对话的 Agent 一封信说明换了人
   */
  async function replace(id: string, why: string) {
    if (replacing.has(id)) return
    replacing.add(id)
    try {
      restarted.delete(id)
      const e = s.live.get(id)
      if (e) {
        s.stopTask(id, 'replaced')
        if (e.done) await e.done.catch(() => {})
      }
      let old = s.live.get(id)?.task ?? (await s.store.get(id))
      if (!old?.parentTaskId || taskDeleted(old)) return
      if (!s.live.has(id) && (old.status !== 'stopped' || old.stopReason !== 'replaced')) {
        old = settleStopped(old, 'replaced')
        await s.store.update(id, old)
      }
      const parent = s.live.get(old.parentTaskId)?.task ?? (await s.store.get(old.parentTaskId))
      if (!parent || taskDeleted(parent)) return
      const title = takeoverTitle(old.title)
      log.warn('task', '卡住的子对话重启没恢复，新开子对话接手', { task: id, parent: parent.id, why })
      taskLog(id, '卡住：重启没恢复，换人接手', { why })
      const r = await s.spawnChildOf(parent.id, { title, message: takeoverBrief(old, why), agentId: old.agentId })
      if (!r.ok || !r.id) {
        const text = t('子对话「{title}」卡住了，重启也没恢复（{why}），新开子对话接手也失败了', {
          title: old.title,
          why,
        })
        await s.panelAlert(parent.id, 'no_response', text, r.info, 'error')
        await s.panelAlert(id, 'no_response', text, r.info, 'error')
        return
      }
      await s.panelAlert(
        id,
        'no_response',
        t('这个子对话卡住了，重启也没恢复（{why}），已新开子对话「{title}」接手', { why, title }),
        why,
      )
      await s.panelAlert(
        parent.id,
        'no_response',
        t('子对话「{old}」卡住了，重启也没恢复（{why}），已新开子对话「{title}」接手', { old: old.title, why, title }),
        why,
      )
      const p = s.live.get(parent.id)
      const target = p?.task ?? parent
      if (rebindChildWait(target, id, r.id, title)) {
        target.updatedAt = new Date().toISOString()
        if (p) p.rev++
        await s.store.update(target.id, target).catch(() => {})
      }
      // 给父对话的 Agent 一封信：它不用再交回原来的子对话，等新的回报
      const body =
        `【子对话换人接手】「${old.title}」（id ${id}）卡住了：${why}。面板停掉它、接回原会话重启也没恢复，` +
        `已经新开子对话「${title}」（id ${r.id}）带上原任务和已有进展接手，计划里等它的步骤改成了等新的子对话。` +
        `不要再交回原来的子对话，等新的子对话回报。`
      await s.noteParent(
        parent.id,
        old,
        body,
        body,
        undefined,
        undefined,
        await s.peerOf(old, 'child', 'report', '卡住了，已换新的子对话接手', true),
      )
    } catch (err) {
      log.warn('task', '卡住的子对话换人接手时出错', { task: id, error: (err as Error).message })
      s.alertOn(id, 'panel', t('这个子对话卡住了，换新的子对话接手时出错'), 'error')(err)
    } finally {
      replacing.delete(id)
    }
  }

  return { checkRestarted, noteRestart, recovering, restartStuck }
}
