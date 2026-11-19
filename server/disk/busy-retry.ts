/**
 * Windows 上刚写好、刚复制的文件常被杀毒软件或索引服务短暂打开，这时改名、覆盖会报 EPERM / EBUSY；
 * 等一会儿再试通常就好了（和 npm 的 graceful-fs 一样的做法）。面板自己的升级和每轮的技能目录都走这里
 */
import { cp, rename, rm } from 'node:fs/promises'

const BUSY = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']

/** 文件被占用时等一会儿再试，最多 tries 次；别的错误马上抛出 */
export async function retryBusy<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= tries || !BUSY.includes(code)) throw e
      await new Promise((r) => setTimeout(r, Math.min(200 * i, 1500)))
    }
  }
}

/** 目录改名；一直改不了时（目录里有文件被占用）改成复制过去再删掉原来的 */
export async function moveDir(from: string, to: string, tries = 8) {
  try {
    await retryBusy(() => rename(from, to), tries)
  } catch {
    await retryBusy(() => cp(from, to, { recursive: true }))
    await rm(from, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
}
