import { Hono } from 'hono'
import { createRegistry, catalogText, groupOf, paramsOf, type ActionCaller, type ActionHost } from './registry.ts'
import { taskActions } from './tasks.ts'
import { projectActions } from './projects.ts'
import { settingsActions } from './settings.ts'
import { uiActions } from './ui.ts'
import { designActions } from './designs.ts'

/** 全部动作：新增一组时在这里加一行，组名就是文件名 */
export const appActions = createRegistry([
  ...taskActions,
  ...projectActions,
  ...settingsActions,
  ...uiActions,
  ...designActions,
])

let host: ActionHost | undefined
/** 服务端接口都挂好后由 server/index.ts 接上：进程内调接口、推给页面 */
export const setActionHost = (h: ActionHost) => {
  host = h
}

export function runAppAction(name: string, args: unknown, caller?: ActionCaller) {
  if (!host) return Promise.resolve({ ok: false as const, error: '面板还没准备好，稍后再试' })
  return appActions.run(name, args, { ...host, caller })
}

/** 给模型看的目录：按组列出 */
export const appCatalog = (group?: string) =>
  `${group ? '' : `动作分组：${appActions.groups().join('、')}\n\n`}${catalogText(appActions.list(group))}`

/** 人和脚本用的入口：和 MCP 是同一份动作表，走访问令牌 */
export const appActionsApi = () =>
  new Hono()
    .get('/', (c) =>
      c.json(
        appActions.list(c.req.query('group')).map((a) => ({
          name: a.name,
          group: groupOf(a.name),
          title: a.title,
          description: a.description,
          level: a.level,
          params: paramsOf(a),
        })),
      ),
    )
    .post('/:name', async (c) => {
      const r = await runAppAction(c.req.param('name'), await c.req.json().catch(() => ({})))
      return r.ok ? c.json(r.result) : c.json({ error: r.error }, 400)
    })
