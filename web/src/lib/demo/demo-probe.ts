/**
 * 演示：补排查（shared/bug/probe-start.ts 和正式后端同一份开窗口逻辑）。演示里没有真的代码目录，
 * 不拍快照、不逐行核对：开了窗口马上按「加好了」记一处（文件取用户点的那一跳或调用栈第一跳），撤掉马上记成撤掉。
 * 从 demo-evidence.ts 分出来，免得那个文件越写越长
 */
import type { Task } from '@shared/schema'
import { removable } from '@shared/bug/probe'
import { retryProbe, startProbe } from '@shared/bug/probe-start'
import { bugProbeContract } from '@shared/api-contract/bug-probe'
import { fail } from './demo-http'

/** 模拟 Agent 加好：记一处，带几行（调试绘制多几行） */
function settle(task: Task) {
  const d = task.bug?.diagnoses?.at(-1)
  for (const p of task.bug?.probes ?? []) {
    if (p.state !== 'adding') continue
    const hop = d?.stack.find((h) => p.targets.some((x) => x.startsWith(`${h.id} `))) ?? d?.stack.find((h) => h.file)
    p.spots = [{ file: hop?.file || 'src/app.ts', line: hop?.line ?? 1, lines: p.kind === 'draw' ? 7 : 2 }]
    p.problems = []
    p.state = 'added'
    p.doneAt = new Date().toISOString()
  }
}

export function demoProbe(task: Task, sub: string, body: unknown, persist: () => void) {
  if (sub === 'bug-probe') {
    const input = bugProbeContract.start.body.safeParse(body)
    if (!input.success) return fail('参数不对')
    const r = startProbe(task, input.data)
    if (!r.ok) return fail(r.error, 409)
    settle(task)
    persist()
    return { task, message: r.message }
  }
  const input = bugProbeContract.action.body.safeParse(body)
  if (!input.success) return fail('参数不对')
  if (input.data.action === 'retry') {
    const r = retryProbe(task, input.data.ids[0] ?? '')
    if (!r.ok) return fail(r.error, 409)
    settle(task)
    persist()
    return { task, message: r.message }
  }
  const ids = input.data.ids
  const list = (task.bug?.probes ?? []).filter((p) => removable(p) && (!ids.length || ids.includes(p.id)))
  if (!list.length) return fail('没有能撤的临时代码', 409)
  for (const p of list) {
    p.state = 'removed'
    p.doneAt = new Date().toISOString()
  }
  persist()
  return { task, message: `用户要撤掉补排查加的临时代码：${list.map((p) => p.id).join('、')}` }
}

/** 取消修复前「查到的临时代码」：演示里没有真文件，按补排查记下的位置列（每处一行标记） */
export const demoProbeFound = (task: Task) =>
  (task.bug?.probes ?? [])
    .filter((p) => p.state !== 'removed')
    .flatMap((p) =>
      p.spots.map((s) => ({ file: s.file, line: s.line, text: `// [排查-${p.id}] ${p.ask.slice(0, 40)}` })),
    )
