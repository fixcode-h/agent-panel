import path from 'node:path'
import { rel } from '../own-changes.ts'
import { taskMap } from '../runtime/task-state.ts'

/**
 * 每轮改动按文件归属（分析稿 A1）：几个对话共用一个目录（都没开独立分支）时，一轮的改动卡片和撤销只算这个对话自己的文件。
 *
 * 每轮改动本身是「开始和结束各拍一张整目录快照求差」（server/turn/changes.ts），同目录里别的对话这段时间改的文件
 * 也在差里：卡片会把它们列成自己的，撤销会把别人的改动一起撤掉。
 *
 * 归属只看工具调用记录：CLI 报的改文件类调用带着路径（CliEvent 的 file，各 CLI 的解析层统一给出）。
 * 跑命令改了哪些文件从调用里看不出来，所以规则是保守地「剔除确定是别人的」：
 * - 这一轮期间没有别的对话在同一个目录里报过改文件：照旧，快照差全算；
 * - 有：差里的文件，本对话点名过的留下；别的对话点名过、本对话没点名的剔除；谁都没点名的（命令改的）留下。
 *
 * 子对话、工作流运行的改动也算父对话的：接着做的那一轮本来就要把它们算进来（见 turn-changes.ts 的说明）。
 *
 * 只记在内存里（和每轮的起点一样）：面板重启后进行中的那一轮本来就没有卡片。
 */
interface Turn {
  dir: string
  /** 这一轮开始时的序号：之后登记的才算这一轮的 */
  from: number
}

/** 一轮结束时交出去的凭据：等终点快照拍完再拿它筛（这段时间别人报的改动也要算进去） */
export interface TurnOwner extends Turn {
  taskId: string
}

let seq = 0 // 模块状态：运行时，改动归属，重启时那一轮的归属丢失
// 运行时（task-state 登记，对话删掉时跟着清）：每个对话这一轮的起点，重启时那一轮的归属丢失
const turns = taskMap<Turn>('turn-owners 这一轮的起点')
/** 目录 → 对话 → 文件（相对目录、正斜杠）→ 最近一次点名的序号。只留最近一次：判断「这一轮里点没点过」够用，也不会越记越多 */
const edits = new Map<string, Map<string, Map<string, number>>>() // 模块状态：运行时，改动归属，重启时那一轮的归属丢失
/** 对话 → 父对话：子对话的改动算不算父对话的要沿着它往上找 */
const parents = taskMap<string>('turn-owners 父对话') // 运行时（task-state 登记，对话删掉时跟着清）：改动归属，重启时那一轮的归属丢失

const key = (dir: string) => path.resolve(dir)

/** 一轮开始（同步登记，不等快照）。carry 和 beginTurnChanges 同一个意思：接着上一轮做，起点不动 */
export function openTurn(taskId: string, dir: string, carry: boolean) {
  const had = turns.get(taskId)
  if (carry && had && had.dir === key(dir)) return
  turns.set(taskId, { dir: key(dir), from: seq })
}

/** 一轮结束：交出这一轮的凭据，之后登记的算下一段（接着做的那一轮从这里算起） */
export function closeTurn(taskId: string): TurnOwner | undefined {
  const t = turns.get(taskId)
  if (!t) return undefined
  turns.set(taskId, { dir: t.dir, from: seq })
  return { taskId, ...t }
}

/** 这一轮进行到现在的凭据（不收这一轮）：end_turn 时先看一眼这一轮的改动用（turn-changes.ts 的 peekTurnFiles） */
export function peekTurn(taskId: string): TurnOwner | undefined {
  const t = turns.get(taskId)
  return t ? { taskId, ...t } : undefined
}

/**
 * 登记一次改文件的工具调用。调用发出时和结果成功时各登记一次：
 * 发出时登记，别的对话的终点快照赶在结果回来之前拍到这个文件时也认得出是谁的；
 * 成功时再登记，等审批等了很久才落盘的写入也落在别的对话这一轮的序号之后
 */
export function noteEdit(taskId: string, dir: string, file: string, parentId?: string) {
  const p = rel(dir, file.trim())
  if (!p) return
  if (parentId) parents.set(taskId, parentId)
  const d = key(dir)
  let byTask = edits.get(d)
  if (!byTask) edits.set(d, (byTask = new Map()))
  let files = byTask.get(taskId)
  if (!files) byTask.set(taskId, (files = new Map()))
  files.set(p, ++seq)
}

/** who 是不是 me 自己或者 me 名下的（子对话、子对话的子对话） */
function within(who: string, me: string) {
  const seen = new Set<string>()
  for (let x: string | undefined = who; x && !seen.has(x); x = parents.get(x)) {
    if (x === me) return true
    seen.add(x)
  }
  return false
}

/** 这一轮里点名过的文件：mine 是本对话（和名下子对话）的，others 是同目录别的对话的 */
export function namedSince(owner: TurnOwner) {
  const mine = new Set<string>()
  const others = new Set<string>()
  for (const [taskId, files] of edits.get(owner.dir) ?? []) {
    const into = within(taskId, owner.taskId) ? mine : others
    for (const [p, at] of files) if (at > owner.from) into.add(p)
  }
  return { mine, others }
}

/**
 * 归属规则本身（纯函数）：别的对话点名过、本对话没点名的剔除，其余留下。
 * 两边都点名过的留下：本对话确实改过它，撤销时撤不干净会报冲突，不会悄悄盖掉别人的
 */
export function splitOwned<T extends { path: string }>(
  files: T[],
  named: { mine: ReadonlySet<string>; others: ReadonlySet<string> },
): { kept: T[]; dropped: T[] } {
  const kept: T[] = []
  const dropped: T[] = []
  for (const f of files) (named.mine.has(f.path) || !named.others.has(f.path) ? kept : dropped).push(f)
  return { kept, dropped }
}

/** 测试用：清掉登记 */
export function resetTurnOwners() {
  seq = 0
  turns.clear()
  edits.clear()
  parents.clear()
}
