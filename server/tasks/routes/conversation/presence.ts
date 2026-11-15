import { z } from 'zod'
import { PresenceInput, type TaskSeenResult } from '../../../../shared/schema.ts'
import { rescheduleIfUnwatched, setViewer } from '../../../presence.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'

/** 对话页的心跳（还开着）和已读（侧栏橙点消失） */
export function registerPresenceRoutes(s: TasksScope) {
  // 对话页还开着：CLI 回复完才能停在等下一句的工具上；切走一分钟内切回来还能接着发
  s.routes.post('/:id/presence', async (c) => {
    const id = c.req.param('id')
    const p = PresenceInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    // 只判在不在（下面只动内存里的 viewer）：用 current() 会为一次心跳把几 MB 的对话读一遍再校验
    if (!(await s.getMeta(id))) return s.bad(c, t('任务不存在'), 404)
    setViewer(id, p.data.viewerId, p.data.active)
    return c.body(null, 204)
  })

  // 用户打开了这个对话：侧栏的橙点消失，CLI 也可以按宽限期回收了
  s.routes.post('/:id/seen', async (c) => {
    const id = c.req.param('id')
    const entry = s.live.get(id)
    // 只要「这一轮看到哪」，不读整份对话：以前这里读 2MB、再把 2.4MB 的完整任务回给前端，
    // 前端拿它只做一件事——把本地那份的 turnSeenAt 换成新的
    const tk = entry?.task ?? (await s.getMeta(id))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.turnDoneAt && tk.turnSeenAt !== tk.turnDoneAt) {
      const turnSeenAt = tk.turnDoneAt
      // 只是记「看过了」，不算任务有更新：列表顺序和更新时间都不动
      if (entry) {
        entry.task.turnSeenAt = turnSeenAt
        entry.rev++
      } else await s.store.updateMeta(id, { turnSeenAt }, { keepUpdatedAt: true })
      // 看过之后不再因为未读一直留着 CLI：如果已经没人在看，现在就开始算宽限期
      rescheduleIfUnwatched(id)
      return c.json({ turnSeenAt } satisfies TaskSeenResult)
    }
    return c.json({ turnSeenAt: tk.turnSeenAt } satisfies TaskSeenResult)
  })
}
