/**
 * 演示：Bug 诊断「取证」的两组接口（排查补丁放到工作区 / 还原、面板自己取日志）。
 * 演示里没有真的代码目录和日志文件：补丁只记「放了 / 还原了」，日志按报告的日志计划编一段。
 * 状态只在内存里，刷新就没了。从 demo-backend.ts 拆出（那个文件到了行数上限）
 */
import type { Task } from '@shared/schema'
import { patchFilesOf, patchKindOf, type PatchResult, type PatchStatus } from '@shared/bug/patch'
import {
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
    const kind = patchKindOf(list.at(-1))
    if (!kind) return done(false, '现在不是等你复现或验证的时候，没有要放的改动')
    if (applied.has(task.id)) return done(false, '补丁已经在你的工作区里了：先还原，再重新放')
    const files = patchFilesOf(list, kind)
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
  if (!started.has(task.id)) return { ok: false, error: '还没有点「开始复现」：面板不知道从哪里开始算新增的日志' }
  const text = sampleLog(task)
  return { ok: true, path, text, related: relatedLines(text), bytes: text.length, truncated: false, rotated: false }
}

export function demoEvidence(task: Task, sub: string, method: string, body: unknown) {
  return sub === 'diagnosis-patch' ? patch(task, method, body) : log(task, method, body)
}
