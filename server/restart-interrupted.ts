import { Hono } from 'hono'
import path from 'node:path'
import type { InterruptedTasks } from '../shared/version.ts'
import type { Task } from '../shared/schema.ts'
import { restartResumable } from '../shared/resume-kids.ts'
import { CACHE_DIR, writeJsonAtomic } from './store.ts'
import { readInterrupted, resolveInterrupted, type InterruptedEntry, type InterruptedRecord } from './interrupted.ts'

/**
 * 被「面板退出 / 重启」打断的对话（实测报告问题 18）：以前重启后所有对话都停在「面板重启时中断」，只能逐个点「继续」。
 * 退出前（tasks.stopAll）记下名单，重启后首页给一条「上次有 N 个对话在运行：全部继续 / 逐个看」。
 * 不做成「重启后自动继续」：继续会花钱、会接着改项目，用户可能正是因为它跑偏了才关的面板，要用户点一下才拉起。
 * 和强制更新的记录（interrupted-by-update.json + 弹窗）分开放：那边是更新前问好的，这边是任何一次退出。
 */
const FILE = () => path.join(CACHE_DIR, 'interrupted-by-restart.json')

/** 退出前记下这次打断的对话；没有也照样写（空名单），把上次没处理的旧名单冲掉 */
export async function recordRestart(tasks: InterruptedEntry[]) {
  const record: InterruptedRecord = { at: new Date().toISOString(), acknowledged: false, tasks }
  await writeJsonAtomic(FILE(), record)
}

/**
 * 读、确认两个接口（挂在 /app 下，和强制更新的同一组，由 interruptedApi 一起挂上）。
 * 名单 = 退出前记下的 + 启动时发现还写着「执行中」的（上次没正常退出，没来得及记名单，见 migrateOnStart）。
 * 强制更新的弹窗还没处理时，它列过的对话不在这里重复出现
 */
export function restartRoutes(deps: {
  /** 等启动时的迁移做完，返回迁移时发现还在执行的对话 id */
  ready: () => Promise<string[] | unknown>
  getTask: (id: string) => Promise<Task | null>
  projectName: (id: string) => Promise<string>
}) {
  // 启动时迁移出来的那部分只在内存里：用户处理过一次就不再列（文件里的那部分靠 acknowledged）
  let crashAcked = false
  const body = async (): Promise<InterruptedTasks> => {
    const crashed = await deps.ready().catch(() => [])
    const record = await readInterrupted(FILE())
    const update = await readInterrupted()
    const skip = new Set(update.acknowledged ? [] : update.tasks.map((x) => x.id))
    const seen = new Set<string>()
    const entries: InterruptedEntry[] = []
    const add = (e: InterruptedEntry) => {
      if (seen.has(e.id) || skip.has(e.id)) return
      seen.add(e.id)
      entries.push(e)
    }
    if (!record.acknowledged) record.tasks.forEach(add)
    if (!crashAcked && Array.isArray(crashed))
      for (const id of crashed) if (typeof id === 'string') add({ id, doing: '' })
    const getTask = async (id: string) => {
      const task = await deps.getTask(id)
      return task && restartResumable(task) ? task : null
    }
    return {
      at: record.at,
      acknowledged: record.acknowledged && crashAcked,
      tasks: await resolveInterrupted({ ...record, tasks: entries }, getTask, deps.projectName),
    }
  }
  return (
    new Hono()
      .get('/restart-interrupted', async (c) => c.json(await body()))
      // 点了「全部继续」或关掉提示之后调用：这次重启不再提示
      .post('/restart-interrupted/ack', async (c) => {
        crashAcked = true
        const r = await readInterrupted(FILE())
        if (r.at) await writeJsonAtomic(FILE(), { ...r, acknowledged: true })
        return c.json(await body())
      })
  )
}
