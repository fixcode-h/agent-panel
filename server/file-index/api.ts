/**
 * 文件索引的 HTTP 接口（契约在 shared/api-contract/file-index.ts）
 */
import { Hono } from 'hono'
import path from 'node:path'
import { fileIndexContract as C } from '../../shared/api-contract/file-index.ts'
import { fileIndexPage, type FileIndexDiskEntry } from '../../shared/file-index/types.ts'
import { t } from '../../shared/i18n.ts'
import { closeAll, dropUnit, liveUnits, projectIndex, statusOf } from './registry.ts'
import { dropAllIndexes, dropIndex, INDEX_DIR, listIndexFiles } from './store.ts'

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** 分页：limit 默认 50，最多 5000（文件面板一次要多一点） */
const page = fileIndexPage

export function fileIndexApi(deps: { projectNames: () => Promise<Map<string, string>> }) {
  const app = new Hono()

  app.get(C.overview.path, async (c) => {
    const names = await deps.projectNames()
    const live = new Map(liveUnits().map((x) => [x.unit.key, x]))
    const entries: FileIndexDiskEntry[] = []
    let bytes = 0
    for (const f of await listIndexFiles()) {
      bytes += f.bytes
      const l = live.get(f.key)
      const st = l?.unit.status()
      entries.push({
        key: f.key,
        root: st?.root ?? f.head?.root.split(path.sep).join('/') ?? '',
        projects: (l?.users ?? []).map((id) => ({ id, name: names.get(id) ?? id })),
        vcs: st?.vcs ?? f.head?.vcs ?? 'none',
        state: st?.state ?? 'ready',
        files: st?.files ?? f.head?.files ?? 0,
        dirs: st?.dirs ?? f.head?.dirs ?? 0,
        bytes: f.bytes,
        ...((st?.changedAt ?? f.head?.changedAt) ? { changedAt: st?.changedAt ?? f.head?.changedAt } : {}),
        ...((st?.builtAt ?? f.head?.builtAt) ? { builtAt: st?.builtAt ?? f.head?.builtAt } : {}),
      })
      live.delete(f.key)
    }
    // 还在建、还没落过盘的
    for (const [key, l] of live) {
      const st = l.unit.status()
      entries.push({
        key,
        root: st.root,
        projects: l.users.map((id) => ({ id, name: names.get(id) ?? id })),
        vcs: st.vcs,
        state: st.state,
        files: st.files,
        dirs: st.dirs,
        bytes: 0,
      })
    }
    return c.json({ dir: INDEX_DIR, bytes, entries })
  })

  app.delete(C.clearAll.path, async (c) => {
    closeAll()
    await dropAllIndexes()
    return c.json({ ok: true })
  })

  app.delete(C.drop.path, async (c) => {
    await dropUnit(c.req.param('key'))
    await dropIndex(c.req.param('key'))
    return c.json({ ok: true })
  })

  app.post(C.rebuildKey.path, async (c) => {
    const l = liveUnits().find((x) => x.unit.key === c.req.param('key'))
    if (!l) return c.json({ error: t('这份索引现在没有项目在用，删掉即可；项目用到时会自动重建') }, 404)
    void l.unit.build()
    return c.json({ ok: true })
  })

  app.get(C.status.path, async (c) => {
    const s = await statusOf(c.req.param('id'))
    return s ? c.json(s) : c.json({ error: t('找不到这个项目') }, 404)
  })

  app.get(C.find.path, async (c) => {
    const idx = await projectIndex(c.req.param('id'))
    if (!idx) return c.json({ error: t('这个项目没有开文件索引') }, 400)
    const q = c.req.query('q') ?? ''
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 5000)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const hits = idx.find(q, {
      under: csv(c.req.query('under')),
      ext: csv(c.req.query('ext')),
      dirs: c.req.query('dirs') === '1',
      cap: offset + limit + 1000,
    })
    return c.json(
      page(
        hits.map((h) => h.path),
        offset,
        limit,
        { ...(idx.building ? { partial: true } : {}) },
      ),
    )
  })

  app.get(C.list.path, async (c) => {
    const idx = await projectIndex(c.req.param('id'))
    if (!idx) return c.json({ error: t('这个项目没有开文件索引') }, 400)
    await idx.ready(30_000)
    const r = await idx.list(c.req.query('dir') ?? '', {
      recursive: c.req.query('recursive') === '1',
      ext: csv(c.req.query('ext')),
    })
    return r ? c.json(r) : c.json({ error: t('索引里没有这个目录（不存在，或在排除目录里）') }, 404)
  })

  app.post(C.refresh.path, async (c) => {
    const idx = await projectIndex(c.req.param('id'))
    if (!idx) return c.json({ error: t('这个项目没有开文件索引') }, 400)
    await idx.ready(60_000)
    return c.json(await idx.refresh())
  })

  app.post(C.rebuild.path, async (c) => {
    const idx = await projectIndex(c.req.param('id'))
    if (!idx) return c.json({ error: t('这个项目没有开文件索引') }, 400)
    void idx.rebuild()
    return c.json(await statusOf(c.req.param('id')))
  })

  return app
}
