import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { TRASH_RETENTION_DAYS, trashLeftDays } from '../shared/task.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { Agent, Project, Workflow } from '../shared/schema.ts'
import { log } from './log.ts'

/**
 * 角色、工作流、项目的回收站。以前删除只有一个确认框，删错了就找不回来（对话早就有回收站了）。
 * 删掉的那一份原样存成 trash/items/<类别>-<id>.json，保留期和对话的一样（TRASH_RETENTION_DAYS），
 * 恢复时按原 id 放回集合；项目还记着跟它一起进回收站的对话，恢复项目时一起恢复。
 */
export type TrashKind = 'agent' | 'workflow' | 'project'

export interface TrashedItem {
  kind: TrashKind
  id: string
  name: string
  deletedAt: string
  item: { id: string; name?: string } & Record<string, unknown>
  /** 删项目时一起进回收站的对话 */
  taskIds?: string[]
}

export const ITEM_TRASH_DIR = path.join(DATA_DIR, 'trash', 'items')
const fileOf = (kind: TrashKind, id: string) => path.join(ITEM_TRASH_DIR, `${kind}-${id.replace(/[^\w-]/g, '_')}.json`)

export async function trashItem(kind: TrashKind, item: TrashedItem['item'], taskIds?: string[]) {
  await mkdir(ITEM_TRASH_DIR, { recursive: true })
  const row: TrashedItem = {
    kind,
    id: item.id,
    name: String(item.name ?? item.id),
    deletedAt: new Date().toISOString(),
    item,
    ...(taskIds?.length ? { taskIds } : {}),
  }
  await writeJsonAtomic(fileOf(kind, item.id), row)
}

export async function listTrashedItems(): Promise<TrashedItem[]> {
  const names = await readdir(ITEM_TRASH_DIR).catch(() => [] as string[])
  const rows: TrashedItem[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const row = (await readJson(path.join(ITEM_TRASH_DIR, n))) as TrashedItem | undefined
    if (row?.kind && row.id && row.item) rows.push(row)
  }
  return rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** 过期的物理删除：挂在每小时那次清理上（server/index.ts 的 runCleanup） */
export async function cleanupItemTrash(now = Date.now()) {
  let removed = 0
  for (const row of await listTrashedItems())
    if (trashLeftDays(row.deletedAt, now) === 0) {
      await rm(fileOf(row.kind, row.id), { force: true })
      removed++
    }
  if (removed) log.info('trash', '角色 / 工作流 / 项目回收站过期清理', { removed })
  return removed
}

/** 恢复要用到的集合操作：由 index.ts 按类别接上真实的集合，这里不直接依赖它们 */
export interface ItemTrashDeps {
  exists: (kind: TrashKind, id: string) => Promise<boolean>
  put: (kind: TrashKind, item: TrashedItem['item']) => Promise<void>
  restoreTasks: (ids: string[]) => Promise<void>
}

export function itemTrashApi(deps: ItemTrashDeps) {
  return new Hono()
    .get('/', async (c) =>
      c.json(
        (await listTrashedItems()).map((r) => ({
          kind: r.kind,
          id: r.id,
          name: r.name,
          deletedAt: r.deletedAt,
          tasks: r.taskIds?.length ?? 0,
          leftDays: trashLeftDays(r.deletedAt),
          retentionDays: TRASH_RETENTION_DAYS,
        })),
      ),
    )
    .post('/:kind/:id/restore', async (c) => {
      const kind = c.req.param('kind') as TrashKind
      const id = c.req.param('id')
      const row = (await listTrashedItems()).find((r) => r.kind === kind && r.id === id)
      if (!row) return c.json({ error: t('回收站里没有这一项') }, 404)
      // 同一个 id 已经又存在了（例如内置角色被重新补上）：不覆盖现有的，如实说
      if (await deps.exists(kind, id))
        return c.json({ error: t('「{name}」已经存在，不需要恢复', { name: row.name }) }, 409)
      await deps.put(kind, row.item)
      if (row.taskIds?.length) await deps.restoreTasks(row.taskIds)
      await rm(fileOf(kind, id), { force: true })
      return c.json({ ok: true, tasks: row.taskIds?.length ?? 0 })
    })
    .delete('/:kind/:id', async (c) => {
      await rm(fileOf(c.req.param('kind') as TrashKind, c.req.param('id')), { force: true })
      return c.body(null, 204)
    })
}

/** 接上真实的集合：按原 id 放回去（工作流、项目引用的是这个 id），放回前过一遍当前的 schema（删除后升级过版本也读得进来） */
export function itemTrashRoutes(c: {
  agents: { get(id: string): Promise<unknown>; list(): Promise<Agent[]>; setAll(items: Agent[]): Promise<unknown> }
  workflows: {
    get(id: string): Promise<unknown>
    list(): Promise<Workflow[]>
    setAll(items: Workflow[]): Promise<unknown>
  }
  projects: {
    get(id: string): Promise<unknown>
    list(): Promise<Project[]>
    setAll(items: Project[]): Promise<unknown>
  }
  restoreTasks: (ids: string[]) => Promise<void>
}) {
  return itemTrashApi({
    exists: async (kind, id) =>
      !!(await (kind === 'agent' ? c.agents : kind === 'workflow' ? c.workflows : c.projects).get(id)),
    put: async (kind, item) => {
      if (kind === 'agent') await c.agents.setAll([...(await c.agents.list()), Agent.parse(item)])
      else if (kind === 'workflow') await c.workflows.setAll([...(await c.workflows.list()), Workflow.parse(item)])
      else await c.projects.setAll([...(await c.projects.list()), Project.parse(item)])
    },
    restoreTasks: c.restoreTasks,
  })
}
