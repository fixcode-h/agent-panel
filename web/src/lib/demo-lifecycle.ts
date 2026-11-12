import { demoJobs } from './demo/demo-jobs'
import type { Task } from '@shared/schema'
import {
  countDone,
  countEvents,
  parseLogLine,
  verdictOf,
  type LifeFacts,
  type LogLine,
  type LifeNode,
  type LifeReport,
} from '@shared/lifecycle'
import { lifeWordFacts } from '@shared/life-next'
import { subtreeTaskIds } from '@shared/run-usage'
import { convActive, taskState } from '@shared/task'
import { descendantNeeds } from '@shared/child-needs'

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
  // 和正式后端一样按界面拿到的那一份算状态和短词：补上名下子对话在跑 / 在等你的数
  const needs = descendantNeeds(tasks)
  const shownOf = (tk: Task) => ({
    ...tk,
    childrenNeeds: needs.get(tk.id) ?? 0,
    // 正式后端只给顶层对话补在跑的子对话数（见 server/tasks/children.ts 的 withLive）
    ...(!tk.parentTaskId && {
      childrenWorking: tasks.filter((k) => k.parentTaskId === tk.id && convActive(taskState(k))).length,
    }),
  })
  for (const tk of list) {
    const shown = shownOf(tk)
    const alive = !!tk.working || !!tk.awaitingUser
    const facts: LifeFacts = {
      kind: 'conversation',
      status: tk.status,
      stopReason: tk.stopReason,
      state: taskState(shown),
      working: !!tk.working,
      awaitingUser: !!tk.awaitingUser,
      resolved: tk.resolved === true,
      live: tk.status === 'running' ? { stop: false } : undefined,
      held: 0,
      cliAlive: alive,
      helpers: tk.steps.filter((s) => s.slot === 'sub' && (s.status === 'running' || s.status === 'pending')).length,
      jobs: demoJobs(tk).length,
      waitsOn: [],
      trace: tk.working ? { requests: 11, requestAt: now - 54_000, lastOutputAt: now - 60_000 } : undefined,
      exit: alive ? undefined : { at: now - 600_000, code: 0, aliveMs: 240_000 },
      ...lifeWordFacts(shown),
    }
    // 已经退出的：整段往前挪，退出那一行排在最后
    const shift = alive ? 0 : 600_000
    const at = (ago: number) => new Date(now - ago - shift).toISOString().replace('T', ' ').replace('Z', '')
    // 一轮里十来次模型请求：首字等待几百毫秒，偶尔一次慢的；在执行的最后一次还没回
    const log = [`${at(240_000)} [CLI 进程启动] pid=${pid}`]
    const waits = [820, 540, 610, 380, 1240, 450, 6200, 520, 300, 470]
    waits.forEach((w, i) => {
      const t0 = 230_000 - i * 17_000
      // 中间有一轮计划没做完就停了，面板推它接着做（状态里的「面板提醒」数的就是这种行），按时间排在第 9 次请求前面
      if (i === 8) log.push(`${at(100_000)} [计划推进] action=continue nth=1 max=6 done=2 total=5`)
      log.push(`${at(t0)} [模型请求开始] n=${i + 1}`)
      log.push(`${at(t0 - w)} [模型开始输出] n=${i + 1} waitedMs=${w} kind=${i % 3 ? 'thinking' : 'text_delta'}`)
    })
    if (tk.working) {
      log.push(`${at(74_000)} [CLI 重试模型请求] attempt=1 error="529 overloaded"`)
      log.push(`${at(54_000)} [模型请求开始] n=${waits.length + 1}`)
    } else log.push(`${at(0)} [CLI 进程退出] pid=${pid} code=0 aliveMs=240000`)
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
      log,
      counts: countDone(
        countEvents(log.map(parseLogLine).filter((x): x is LogLine => !!x)),
        alive ? [] : [{ at: new Date(Date.parse(at(1_000).replace(' ', 'T'))).toISOString(), outcome: 'done' }],
      ),
      // 面板提醒和结束交代：日志按本地时间写，这里按同样的读法换回时间点，和日志里那行「计划推进」对得上
      trail: [
        {
          at: new Date(Date.parse(at(100_000).replace(' ', 'T'))).toISOString(),
          kind: 'nudge' as const,
          text: '计划还有 3 步没做完，接着做下一步。',
          tools: 4,
        },
        ...(alive
          ? []
          : [
              {
                at: new Date(Date.parse(at(1_000).replace(' ', 'T'))).toISOString(),
                kind: 'end' as const,
                outcome: 'done' as const,
                hidden: '角标改成订阅购物车 store 的变化，刷新问题已修好，单测也补上了。',
              },
            ]),
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
        counts: countEvents([]),
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
