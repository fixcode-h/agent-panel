import path from 'node:path'
import type { TaskMessage, TurnChanges } from '../shared/schema.ts'
import type { TurnTrack } from '../shared/tasks/runtime-schema.ts'
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
import { closeTurn, namedSince, openTurn, peekTurn, splitOwned } from './turn-owners.ts'
import { taskMap } from './runtime/task-state.ts'

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
 * - 同一个目录里别的对话这段时间改的文件不算（见 server/turn-owners.ts）：按改文件的工具调用认是谁的，
 *   别的对话点名过、这个对话没点名的剔除，剔除了哪些记在 others 上给卡片说明
 *
 * 起点存进任务数据（Task.turnTrack，分析稿 A10）：每次起点、终点、切段变了都写回（见 TrackKeep）。面板重启后
 * 内存里没有这个对话的记录时，存着的那一轮还开着（open）就接着它的起点算，进行中那一轮照样有改动卡片；
 * 接着做的一轮（carry）也从存着的终点接上。同目录别的对话的归属登记（turn-owners.ts）仍只在内存里，重启后那一轮不剔除别人的文件。
 */
/** 起点落盘的接口：runner 把任务上存着的那份交进来，变了用 save 写回 */
export interface TrackKeep {
  saved?: TurnTrack
  save: (rec: TurnTrack) => void
}

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
  /** 这一轮开着还没收：存进任务时重启后要不要接上看它 */
  open: boolean
  keep?: TrackKeep
}

/** 起点、切段、终点变了：等快照拍完后写回任务（拍失败的空快照不写，免得把存着的起点盖成空的） */
async function persist(tr: Track) {
  if (!tr.keep) return
  const [mark, head] = await Promise.all([tr.mark, tr.head])
  if (!mark) return
  tr.keep.save({ dir: tr.dir, mark, spans: tr.spans.slice(-200), head, at: tr.at, open: tr.open })
}

/** 存着的那份记录能不能接上：同一个目录，而且这一轮还开着（重启打断的）或者这一轮本来就接着上一轮做 */
function revive(keep: TrackKeep | undefined, dir: string, carry: boolean, ignore: string[]): Track | undefined {
  const r = keep?.saved
  if (!r?.mark || path.resolve(r.dir) !== path.resolve(dir) || !(r.open || carry)) return undefined
  return {
    dir,
    ignore,
    mark: Promise.resolve(r.mark),
    spans: [...r.spans],
    head: Promise.resolve(r.head),
    at: r.at,
    open: true,
    keep,
  }
}

const tracks = taskMap<Track>('turn-changes 每轮改动快照') // 运行时（task-state 登记，对话删掉时跟着清）：每轮改动的快照，重启时那一轮的改动卡片可能不全
/** 每个对话的操作排队做：结束一轮还在拍快照时下一轮就开始了，起点要等上一轮的终点 */
const queues = new Map<string, Promise<unknown>>() // 模块状态：排队，丢了没事

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
export function beginTurnChanges(taskId: string, dir: string, ignore: PlacedFiles, carry: boolean, keep?: TrackKeep) {
  const list = [...ignore]
  // 归属的起点当场登记，不排队：排着的快照还没拍完时别的对话报的改文件也要算进这一轮
  openTurn(taskId, dir, carry)
  // 不用等它拍完再交给 CLI：模型开始改文件至少要几秒，快照早就拍好了。返回的 Promise 给测试等
  return queued(taskId, async () => {
    const had = tracks.get(taskId)
    if (carry && had && had.dir === dir) {
      had.keep = keep ?? had.keep
      had.open = true
      return persist(had)
    }
    // 内存里没有（面板重启过）：存着的那一轮还开着、或者这一轮接着上一轮做，就从存着的起点接上
    const back = had ? undefined : revive(keep, dir, carry, list)
    if (back) {
      tracks.set(taskId, back)
      return persist(back)
    }
    const at = Date.now()
    const head = gitHead(dir).catch(() => '')
    const mark = snap(dir, list)
    const tr: Track = { dir, ignore: list, mark, spans: [], head, at, open: true, keep }
    tracks.set(taskId, tr)
    await mark
    await persist(tr)
  })
}

/**
 * 一轮结束：拍终点，算出这一轮（起点到现在，去掉子对话合并的那几下）改了哪些文件，交给 put 记到总结上。
 * 终点留作下一段的起点（接着做的那一轮用）。没改文件时不调 put
 */
export function endTurnChanges(taskId: string, put: (changes: TurnChanges) => void) {
  // 这一轮的归属凭据当场取：等快照的时候下一轮可能已经开始，起点会被换掉
  const owner = closeTurn(taskId)
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
    tr.open = false
    // 终点留作接着做那一轮的起点，这一轮记成已收（重启后不再把它当成进行中的一轮接上）
    await persist(tr)
    if (!from || !to || !spans.length) return
    const all = await spansNumstat(tr.dir, spans).catch((e) => {
      log.warn('task', '读这一轮的改动失败', { task: taskId, error: (e as Error).message })
      return []
    })
    const own = await dropSynced(tr.dir, all, { head, endHead, from: first, to, since }).catch(() => all)
    if (own.length < all.length)
      log.info('task', '这一轮拉代码带进来的文件不算改动', { task: taskId, dropped: all.length - own.length })
    // 终点拍完了再看谁点名过：别的对话在这一轮收尾时报的改动也已经登记上
    const { kept: files, dropped } = owner ? splitOwned(own, namedSince(owner)) : { kept: own, dropped: [] }
    if (dropped.length)
      log.info('task', '同目录别的对话改的文件不算这一轮的改动', { task: taskId, dropped: dropped.length })
    if (files.length) put({ spans, files, ...(dropped.length ? { others: dropped.map((f) => f.path) } : {}) })
  })
}

/**
 * 这一轮到现在改了哪些文件（相对工作目录），不收这一轮：end_turn 记成做完前补上命令改的文件（验证门禁用，见 server/exec/turn-extra.ts）。
 * 和 endTurnChanges 同一个口径：去掉拉代码带进来的、同目录别的对话改的；起点、终点都不动。
 * 只看当前这一段（接着做的一轮从上一轮的终点算起），更早几段的改动由那几段的工具调用记录兜着
 */
export function peekTurnFiles(taskId: string): Promise<string[]> {
  const owner = peekTurn(taskId)
  return queued(taskId, async () => {
    const tr = tracks.get(taskId)
    if (!tr) return []
    const from = await tr.mark
    const head = await tr.head
    const to = await snap(tr.dir, tr.ignore)
    const spans = [...tr.spans, { from, to }].filter((s) => s.from && s.to && s.from !== s.to)
    if (!from || !to || !spans.length) return []
    const all = await spansNumstat(tr.dir, spans).catch(() => [])
    const endHead = await gitHead(tr.dir).catch(() => '')
    const first = tr.spans[0]?.from || from
    const own = await dropSynced(tr.dir, all, { head, endHead, from: first, to, since: tr.at }).catch(() => all)
    const { kept } = owner ? splitOwned(own, namedSince(owner)) : { kept: own }
    return kept.map((f) => f.path)
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
        await persist(tr)
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
          if (!tr) return
          tr.mark = Promise.resolve(after)
          await persist(tr)
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
