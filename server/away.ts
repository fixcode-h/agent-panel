/**
 * 「我不在」模式的开关和自动选过的记录（分析稿 A4，判定规则在 shared/away.ts）。
 * 全局生效，存数据目录的 config/away.json：面板重启后仍按用户离开前的设置走。
 *
 * 执行时的判定是同步的（runner 收到提问当场决定要不要等），所以状态常驻内存，启动时读一次；
 * 写文件串行，失败写日志并报给调用方（开关接口会把错误交给页面，不悄悄当成已保存）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { addPick, AwayState, dropPicks, switchAway, type AwayPick } from '../shared/away.ts'
import { dataPath, onReset, readJson, writeJsonAtomic } from './store.ts'
import { log } from './log.ts'

const FILE = () => dataPath('config/away.json')

let state: AwayState = AwayState.parse({})
let loaded: Promise<void> | undefined
onReset(() => {
  state = AwayState.parse({})
  loaded = undefined
})

/** 启动时读一次；文件坏了按「没开」处理并写日志（开关不该因为记录坏了就替用户选） */
export function loadAway() {
  loaded ??= readJson(FILE())
    .then((raw) => {
      if (raw === undefined) return
      const p = AwayState.safeParse(raw)
      if (p.success) state = p.data
      else log.warn('app', '「我不在」的记录文件内容不对，按没打开处理', { error: p.error.message })
    })
    .catch((e: Error) => log.warn('app', '读「我不在」的记录失败，按没打开处理', { error: e.message }))
  return loaded
}

/** 现在是不是开着：runner 收到提问时同步查 */
export const awayOn = () => state.on

export const awayState = () => state

let writing: Promise<void> = Promise.resolve()
function save(next: AwayState) {
  state = next
  const p = writing.catch(() => {}).then(() => writeJsonAtomic(FILE(), next))
  writing = p
  return p
}

/** 记一条自动选过的；写不进文件只写日志：选择已经交给 Agent 了，对话里那一行照样在 */
export function recordAwayPick(p: AwayPick) {
  save(addPick(state, p)).catch((e: Error) =>
    log.warn('app', '「我不在」自动选过的记录没能写进文件', { task: p.taskId, error: e.message }),
  )
}

/** 刚打开时：已经挂着、能自动选的提问一起处理掉（由任务模块登记，见 server/tasks/away-sweep.ts） */
let sweeper: (() => Promise<void>) | undefined
export const onAwaySweep = (fn: () => Promise<void>) => (sweeper = fn)

export function awayApi() {
  const Flag = z.object({ on: z.boolean() })
  return (
    new Hono()
      .get('/', async (c) => {
        await loadAway()
        return c.json(state)
      })
      .put('/', async (c) => {
        const p = Flag.safeParse(await c.req.json().catch(() => ({})))
        if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
        await loadAway()
        await save(switchAway(state, p.data.on))
        if (p.data.on)
          await sweeper?.().catch((e: Error) =>
            log.warn('app', '打开「我不在」时处理已挂着的提问失败', { error: e.message }),
          )
        return c.json(state)
      })
      // 总览上的「知道了」：不给 id 时全部清掉
      .delete('/picks/:id?', async (c) => {
        await loadAway()
        await save(dropPicks(state, c.req.param('id')))
        return c.json(state)
      })
  )
}
