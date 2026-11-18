/**
 * 补排查的读写（规则和核对在 shared/bug/probe.ts）：
 * - 开窗口（用户点「补排查」）：记一条 BugProbe，交给 Agent 一段固定的话；
 * - Agent 改文件之前（工具前钩子）给要动的文件拍快照：加之前的内容，按哈希存在对话目录的 log-base/，
 *   和论证加日志同一处（不修了的清理按它核对），哪条补排查拍了哪些文件记在 probe/<编号>-base.json；
 * - 这一轮结束逐行核对：只许新增带标记的行。过了记「刚加好」，勾了「放到我的工作区」就打补丁过去；
 * - 撤掉：点的那一刻再拍一次（probe/<编号>-pre.json），交给 Agent 一处一处删，这一轮结束按它核对。
 * 快照只用来核对，不拿来还原文件
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Task } from '../../shared/schema.ts'
import type { BugProbe, ProbeProblem } from '../../shared/bug/probe-schema.ts'
import {
  checkProbeAdd,
  checkProbeRemove,
  openProbe,
  probeFiles,
  probeRemovePrompt,
  removable,
} from '../../shared/bug/probe.ts'
import { canOpenProbe, type ProbeOut } from '../../shared/bug/probe-start.ts'
import { bugOf } from '../../shared/bug/task-bug.ts'
import { patchFilesOf } from '../../shared/bug/patch.ts'
import { t } from '../../shared/i18n.ts'
import { TASK_FILES_DIR } from '../store.ts'
import { ABSENT, inside, keep, load, readIn } from './bug-cleanup.ts'
import { applyPatch, loadPatch, patchDirsOf, restorePatch } from './bug-patch.ts'
import { taskLog } from './log.ts'
import type { TasksScope } from './scope.ts'

type Snap = Record<string, string>
const snapFile = (taskId: string, id: string, kind: 'base' | 'pre') =>
  path.join(TASK_FILES_DIR, taskId, 'probe', `${id.replace(/[^\w-]/g, '')}-${kind}.json`)

async function loadSnap(taskId: string, id: string, kind: 'base' | 'pre'): Promise<Snap> {
  try {
    const v = JSON.parse(await readFile(snapFile(taskId, id, kind), 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Snap) : {}
  } catch {
    return {}
  }
}

async function saveSnap(taskId: string, id: string, kind: 'base' | 'pre', v: Snap) {
  const f = snapFile(taskId, id, kind)
  await mkdir(path.dirname(f), { recursive: true })
  await writeFile(f, JSON.stringify(v))
}

/** 拍一份：已经拍过的文件不再拍（同一轮改好几次，要的是第一次改之前的样子） */
async function snap(taskId: string, dir: string, files: string[], into: Snap): Promise<boolean> {
  let changed = false
  for (const f of files) {
    if (f in into || !inside(dir, f)) continue
    const content = await readIn(dir, f)
    into[f] = content === undefined ? ABSENT : await keep(taskId, content)
    changed = true
  }
  return changed
}

const rel = (dir: string, p: string) => {
  const r = path.relative(dir, path.resolve(dir, p))
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replace(/\\/g, '/')
}

/**
 * 工具前钩子（server/hooks/dispatch.ts）：补排查窗口开着、它要改文件时，先给这几个文件拍「加之前」的快照。
 * 只读任务、不改任务（钩子拿到的任务不一定是会落盘的那一份），快照记在对话目录的文件里
 */
export async function snapshotBeforeEdit(task: Pick<Task, 'id' | 'bug'>, cwd: string, paths: string[]) {
  const p = openProbe(task.bug)
  if (p?.state !== 'adding' || !cwd) return
  const files = paths.map((x) => rel(cwd, x)).filter(Boolean)
  if (!files.length) return
  const base = await loadSnap(task.id, p.id, 'base')
  if (await snap(task.id, cwd, files, base)) await saveSnap(task.id, p.id, 'base', base)
}

/** 撤掉几条（ids 为空是全部能撤的）：点的那一刻给它们的文件拍一份，交给 Agent 一处一处删 */
export async function removeProbes(task: Task, dir: string, ids: string[]): Promise<ProbeOut> {
  const why = canOpenProbe(task)
  // 报告关了也能撤：不修了的清理没删到的（用户选了自己处理）还能在这里单条撤
  if (why && !(task.bug?.diagnoses?.at(-1)?.status === 'cancelled' && !task.working && !openProbe(task.bug)))
    return { ok: false, error: why }
  const list = (task.bug?.probes ?? []).filter((p) => removable(p) && (!ids.length || ids.includes(p.id)))
  if (!list.length) return { ok: false, error: t('没有能撤的临时代码') }
  if (!dir) return { ok: false, error: t('找不到对话的工作目录') }
  for (const p of list) {
    const base = await loadSnap(task.id, p.id, 'base')
    const files = [...new Set([...p.spots.map((s) => s.file), ...Object.keys(base)])]
    const pre: Snap = {}
    await snap(task.id, dir, files, pre)
    await saveSnap(task.id, p.id, 'pre', pre)
    p.state = 'removing'
    p.problems = []
  }
  return { ok: true, message: probeRemovePrompt(list) }
}

