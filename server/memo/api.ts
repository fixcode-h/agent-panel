/**
 * 派生缓存的 HTTP 接口（契约在 shared/api-contract/memo.ts）：设置 →「数据」看有哪些缓存、清空
 */
import { Hono } from 'hono'
import { memoContract as C } from '../../shared/api-contract/memo.ts'
import { openDirWatches } from '../watch/dir.ts'
import { clearMemos, memoStats } from './index.ts'

const overview = () => ({ caches: memoStats().sort((a, b) => a.name.localeCompare(b.name)), watches: openDirWatches() })

export function memoApi() {
  const app = new Hono()
  app.get(C.overview.path, (c) => c.json(overview()))
  app.post(C.clear.path, async (c) => {
    const b = C.clear.body.parse(await c.req.json().catch(() => ({})))
    clearMemos(b.name)
    return c.json(overview())
  })
  return app
}
