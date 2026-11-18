/**
 * 模型目录的接口契约（写法见 ./define.ts）。读目录、AI 补全单个模型的老接口还在 web/src/lib/api.ts。
 *
 * - discover：用户点「联网检查」时起一次查询，马上返回编号；Agent 查完把目录里没有的模型列成候选，不自动写入。
 * - discoverJob / stopDiscover：查进度、停掉。
 * - addEntries：用户勾选的候选写进补充目录（config/models.json），同厂商同 id 的覆盖。
 * - removeEntry：删掉一条补充记录；同名的内置记录重新生效。
 */
import { z } from 'zod'
import { endpoint } from './define.ts'
import { ModelCatalogEntry } from '../models/catalog.ts'
import { ModelDiscoverJob } from '../models/discover.ts'

const Entries = z.object({ entries: z.array(ModelCatalogEntry) })

export const modelCatalogContract = {
  discover: endpoint({ method: 'POST', path: '/model-catalog/discover', body: z.object({}), res: ModelDiscoverJob }),
  discoverJob: endpoint({ method: 'GET', path: '/model-catalog/discover/:id', res: ModelDiscoverJob }),
  stopDiscover: endpoint({
    method: 'POST',
    path: '/model-catalog/discover/:id/stop',
    body: z.object({}),
    res: ModelDiscoverJob,
  }),
  addEntries: endpoint({
    method: 'POST',
    path: '/model-catalog/entries',
    body: z.object({ entries: z.array(ModelCatalogEntry).min(1).max(100) }),
    res: Entries,
  }),
  removeEntry: endpoint({
    method: 'POST',
    path: '/model-catalog/entries/remove',
    body: z.object({ vendor: z.string().min(1), id: z.string().min(1) }),
    res: Entries,
  }),
}
