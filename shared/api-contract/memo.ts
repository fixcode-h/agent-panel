/**
 * 派生缓存的接口契约（ADR 0074）：设置 →「数据」里的「内存缓存」一节，看进程里有哪些缓存、各几项、开着几个文件监听，能清空
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

export const MemoOverview = z.object({
  caches: z.array(z.object({ name: z.string(), size: z.number() })),
  /** 现在开着几个系统目录监听 */
  watches: z.number(),
})
export type MemoOverview = z.infer<typeof MemoOverview>

export const memoContract = {
  overview: endpoint({ method: 'GET', path: '/memo', res: MemoOverview }),
  /** 不给 name 就全清；清掉的下次用到时重算 */
  clear: endpoint({
    method: 'POST',
    path: '/memo/clear',
    body: z.object({ name: z.string().optional() }),
    res: MemoOverview,
  }),
}
