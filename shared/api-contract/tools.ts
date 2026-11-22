/**
 * 「小工具」页的接口契约（ADR 0062 的写法）。一个工具一组接口，路径都在 /tools/<工具 id> 下。
 */
import { z } from 'zod'
import { GhDownloadJob, GhDownloadOverview, GhDownloadStart } from '../tools/gh-download.ts'
import { endpoint } from './define.ts'

export const toolsContract = {
  /** GitHub 加速下载：下载记录、默认目录、设置里的下载来源 */
  ghDownloads: endpoint({ method: 'GET', path: '/tools/gh-download', res: GhDownloadOverview }),
  ghDownloadStart: endpoint({ method: 'POST', path: '/tools/gh-download', body: GhDownloadStart, res: GhDownloadJob }),
  ghDownloadCancel: endpoint({
    method: 'POST',
    path: '/tools/gh-download/:id/cancel',
    body: z.object({}),
    res: GhDownloadJob,
  }),
  /** 在文件夹里显示下好的文件 */
  ghDownloadReveal: endpoint({
    method: 'POST',
    path: '/tools/gh-download/:id/reveal',
    body: z.object({}),
    res: z.object({ ok: z.boolean() }),
  }),
  /** 从记录里移掉（不删文件） */
  ghDownloadRemove: endpoint({
    method: 'DELETE',
    path: '/tools/gh-download/:id',
    res: z.object({ ok: z.boolean() }),
  }),
}
