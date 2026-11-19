/**
 * 演示：Bug 诊断「取证」的两组接口（排查补丁放到工作区 / 还原、面板自己取日志）。
 * 演示里没有真的代码目录和日志文件：补丁只记「放了 / 还原了」，日志按报告的日志计划编一段。
 * 状态只在内存里，刷新就没了。从 demo-backend.ts 拆出（那个文件到了行数上限）
 */
import type { Task } from '@shared/schema'
import { patchFilesOf, patchKindOf, type PatchResult, type PatchStatus } from '@shared/bug/patch'
import { addRepro, markerHits, probedReady, probeFiles } from '@shared/bug/probe'
import { bugOf } from '@shared/bug/task-bug'
import {
  isAbsPath,
  logPathIn,
  relatedLines,
  type LogFetchResult,
  type LogStartResult,
  type LogWatchStatus,
} from '@shared/bug/log-watch'

const applied = new Map<string, NonNullable<PatchStatus['applied']>>()
const started = new Map<string, { path: string; at: string }>()

const statusOf = (task: Task): PatchStatus => ({
  // 和正式后端同一个条件：对话在独立分支里才有补丁这回事（演示的项目都当成 Git）
  eligible: task.worktree?.state === 'active',
  applied: applied.get(task.id),
})

function patch(task: Task, method: string, body: unknown): PatchStatus | PatchResult {
  if (method !== 'POST') return statusOf(task)
  const action = (body as { action?: string })?.action
  const done = (ok: boolean, reason: string, files: string[] = []): PatchResult => ({
    ok,
    reason,
    files,
    status: statusOf(task),
  })
  if (action === 'apply') {
    const list = task.bug?.diagnoses ?? []
    const kind = patchKindOf(list.at(-1), probedReady(task.bug))
    if (!kind) return done(false, '现在不是等你复现或验证的时候，没有要放的改动')
    if (applied.has(task.id)) return done(false, '补丁已经在你的工作区里了：先还原，再重新放')
    const files = patchFilesOf(list, kind, probeFiles(task.bug))
    if (!files.length) return done(false, '报告里没有写要放哪些文件')
    applied.set(task.id, { kind, at: new Date().toISOString(), files })
    return done(true, '', files)
  }
  const files = applied.get(task.id)?.files ?? []
  applied.delete(task.id)
  return done(true, '', files)
}

/** 编一段「新增的日志」：日志计划里每处一行带 [排查- 前缀的，前后夹几行不相关的 */
function sampleLog(task: Task): string {
  const d = task.bug?.diagnoses?.at(-1)
  const points = d?.logPlan?.length ? d.logPlan : [{ id: 'L1', file: 'src/app.ts', print: '' }]
  const lines = ['10:02:00.118 [app] route change /cart', '10:02:00.240 [net] GET /api/cart 200 38ms']
  // 补排查加好的也各打一行，复现记录里能看出「打出来了」
  for (const p of task.bug?.probes ?? [])
    if (p.state === 'added')
      lines.push(`10:02:01.2${p.id.slice(1).padStart(2, '0')} [排查-${p.id}] ${p.ask.slice(0, 40)}`)
  points.forEach((p, i) => {
    lines.push(
      `10:02:01.${String(300 + i * 7).padStart(3, '0')} [排查-演示] ${p.id || `L${i + 1}`} ${p.file} hit left=0`,
    )
    lines.push(`10:02:01.${String(304 + i * 7).padStart(3, '0')} [app] render done`)
  })
  return lines.join('\n')
}

function log(task: Task, method: string, body: unknown): LogWatchStatus | LogStartResult | LogFetchResult {
  if (method !== 'POST') return { started: started.get(task.id) }
  const d = task.bug?.diagnoses?.at(-1)
  const path = logPathIn((d?.awaiting?.collect ?? d?.collect)?.where)
  if (!path) return { ok: false, error: '报告里没有写日志文件的位置，请自己把日志贴进来' }
  if ((body as { action?: string })?.action === 'start') {
    started.set(task.id, { path, at: new Date().toISOString() })
    return { ok: true, path, size: 18_432, missing: false, outside: false }
  }
  // 没点开始复现：整个文件交出去（和正式后端一样，whole）
  const whole = started.get(task.id)?.path !== path
  const text = sampleLog(task)
  // 演示里没有真文件：编一个绝对路径和行号，假装开始复现时文件有 411 行
  const n = text.split('\n').length
  const base = whole ? 0 : 411
  const related = relatedLines(text).split('\n').filter(Boolean).length
  const abs = isAbsPath(path) ? path : `/home/demo/shop/${path}`
  return {
    ok: true,
    path,
    abs,
    size: 18_432 + text.length,
    startLine: base + 1,
    endLine: base + n,
    bytes: text.length,
    related,
    hits: markerHits(text),
    truncated: false,
    rotated: false,
    ...(whole ? { whole: true } : {}),
  }
}

export function demoEvidence(task: Task, sub: string, method: string, body: unknown, persist: () => void) {
  if (sub === 'diagnosis-patch') return patch(task, method, body)
  const r = log(task, method, body)
  // 取到日志就记一条复现记录（和正式后端同一份 shared/bug/probe.ts 的 addRepro）
  if ('endLine' in r && r.ok) {
    addRepro(bugOf(task), r, new Date().toISOString())
    persist()
  }
  return r
}
