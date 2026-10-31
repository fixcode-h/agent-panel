import path from 'node:path'
import type { TaskMessage, TurnChanges } from '../shared/schema.ts'
import {
  diffNames,
  gitHead,
  gitSnapshot,
  spansNumstat,
  syncedFiles,
  type PlacedFiles,
  type TreeSpan,
} from './exec/git.ts'
import { log } from './log.ts'

/**
 * 每轮对话改了哪些文件（总结下面那张「已更改 N 个文件」卡片的数据）。
 *
 * 做法：这一轮开始时给工作区拍一张快照（gitSnapshot，不碰暂存区和提交），这一轮结束时再拍一张，
 * 两张之间的差就是这一轮的改动，记在这一轮的总结那条消息上，撤销时只撤这段差。
 *
 * 算不算进这一轮：
 * - 用户发来新消息开始的一轮重新拍起点：上一轮结束到现在用户自己改的、子对话合进来的都不算
 * - 子任务、工作流（计划）交回结果后接着做的一轮，接着上一轮的终点算：子任务和工作流节点就在这段空档里改文件，
 *   重新拍起点就把它们漏了
 * - 子对话合回这个目录的那一下单独切掉（见 aroundMerge）：父对话的卡片不含子对话的改动
 * - 这一轮里拉代码、合并别的分支、切分支带进来的文件不算（见 dropSynced）：Agent 按规则 fetch + merge 同步，
 *   上游改的几百个文件不是这个对话改的
 *
 * 只记在内存里：面板重启时进行中的那一轮就没有卡片了，不影响已经记在消息上的。
 */
interface Track {
  dir: string
  ignore: string[]
  /** 这一段的起点 */
  mark: Promise<string>
  /** 这一轮里已经切下来的几段（中间被子对话合并隔开） */
  spans: TreeSpan[]
  /** 这一段开始时的提交和时刻：中间 HEAD 动过时用来认出拉代码带进来的文件 */
  head: Promise<string>
  at: number
}

const tracks = new Map<string, Track>()
/** 每个对话的操作排队做：结束一轮还在拍快照时下一轮就开始了，起点要等上一轮的终点 */
const queues = new Map<string, Promise<unknown>>()

function queued<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(taskId) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.catch(() => undefined)
  queues.set(taskId, tail)
  void tail.then(() => {
    if (queues.get(taskId) === tail) queues.delete(taskId)
  })
  return next
}

const snap = (dir: string, ignore: string[]) =>
  gitSnapshot(dir, ignore).catch((e) => {
    log.warn('task', '拍工作区快照失败', { dir, error: (e as Error).message })
    return ''
  })

/**
 * 一轮开始。carry：这一轮接着上一轮做（子任务、工作流交回的结果），起点沿用上一轮的终点；
 * 目录换了（中途开了独立分支）或者没有上一轮的记录时照样重新拍
 */
export function beginTurnChanges(taskId: string, dir: string, ignore: PlacedFiles, carry: boolean) {
  const list = [...ignore]
  // 不用等它拍完再交给 CLI：模型开始改文件至少要几秒，快照早就拍好了。返回的 Promise 给测试等
  return queued(taskId, async () => {
    const had = tracks.get(taskId)
    if (carry && had && had.dir === dir) return
    const at = Date.now()
    const head = gitHead(dir).catch(() => '')
    const mark = snap(dir, list)
    tracks.set(taskId, { dir, ignore: list, mark, spans: [], head, at })
    await mark
  })
}

/**
 * 一轮结束：拍终点，算出这一轮（起点到现在，去掉子对话合并的那几下）改了哪些文件，交给 put 记到总结上。
 * 终点留作下一段的起点（接着做的那一轮用）。没改文件时不调 put
 */
