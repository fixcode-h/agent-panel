import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import {
  diagnosisWaiting,
  droppedAsksNote,
  rewaitDiagnosis,
  settleStopped,
  stateBreaks,
  type StateBreak,
  type StateLive,
} from '../../shared/tasks/settle.ts'
import { taskGone } from '../../shared/task.ts'
import { parentFixWait } from '../../shared/wake.ts'
import { log } from '../log.ts'
import type { createTaskStore } from './store.ts'
import { reopenMerge } from './startup.ts'

type Store = Pick<ReturnType<typeof createTaskStore>, 'list' | 'get' | 'update'>

/** 定时核对的间隔：连着两次看到同一个矛盾、中间任务没被写过才收口，所以最慢两个间隔后收掉 */
export const STATE_SWEEP_MS = Number(process.env.AGENT_PANEL_STATE_SWEEP_MS) || 60_000

/**
 * 定时核对对话状态（见 ADR 0033）：记录说在做、面板里却没人在做的，按 settleStopped 收口并在对话里说一句。
 *
 * 每条收口路径（结束一轮、回收、关闭、退出）都该自己落好状态；这里是兜底：哪条路径漏了，
 * 用户看到的是一直转圈、没有「继续执行」入口，现在最多两个间隔后变成「已中断」并写明原因。
 *
 * 为什么要连着两次：结束一轮时先放执行位、后落盘，中间有几毫秒记录还写着 running；
 * 合并结束时也是先清内存标记、再改记录。两次之间任务被写过（updatedAt 变了）就重新计，不会误收正在收尾的。
 */
export function createStateSweep(d: {
  store: Store
  /** 现场：live / 启动队列 / 后台命令 / 合并中，都在 tasksApi 的闭包里 */
  live(id: string): StateLive
  /** 收口后通知（日志之外，比如推一次列表刷新）；可选 */
  settled?(id: string, kind: StateBreak): void
  /**
   * 孤儿子对话落成「已中断」后交给父对话（计划里等它的那一步收口、父对话空闲时叫醒）。
   * 必填：以前只留了可选的 settled 又没接，父对话一直停在「等子对话」
   */
  reportChild(task: Task): void | Promise<void>
  /**
   * 子对话还挂着「等父对话安排修复」、父对话却空闲：提醒父对话一次（叫醒前过 holdWake，被挡住返回 false，之后再试）。
   * 修复请求交出时的叫醒是发出去就不管的：面板重启时丢掉、父对话被叫醒那一轮没回它，父子就互等到用户介入（复核 C1-c）
   */
  remindParent(child: Task): Promise<boolean>
}) {
  /** 上一次看到的矛盾：id → 「矛盾种类 + updatedAt」 */
  const seen = new Map<string, string>()
  /** 上一次看到的「子对话等父对话、父对话空闲」：子对话 id → 那条等待的键 */
  const waitSeen = new Map<string, string>()
  /** 已经提醒过的等待（子对话 id + 开始等的时间）：同一条等待只提醒一次，再不回就留给用户 */
  const reminded = new Set<string>()

  async function settleOrphan(id: string) {
    const tk = await d.store.get(id)
    // 读到的完整记录再核一遍：两次扫描之间它可能刚被拉起来
    if (!tk || !stateBreaks(tk, d.live(id)).includes('orphan')) return false
    // 诊断报告等确认（ADR 0045）：没人在执行是对的，它在等用户；回到等确认，不说「已中断」
    if (diagnosisWaiting(tk)) {
      await d.store.update(id, rewaitDiagnosis(tk), { keepUpdatedAt: true })
      return true
    }
    const next: Task = settleStopped(tk, 'lost')
    next.messages = [
      ...tk.messages,
      {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: [
          t('面板核对时发现这一轮已经没有在执行（记录还写着执行中），已落成「已中断」。发消息或点「继续执行」接着做。'),
          // 提问 / 确认被 settleStopped 清掉了：卡片没了要说为什么
          droppedAsksNote(tk),
        ]
          .filter(Boolean)
          .join('\n'),
        tools: [],
        at: new Date().toISOString(),
      },
    ]
    await d.store.update(id, next, { keepUpdatedAt: true })
    // 上报失败不影响这次收口（子对话已经落盘了），只记日志；用 try/await 连同步抛错一起接住
    if (next.parentTaskId)
      try {
        await d.reportChild(next)
      } catch (err) {
        log.warn('task', '定时核对：已中断的子对话没能上报父对话', { task: id, error: (err as Error).message })
      }
    return true
  }

  /** 核对一次，返回这次收口了哪些（测试和日志用） */
  async function sweep(): Promise<{ id: string; kind: StateBreak }[]> {
    const done: { id: string; kind: StateBreak }[] = []
    const all = await d.store.list()
    const now = new Set<string>()
    for (const meta of all) {
      const breaks = stateBreaks(meta, d.live(meta.id))
      if (!breaks.length) continue
      now.add(meta.id)
      const key = `${breaks.join(',')}@${meta.updatedAt}`
      if (seen.get(meta.id) !== key) {
        seen.set(meta.id, key)
        continue
      }
      seen.delete(meta.id)
      for (const kind of breaks) {
        try {
          const ok =
            kind === 'orphan'
              ? await settleOrphan(meta.id)
              : await reopenMerge(d.store, meta.id, '收尾停在「合并中」，面板却没有在合并它')
          if (!ok) continue
          done.push({ id: meta.id, kind })
          log.warn('task', '定时核对：记录和实际对不上，已收口', {
            task: meta.id,
            kind,
            status: meta.status,
            working: meta.working,
            updatedAt: meta.updatedAt,
          })
          d.settled?.(meta.id, kind)
        } catch (e) {
          log.warn('task', '定时核对收口失败', { task: meta.id, kind, error: (e as Error).message })
        }
      }
    }
    // 矛盾已经消失的不再记着：下次再出现要重新连看两次
    for (const id of seen.keys()) if (!now.has(id)) seen.delete(id)
    await remindIdleParents(all)
    return done
  }

  /**
   * 子对话挂着 kind parent 的等待（父对话还没回它）、父对话不在执行位上：连着两次看到才提醒，
   * 中间父对话可能刚被叫醒、还没占上执行位，或者正在两轮之间
   */
  async function remindIdleParents(all: Task[]) {
    const waiting = new Set<string>()
    for (const kid of all) {
      if (!kid.parentTaskId || taskGone(kid) || kid.resolved) continue
      const w = parentFixWait(kid)
      if (!w) continue
      const key = `${kid.id}@${w.at ?? ''}`
      const parent = d.live(kid.parentTaskId)
      if (reminded.has(key) || parent.live || parent.queued) continue
      waiting.add(kid.id)
      if (waitSeen.get(kid.id) !== key) {
        waitSeen.set(kid.id, key)
        continue
      }
      waitSeen.delete(kid.id)
      try {
        if (await d.remindParent(kid)) {
          reminded.add(key)
          log.info('task', '定时核对：子对话在等父对话安排修复、父对话空闲，已提醒父对话', {
            task: kid.id,
            parent: kid.parentTaskId,
          })
        }
      } catch (e) {
        // 提醒失败由 remindParent 自己在父对话里报警告；这里只记日志，下次核对再试
        log.warn('task', '定时核对：提醒父对话安排修复失败', { task: kid.id, error: (e as Error).message })
      }
    }
    for (const id of waitSeen.keys()) if (!waiting.has(id)) waitSeen.delete(id)
  }

  return { sweep }
}