/** 加完核对：快照里的每个文件和现在比 */
async function settleAdd(task: Task, dir: string, p: BugProbe) {
  const base = await loadSnap(task.id, p.id, 'base')
  const logBase = (bugOf(task).logBase ??= {})
  const spots: BugProbe['spots'] = []
  const problems: ProbeProblem[] = []
  for (const [file, h] of Object.entries(base)) {
    // 不修了的清理按 logBase 核对：补排查动过的文件也记上「加之前」（已有的是论证加日志之前，更早，留着）
    if (!(file in logBase)) logBase[file] = h
    const before = await load(task.id, h)
    if (before === undefined) continue
    const r = checkProbeAdd(p.id, file, before, (await readIn(dir, file)) ?? '')
    if (r.spot) spots.push(r.spot)
    problems.push(...r.problems)
  }
  if (!spots.length && !problems.length) problems.push({ file: '', line: 0, text: '', why: 'empty' })
  p.spots = spots
  p.problems = problems
  p.state = problems.length ? 'bad' : 'added'
}

/** 撤完核对：同一个文件里一起撤的几条合起来比（不然撤 P2 时 P3 的删除会被当成删多了） */
async function settleRemove(task: Task, dir: string, list: BugProbe[]) {
  const pres = new Map<string, Snap>()
  for (const p of list) pres.set(p.id, await loadSnap(task.id, p.id, 'pre'))
  const files = new Map<string, { h: string; ids: string[] }>()
  for (const p of list)
    for (const [f, h] of Object.entries(pres.get(p.id)!)) {
      const x = files.get(f) ?? { h, ids: [] }
      x.ids.push(p.id)
      files.set(f, x)
    }
  const byFile = new Map<string, ProbeProblem[]>()
  for (const [file, { h, ids }] of files) {
    const pre = await load(task.id, h)
    if (pre === undefined) continue
    byFile.set(file, checkProbeRemove(ids, file, pre, (await readIn(dir, file)) ?? ''))
  }
  for (const p of list) {
    p.problems = [...files].filter(([, x]) => x.ids.includes(p.id)).flatMap(([f]) => byFile.get(f) ?? [])
    p.state = p.problems.length ? 'stuck' : 'removed'
  }
}

/** 勾了「加好后放到我的工作区」：已经放过的先还原再连同新加的一起放（还原不了就不动，用户在清单上自己点） */
async function autoPatch(sc: Pick<TasksScope, 'deps'>, task: Task) {
  const dirs = await patchDirsOf(sc, task)
  if (!dirs) return
  if (await loadPatch(dirs.stateDir)) {
    const back = await restorePatch(dirs)
    if (!back.ok) return taskLog(task.id, '补排查：放到工作区前还原旧补丁失败', { reason: back.reason })
  }
  const r = await applyPatch(dirs, 'logs', patchFilesOf(task.bug?.diagnoses ?? [], 'logs', probeFiles(task.bug)))
  taskLog(task.id, r.ok ? '补排查：已放到工作区' : '补排查：放到工作区失败', { files: r.files, reason: r.reason })
}

/**
 * 一轮结束时调（server/tasks/turn-caps-conv.ts 的 onTurnEnd）：窗口开着就核对、关窗口、落盘。
 * 判断只看文件改了什么，不看它回复里说了什么
 */
export async function afterTurnProbe(
  sc: Pick<TasksScope, 'taskDir' | 'store' | 'deps'>,
  entry: { task: Task; rev: number },
  now = new Date(),
) {
  const task = entry.task
  const probes = task.bug?.probes ?? []
  const adding = probes.filter((p) => p.state === 'adding')
  const removing = probes.filter((p) => p.state === 'removing')
  if (!adding.length && !removing.length) return
  const dir = await sc.taskDir(task).catch(() => '')
  if (!dir) return
  for (const p of adding) await settleAdd(task, dir, p)
  if (removing.length) await settleRemove(task, dir, removing)
  for (const p of [...adding, ...removing]) p.doneAt = now.toISOString()
  entry.rev++
  await sc.store.update(task.id, task)
  if (adding.some((p) => p.state === 'added' && p.workspace))
    await autoPatch(sc, task).catch((e) => taskLog(task.id, '补排查：放到工作区出错', { error: (e as Error).message }))
}
