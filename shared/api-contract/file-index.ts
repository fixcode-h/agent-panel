/**
 * 项目文件索引的接口契约（ADR 0062 的写法）：项目设置的状态卡、数据页、文件面板按名字搜
 */
import { z } from 'zod'
import { FileIndexHits, FileIndexOverview, FileIndexStatus } from '../file-index/types.ts'
import { endpoint } from './define.ts'

const Ok = z.object({ ok: z.boolean() })

export const FileIndexList = z.object({
  files: z.array(z.string()),
  dirs: z.array(z.string()),
})

export const FileIndexRefresh = z.object({ checked: z.number(), added: z.number(), removed: z.number() })

export const fileIndexContract = {
  /** 数据页：所有落盘的索引（含无主的）和总大小 */
  overview: endpoint({ method: 'GET', path: '/file-index', res: FileIndexOverview }),
  /** 数据页「清理」：全部删掉（开着的项目下次用到时重建） */
  clearAll: endpoint({ method: 'DELETE', path: '/file-index', res: Ok }),
  /** 数据页一行的「删除」 */
  drop: endpoint({ method: 'DELETE', path: '/file-index/:key', res: Ok }),
  /** 数据页一行的「重建」：按键找到用它的项目 */
  rebuildKey: endpoint({ method: 'POST', path: '/file-index/:key/rebuild', body: z.object({}), res: Ok }),
  /** 项目设置的状态卡 */
  status: endpoint({ method: 'GET', path: '/projects/:id/file-index', res: FileIndexStatus }),
  /** 按名字找（查询参数 q、under、ext 用逗号分隔，limit、offset） */
  find: endpoint({ method: 'GET', path: '/projects/:id/file-index/find', res: FileIndexHits }),
  /** 按文件夹取（查询参数 dir、recursive） */
  list: endpoint({ method: 'GET', path: '/projects/:id/file-index/list', res: FileIndexList }),
  /** 「增量更新」 */
  refresh: endpoint({
    method: 'POST',
    path: '/projects/:id/file-index/refresh',
    body: z.object({}),
    res: FileIndexRefresh,
  }),
  /** 「全量重建」：马上返回，进度经推送 */
  rebuild: endpoint({
    method: 'POST',
    path: '/projects/:id/file-index/rebuild',
    body: z.object({}),
    res: FileIndexStatus,
  }),
}
