import { Hono, type Context } from 'hono'
import type { Task } from '../shared/schema.ts'
import { runTree, runUsage } from '../shared/run-usage.ts'
import { t } from '../shared/i18n.ts'

/**
 * 「整个运行」的用量接口：一个父对话 + 它分出的所有子对话（含多层）+ 它派出的子任务。
 *
 * 为什么要在服务端算：任务列表接口不返回子对话（`parentTaskId` 的都被过滤掉），
 * 摘要里也只有一层子对话，前端拿不到多层的用量。执行中的任务（含子对话）用内存里那一份，
 * 速度才是实时的。
 *
 * 单独成一个接口文件：`server/tasks.ts` 那边的路由已经很大，聚合规则在 `shared/run-usage.ts`，
 * 这里只负责取数。
 */
export function runUsageApi(deps: {
  /** 按 id 取任务（执行中的取内存里那一份） */
  tasks: {
    get(id: string): Promise<Task | null>
    list(): Promise<Task[]>
  }
}) {
  const routes = new Hono()
  const bad = (c: Context, error: string) => c.json({ error }, 400)

  routes.get('/:id/run-usage', async (c) => {
    const id = c.req.param('id')
    const root = await deps.tasks.get(id)
    if (!root) return bad(c, t('任务不存在'))
    try {
      // 先按全部任务找出整棵树，再逐个取（执行中的那份带实时速度）
      const tree = runTree(root, await deps.tasks.list())
      const loaded = await Promise.all(tree.map((x) => (x.id === id ? root : deps.tasks.get(x.id))))
      const tasks = loaded.filter((x): x is Task => !!x)
      return c.json(runUsage(root, tasks))
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  return { routes }
}