export function endTurnChanges(taskId: string, put: (changes: TurnChanges) => void) {
  return queued(taskId, async () => {
    const tr = tracks.get(taskId)
    if (!tr) return
    const from = await tr.mark
    const head = await tr.head
    const since = tr.at
    const to = await snap(tr.dir, tr.ignore)
    const endHead = await gitHead(tr.dir).catch(() => '')
    const first = tr.spans[0]?.from || from
    const spans = [...tr.spans, { from, to }].filter((s) => s.from && s.to && s.from !== s.to)
    tr.spans = []
    tr.mark = Promise.resolve(to)
    tr.head = Promise.resolve(endHead)
    tr.at = Date.now()
    if (!from || !to || !spans.length) return
    const all = await spansNumstat(tr.dir, spans).catch((e) => {
      log.warn('task', '读这一轮的改动失败', { task: taskId, error: (e as Error).message })
      return []
    })
    const files = await dropSynced(tr.dir, all, { head, endHead, from: first, to, since }).catch(() => all)
    if (files.length < all.length)
      log.info('task', '这一轮拉代码带进来的文件不算改动', { task: taskId, dropped: all.length - files.length })
    if (files.length) put({ spans, files })
  })
}

/**
 * 去掉这一轮里 HEAD 移动（拉代码、合并、切分支）带进来的文件：只有前后都和各自的 HEAD 一样（没有自己没提交的改动）、
 * 又不在自己这一轮的提交里的才去掉。自己改了又拉了同一个文件的照样算
 */
export async function dropSynced<T extends { path: string }>(
  dir: string,
  files: T[],
  at: { head: string; endHead: string; from: string; to: string; since: number },
): Promise<T[]> {
  if (!at.head || !at.endHead || at.head === at.endHead || !files.length) return files
  const synced = await syncedFiles(dir, at.head, at.endHead, at.since)
  if (!synced.size) return files
  const [dirtyStart, dirtyEnd] = await Promise.all([
    diffNames(dir, at.head, at.from),
    diffNames(dir, at.endHead, at.to),
  ])
  if (!dirtyStart || !dirtyEnd) return files
  return files.filter((f) => !synced.has(f.path) || dirtyStart.has(f.path) || dirtyEnd.has(f.path))
}

/** 等这个对话还没做完的快照（收尾落盘前调用，免得卡片写在落盘之后丢了） */
export function settleTurnChanges(taskId: string) {
  return queues.get(taskId) ?? Promise.resolve()
}

/**
 * 别的对话（子对话）的改动合进 dir：合并前后各拍一张，正在这个目录里记改动的对话把合并那一下切掉。
 * 合并本身失败了也没关系：前后两张一样，切掉的是空的
 */
export async function aroundMerge<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const here = path.resolve(dir)
  const ids = [...tracks.entries()].filter(([, tr]) => path.resolve(tr.dir) === here).map(([id]) => id)
  if (!ids.length) return run()
  // 合并前：每个对话把起点到现在切成一段（同一个目录拍一张就够）
  const ignore = tracks.get(ids[0])!.ignore
  const before = await snap(dir, ignore)
  await Promise.all(
    ids.map((id) =>
      queued(id, async () => {
        const tr = tracks.get(id)
        if (!tr) return
        const from = await tr.mark
        if (from && before) tr.spans.push({ from, to: before })
        tr.mark = Promise.resolve(before)
      }),
    ),
  )
  try {
    return await run()
  } finally {
    const after = await snap(dir, ignore)
    await Promise.all(
      ids.map((id) =>
        queued(id, async () => {
          const tr = tracks.get(id)
          if (tr) tr.mark = Promise.resolve(after)
        }),
      ),
    )
  }
}

/** 这一轮的总结：最后一条有正文的回复；一句话都没有时退到最后一条回复 */
export function summaryMessage(msgs: TaskMessage[]): TaskMessage | undefined {
  const agent = msgs.filter((m) => m.role === 'agent')
  return [...agent].reverse().find((m) => m.text.trim()) ?? agent.at(-1)
}
