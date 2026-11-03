/**
 * 一次工作流运行的记录和它的共享状态、节点之间的消息（从 shared/engine.ts 拆出来：那个文件到了行数上限，
 * 这块是自成一体的读写，不依赖执行流程）。read_state / write_state / send_message / read_messages 的底层
 */
import { currentRun } from './flow.ts'
import type { RunMessage, RunStateEntry, Task, TaskRun, Workflow } from './schema.ts'
import type { EngineHost } from './engine.ts'
import { clip } from './text.ts'

const now = () => new Date().toISOString()

/** 这次运行的工作流运行记录（新架构按运行隔离共享状态和消息）；旧任务没有 */
export function runRecord(task: Task): TaskRun | undefined {
  const run = currentRun(task)
  return (task.runs ?? []).find((r) => r.id === run)
}

/** 这次运行里所有节点共享的键值状态 */
export function runState(task: Task): Record<string, RunStateEntry> {
  return runRecord(task)?.state ?? {}
}

/** 交给节点的共享状态快照：并发节点开始前读一次，执行中也可以用 read_state 再读 */
export function statePart(task: Task) {
  // 只注入「这一次还在跑的运行」的状态：对话里跑过工作流之后 task.runs 留着上一次运行，
  // 再注入旧状态会误导模型，而对话模式根本没注册 read_state / write_state（提示里也不能提）
  const rec = runRecord(task)
  if (!rec || rec.status !== 'running') return ''
  const entries = Object.entries(rec.state)
  if (!entries.length) return ''
  const lines = entries.slice(0, 50).map(([k, v]) => {
    const who = v.by || '未知节点'
    return `- ${k}（v${v.version}，${who} 写入）：${clip(v.value, 1200)}`
  })
  return `## 共享状态\n这是本次运行里所有节点共同维护的状态，可以用 read_state / write_state 读写；写之前先看版本，别覆盖别人刚写的内容：\n${clip(lines.join('\n'), 12000)}`
}

/** 这次运行的记录：新架构在启动运行时建；旧版工作流任务也在开始执行时补一条，共享状态和消息才有地方存 */
export function ensureTaskRun(host: EngineHost, workflow: Workflow, run: number, skillSlots = host.task.skillSlots) {
  const has = host.task.runs.find((r) => r.id === run)
  if (has) return has
  const rec: TaskRun = {
    id: run,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflows: host.workflows.length ? host.workflows : [workflow],
    skillSlots,
    status: 'running',
    startedAt: now(),
    endedAt: '',
    state: {},
    messages: [],
  }
  host.task.runs.push(rec)
  return rec
}

/** 写共享状态：版本号加一，后写的覆盖先写的 */
export function writeRunState(host: EngineHost, by: string, key: string, value: string) {
  const rec = runRecord(host.task)
  if (!rec) return { ok: false, info: '这次运行没有共享状态（可能是旧版对话），直接写在结果里交给下游节点' }
  const k = key.trim().slice(0, 80)
  if (!k) return { ok: false, info: 'key 不能为空' }
  const old = rec.state[k]
  const version = (old?.version ?? 0) + 1
  rec.state[k] = { value: clip(value, 20000), version, by, at: now() }
  host.changed(true)
  return { ok: true, version, info: `已写入「${k}」v${version}` }
}

/** 一次运行的收件箱：没读过的消息，读完记下来，历史仍留在运行记录里 */
export function runMail(host: EngineHost, id: string) {
  const rec = runRecord(host.task)
  if (!rec) return []
  const got = rec.messages.filter((m) => m.to === id && !m.read)
  for (const m of got) m.read = true
  if (got.length) host.changed()
  return got.map((m) => m.text)
}

/** 节点之间发消息：并发节点执行中能互相提醒，消息按运行保存，重启后还能看到 */
export function sendRunMessage(host: EngineHost, from: string, to: string, text: string) {
  const rec = runRecord(host.task)
  if (!rec) return false
  const msg: RunMessage = { id: host.newId(), from, to, text: clip(text, 20000), read: false, at: now() }
  rec.messages.push(msg)
  host.changed(true)
  return true
}
