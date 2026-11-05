import { z } from 'zod'
import { openable, openPath, resolvePath, searchRoots } from '../task-paths.ts'
import { t } from '../../shared/i18n.ts'
import type { TasksScope } from './scope.ts'

/** 一次最多解析这么多个：一条长回复里的路径通常十几个，再多就是传错了 */
const MAX_PATHS = 200
const Paths = z.object({ paths: z.array(z.string().min(1).max(4096)).max(MAX_PATHS) })
const OpenInput = z.object({ path: z.string().min(1).max(4096), reveal: z.boolean().default(false) })

/**
 * 对话消息里提到的文件：解析成本机的真实路径（悬停卡片、找不到时划掉），用系统默认程序打开或在文件夹中显示。
 * 找文件的规则见 server/task-paths.ts
 */
export function registerPathRoutes(s: TasksScope) {
  /** 这个对话找文件的根；导入的任务没有本机目录，读不了时按原因报错 */
  const rootsOf = async (id: string) => {
    const dir = await s.readableDir(id)
    const tk = (await s.current(id))!
    const project = tk.projectId ? await s.deps.projects.get(tk.projectId) : null
    const homes = [dir, project?.path ?? ''].filter(Boolean)
    return { tk, homes, roots: searchRoots(dir, project?.path ?? '') }
  }
  const fail = (e: unknown) => ({ error: (e as Error).message, status: (e as { status?: 400 | 404 }).status ?? 400 })

  s.routes.post('/:id/paths', async (c) => {
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

  s.routes.post('/:id/open-path', async (c) => {
    const p = OpenInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return s.bad(c, t('缺少文件路径'))
    try {
      const { tk, roots, homes } = await rootsOf(c.req.param('id'))
      const info = await resolvePath(p.data.path, roots, homes)
      if (!info.exists) return s.bad(c, t('文件不存在，可能已删除或路径写错：{path}', { path: info.abs }), 404)
      if (!openable(tk, info, homes)) return s.bad(c, t('只能打开项目里的文件或对话里提到过的文件'))
      return c.json({ ok: true, ...(await openPath(info, p.data.reveal)), abs: info.abs })
    } catch (e) {
      const f = fail(e)
      return s.bad(c, f.error, f.status)
    }
  })
}
