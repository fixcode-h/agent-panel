import { collabEvents } from '../../shared/collab-timeline.ts'
import { t } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import { taskDeleted } from '../../shared/task.ts'
import type { TasksScope } from './scope.ts'

/**
 * 父子协作时间线（见 shared/collab-timeline.ts）：打开父对话或子对话都按父对话那一组算。
 * 只在会话栏的「协作」那块展开时取，要读名下每个子对话的完整对话，不进轮询
 */
export function registerCollabRoutes(s: TasksScope) {
  s.routes.get('/:id/collab', async (c) => {
    const tk = await s.current(c.req.param('id'))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const root = tk.parentTaskId ? ((await s.current(tk.parentTaskId)) ?? tk) : tk
    const ids = (await s.store.list()).filter((x) => x.parentTaskId === root.id && !taskDeleted(x)).map((x) => x.id)
    const kids = (await Promise.all(ids.map((id) => s.current(id)))).filter((x): x is Task => !!x)
    return c.json({ rootId: root.id, events: collabEvents(root, kids) })
  })
}
