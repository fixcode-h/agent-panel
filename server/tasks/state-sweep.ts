import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import { settleStopped, stateBreaks, type StateBreak, type StateLive } from '../../shared/task-settle.ts'
import { log } from '../log.ts'
import type { createTaskStore } from '../task-store.ts'
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
}) {
  /** 上一次看到的矛盾：id → 「矛盾种类 + updatedAt」 */
  const seen = new Map<string, string>()

  async function settleOrphan(id: string) {
    const tk = await d.store.get(id)
    // 读到的完整记录再核一遍：两次扫描之间它可能刚被拉起来
    if (!tk || !stateBreaks(tk, d.live(id)).includes('orphan')) return false
    const next: Task = settleStopped(tk, 'lost')
    next.messages = [
      ...tk.messages,
      {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: t(
          '面板核对时发现这一轮已经没有在执行（记录还写着执行中），已落成「已中断」。发消息或点「继续执行」接着做。',
        ),
        tools: [],
        at: new Date().toISOString(),
      },
    ]
    await d.store.update(id, next, { keepUpdatedAt: true })
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
    return done
  }

  return { sweep }
}
