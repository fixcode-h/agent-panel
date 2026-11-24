import { Hono } from 'hono'
import { z } from 'zod'
import { openPath, resolvePath, searchRoots } from './paths.ts'
import { t } from '../../shared/i18n.ts'
import type { TasksScope } from './scope.ts'
import { currentTask } from './read.ts'

/** 一次最多解析这么多个：一条长回复里的路径通常十几个，再多就是传错了 */
const MAX_PATHS = 200
const Paths = z.object({ paths: z.array(z.string().min(1).max(4096)).max(MAX_PATHS) })
const OpenInput = z.object({ path: z.string().min(1).max(4096), reveal: z.boolean().default(false) })

/**
 * 对话消息里提到的文件：解析成本机的真实路径（悬停卡片、找不到时划掉），用系统默认程序打开或在文件夹中显示。
 * 找文件的规则见 server/tasks/paths.ts
 */
export function pathRoutes(s: TasksScope): Hono {
  const app = new Hono()
  /** 这个对话找文件的根；导入的任务没有本机目录，读不了时按原因报错 */
  const rootsOf = async (id: string) => {
    const dir = await s.readableDir(id)
    const tk = (await currentTask(s, id))!
    const project = tk.projectId ? await s.deps.projects.get(tk.projectId) : null
    const homes = [dir, project?.path ?? ''].filter(Boolean)
    return { homes, roots: searchRoots(dir, project?.path ?? '') }
  }
  const fail = (e: unknown) => ({ error: (e as Error).message, status: (e as { status?: 400 | 404 }).status ?? 400 })

  app.post('/:id/paths', async (c) => {
    const p = Paths.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return s.bad(c, t('路径列表不对'))
    try {
      const { roots, homes } = await rootsOf(c.req.param('id'))
      const items = await Promise.all([...new Set(p.data.paths)].map((x) => resolvePath(x, roots, homes)))
      return c.json({ items })
    } catch (e) {
      const f = fail(e)
      return s.bad(c, f.error, f.status)
    }
  })

  app.post('/:id/open-path', async (c) => {
    const p = OpenInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return s.bad(c, t('缺少文件路径'))
    try {
      const { roots, homes } = await rootsOf(c.req.param('id'))
      const info = await resolvePath(p.data.path, roots, homes)
      if (!info.exists) return s.bad(c, t('文件不存在，可能已删除或路径写错：{path}', { path: info.abs }), 404)
      // 存在就能打开（用户 2026-11-24 定）：以前只开项目里的或对话里提到过的，文档根这类项目外的文件打不开。
      // 会被执行的类型照样只在文件夹里选中，不运行（见 openPath）
      return c.json({ ok: true, ...(await openPath(info, p.data.reveal)), abs: info.abs })
    } catch (e) {
      const f = fail(e)
      return s.bad(c, f.error, f.status)
    }
  })
  return app
}
