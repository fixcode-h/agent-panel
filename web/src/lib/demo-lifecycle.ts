import type { Task } from '@shared/schema'
import { verdictOf, type LifeFacts, type LifeNode, type LifeReport } from '@shared/lifecycle'
import { subtreeTaskIds } from '@shared/run-usage'
import { taskState } from '@shared/task'

/**
 * 在线演示的状态诊断：没有真的 CLI 进程和日志，按演示任务的状态编一份结构一样的报告（字段和正式后端一致），
 * 判定照样走 shared/lifecycle.ts 的 verdictOf。在执行的对话画成「等模型回复」卡了一阵，好看清弹窗怎么说
 */
export function demoLifecycle(task: Task, tasks: Task[]): LifeReport {
  const now = Date.now()
  const ids = subtreeTaskIds(tasks, task.id)
  const list = tasks.filter((x) => ids.has(x.id))
  const nodes: LifeNode[] = []
  let pid = 41200
  for (const tk of list) {
    const alive = !!tk.working || !!tk.awaitingUser
    const facts: LifeFacts = {
      kind: 'conversation',
      status: tk.status,
      stopReason: tk.stopReason,
      state: taskState(tk),
      working: !!tk.working,
      awaitingUser: !!tk.awaitingUser,
      resolved: tk.resolved === true,
      live: tk.status === 'running' ? { stop: false } : undefined,
      held: 0,
      cliAlive: alive,
      helpers: tk.steps.filter((s) => s.slot === 'sub' && (s.status === 'running' || s.status === 'pending')).length,
      jobs: tk.jobs?.length ?? 0,
      waitsOn: [],
      trace: tk.working ? { requests: 3, requestAt: now - 54_000 } : undefined,
      exit: alive ? undefined : { at: now - 600_000, code: 0, aliveMs: 240_000 },
    }
    // 已经退出的：整段往前挪，退出那一行排在最后
    const shift = alive ? 0 : 600_000
    const at = (ago: number) => new Date(now - ago - shift).toISOString().replace('T', ' ').replace('Z', '')
    nodes.push({
      id: tk.id,
      parentId: tk.parentTaskId && ids.has(tk.parentTaskId) ? tk.parentTaskId : undefined,
      taskId: tk.id,
      title: tk.title,
      kind: 'conversation',
      cli: tk.sessionCli || 'claude',
      viewer: { viewing: tk.id === task.id, watched: tk.id === task.id },
      facts,
      verdict: verdictOf(facts, now),
      processes: alive
        ? [
            {
              pid: pid++,
              startedAt: now - 240_000,
              rss: 186 * 1048576,
              command: 'claude -p --output-format stream-json …',
            },
          ]
        : [],
      log: [
        `${at(240_000)} [CLI 进程启动] pid=${pid}`,
        `${at(230_000)} [模型请求开始] n=1`,
        `${at(222_000)} [模型开始输出] n=1 waitedMs=8000 kind=text_delta`,
        ...(tk.working
          ? [`${at(54_000)} [模型请求开始] n=3`]
          : [`${at(0)} [CLI 进程退出] pid=${pid} code=0 aliveMs=240000`]),
      ],
    })
    for (const s of tk.steps.filter((x) => x.slot === 'sub')) {
      const sf: LifeFacts = {
        kind: 'helper',
        status:
          s.status === 'running' || s.status === 'pending' ? 'running' : s.status === 'failed' ? 'failed' : 'done',
        working: s.status === 'running',
        awaitingUser: false,
        interrupted: !!s.interrupted,
        held: 0,
        cliAlive: s.status === 'running',
        helpers: 0,
        jobs: 0,
        waitsOn: [],
      }
      nodes.push({
        id: `${tk.id}#${s.id}`,
        parentId: tk.id,
        taskId: tk.id,
        stepId: s.id,
        title: s.title,
        kind: 'helper',
        facts: sf,
        verdict: verdictOf(sf, now),
        processes: [],
        log: [],
      })
    }
  }
  return {
    format: 'agent-panel-lifecycle/1',
    generatedAt: new Date(now).toISOString(),
    panel: { version: 'demo', platform: 'web', node: '', pid: 0 },
    settings: {},
    rootId: task.id,
    nodes,
  }
}
