/**
 * 取消修复后删临时日志（用户 2026-11-10 定，规则和核对在 shared/bug/cleanup.ts）：
 * - 用户同意加日志时，给日志计划里的文件拍快照（logBase，内容存对话目录的 log-base/，只用来核对）；
 * - 用户点「取消修复」时只读地查出 `[排查-` 日志（previewCleanup），交给 Agent 删；
 * - 子对话这一轮结束时核对（checkCleanup）：通过了关闭报告、收口计划，没过记下来等用户决定。
 * 面板只查不删：不做一键删除，也不拿快照还原文件
 */
import { bugOf } from '../../shared/bug/task-bug.ts'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Task } from '../../shared/schema.ts'
import type { CleanupState, Diagnosis } from '../../shared/bug/diagnosis-schema.ts'
import { checkFile, fileClean, tempLogLines, type FileLine } from '../../shared/bug/cleanup.ts'
import { cleanupFiles, cleaning, evidenceFiles, logFilesOf, phaseOf, planApproved } from '../../shared/bug/phase.ts'
import { settleCleanup } from '../../shared/bug/diagnosis.ts'
import { projectChanges } from '../exec/file-events.ts'
import { gitExec } from '../exec/git.ts'
import { TASK_FILES_DIR } from '../store.ts'
import type { TasksScope } from './scope.ts'

/** 快照里「加日志之前这个文件还不存在」的记号 */
const ABSENT = 'absent'

const baseDir = (taskId: string) => path.join(TASK_FILES_DIR, taskId, 'log-base')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const inside = (dir: string, file: string) => {
  const p = path.resolve(dir, file)
  const r = path.relative(dir, p)
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : ''
}
const read = (dir: string, file: string) => {
  const p = inside(dir, file)
  return p ? readFile(p, 'utf8').catch(() => undefined) : Promise.resolve(undefined)
}

/** 存一份内容，返回哈希（同样的内容只存一份） */
async function keep(taskId: string, content: string): Promise<string> {
  const h = sha(content)
  await mkdir(baseDir(taskId), { recursive: true })
  const f = path.join(baseDir(taskId), `${h}.txt`)
  await stat(f).catch(() => writeFile(f, content))
  return h
}

async function load(taskId: string, h: string | undefined): Promise<string | undefined> {
  if (!h) return undefined
  if (h === ABSENT) return ''
  return readFile(path.join(baseDir(taskId), `${h}.txt`), 'utf8').catch(() => undefined)
}

/**
 * 用户同意加日志：给这一版日志计划里的文件拍快照。已经拍过的不再拍（多轮论证时保留最早那份，
 * 那才是「加日志之前」）
 */
export async function snapshotLogBase(task: Task, dir: string, d: Diagnosis) {
  if (!dir || phaseOf(d) !== 'evidence') return
  const base = (bugOf(task).logBase ??= {})
  for (const file of evidenceFiles(d)) {
    if (file in base || !inside(dir, file)) continue
    const content = await read(dir, file)
    base[file] = content === undefined ? ABSENT : await keep(task.id, content)
  }
}

/** 点取消时给用户看、交给 Agent 的东西：查到的临时日志、这个对话新建的项目文件（可以勾上一起删） */
export type CleanupPreview = { found: FileLine[]; created: string[]; isolated: boolean }

/** 这个对话改过的项目文件里，哪些是新建的（版本库里没有）：只认 git，查不了就不列 */
async function createdFiles(dir: string, files: string[]): Promise<string[]> {
  if (!files.length) return []
  const tracked = await gitExec(dir, ['ls-files', '--', ...files], { maxBuffer: 1 << 20 })
    .then((r) => new Set(r.stdout.split('\n').map((x) => x.trim().replace(/\\/g, '/'))))
    .catch(() => undefined)
  if (!tracked) return []
  const out: string[] = []
  for (const f of files) if (!tracked.has(f) && (await stat(path.join(dir, f)).catch(() => null))) out.push(f)
  return out
}

/** 只读地查：日志计划里的文件和这个对话改过的项目文件，逐个找 `[排查-` 的行（文档里提到前缀的不算） */
export async function previewCleanup(task: Task, dir: string): Promise<CleanupPreview> {
  if (!dir) return { found: [], created: [], isolated: false }
  const changed = projectChanges(task.changes ?? [], dir).map((c) => c.path.replace(/\\/g, '/'))
  const files = [...new Set([...logFilesOf(task.bug?.diagnoses ?? []), ...changed])].filter((f) => !f.endsWith('.md'))
  const found: FileLine[] = []
  for (const f of files) {
    const content = await read(dir, f)
    if (content !== undefined) found.push(...tempLogLines(f, content))
  }
  const created = await createdFiles(
    dir,
    changed.filter((f) => !f.endsWith('.md') && !found.some((x) => x.file === f)),
  )
  return { found, created, isolated: task.worktree?.state === 'active' }
}

/** 点取消那一刻各文件的内容：核对「删多了」时和快照比（修复改动不算删多） */
export async function snapshotPre(task: Task, dir: string, files: string[]): Promise<Record<string, string>> {
  const pre: Record<string, string> = {}
  for (const f of files) {
    const content = await read(dir, f)
    if (content !== undefined) pre[f] = await keep(task.id, content)
  }
  return pre
}

/**
 * 子对话这一轮结束：在删临时日志的话，核对删干净了没有。改了 task 返回 true（调用方落盘）。
 * 还没修过逻辑（没有确认过的方案），或者用户要求修复也撤掉：删完要和快照一模一样
 */
export async function checkCleanup(task: Task, dir: string, newId: () => string): Promise<boolean> {
  const d = task.bug?.diagnoses?.at(-1)
  if (!d || !cleaning(d) || d.cleanup?.state !== 'running' || !dir) return false
  const c = d.cleanup as CleanupState
  const strict = c.revertFix || !planApproved(task.bug?.diagnoses ?? [])
  const failed: CleanupState['failed'] = []
  const files = cleanupFiles(d).filter((f) => !c.drop.includes(f))
  for (const f of files) {
    const now = (await read(dir, f)) ?? ''
    const base = await load(task.id, task.bug?.logBase?.[f])
    const r = checkFile(f, now, { base, pre: await load(task.id, c.pre[f]), strict })
    if (!fileClean(r)) failed.push(r)
  }
  const kept: string[] = []
  for (const f of c.drop) if (await stat(path.join(dir, f)).catch(() => null)) kept.push(f)
  return settleCleanup(task, { state: failed.length || kept.length ? 'failed' : 'done', failed, kept }, newId)
}

/**
 * 子对话这一轮结束时调（server/tasks/run.ts 的 onTurnEnd）：核对、落盘；关闭了报告就回报父对话
 * （父对话要知道这是「用户取消了修复」，不是「交付完了」，见 shared/task.ts 的 childStatus）
 */
export async function afterTurnCleanup(
  sc: Pick<TasksScope, 'taskDir' | 'store' | 'reportToParent'>,
  entry: { task: Task; rev: number },
  newId: () => string,
) {
  const d = entry.task.bug?.diagnoses?.at(-1)
  if (!d || d.cleanup?.state !== 'running') return
  const changed = await checkCleanup(entry.task, await sc.taskDir(entry.task), newId)
  if (!changed) return
  entry.rev++
  await sc.store.update(entry.task.id, entry.task)
  if (entry.task.bug?.diagnoses?.at(-1)?.cleanup?.state !== 'failed' && entry.task.parentTaskId)
    await sc.reportToParent(entry.task)
}
