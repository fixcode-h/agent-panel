import { FlowRun } from '@shared/tasks/flow-schema'
import { Workflow, type Attachment, type DeliveryHow, type NewTaskInput, type Task } from '@shared/schema'
import { nodeMessagePlan, noteForNode, rerunFromNode } from '@shared/flow/node-message'
import { planTask } from '@shared/flow'
import { DEMO_STAGE_REPORTS } from './demo-stage-report'

/**
 * 演示里的工作流任务按「工作流运行」建（带 flowRun）。工作流改成独立运行后（4304d14），引擎只跑带 flowRun 的工作流任务，
 * 没带的当旧版任务直接报「不能继续执行」：演示里的工作流任务全成了失败、没有运行记录，界面检查里靠它们造数据的用例
 * （运行区的工作流行、子对话里的运行视图、节点与子 Agent）前提都不成立。演示没有真的父对话派它，归属记在请求里的父对话上；
 * 演示没有真的仓库可合回，按只读运行跑完直接完成
 */
export const demoFlowRun = (input: NewTaskInput, workflow: Workflow) =>
  FlowRun.parse({ owner: input.parentTaskId ?? '', workflowName: workflow.name, kind: 'readonly', input: input.prompt })

// 示例父对话名下的一次工作流运行（不是子对话），停在「方案」节点等你确认：
// 父对话输入框上方的工作流栏、确认（查看结果 / 追问 / 交给父对话）都有东西看
const PLAN = `## 方案：购物车角标改成订阅购物车数据

1. 角标组件不再自己缓存数量，改成订阅 \`useCart()\` 的 \`count\`。
2. 加入、删除商品后由购物车 store 统一广播，角标和结算栏同时刷新。
3. 补一条单测：连续加入两件商品后角标显示 2。`

/** 照着父对话建一条运行：项目、时间跟父对话走，节点是「方案 → 实现」，方案做完在等确认 */
export function demoOwnedRun(parent: Task, id: string): Task {
  const now = new Date().toISOString()
  // 运行用的工作流快照：右栏打开运行时流程图按它画（方案节点完成后要确认）
  const wf = Workflow.parse({
    id: 'demo-plan-first',
    createdAt: now,
    updatedAt: now,
    name: '先出方案再实现',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'plan', title: '方案', agentId: parent.agentId, x: 260, y: 0, hooks: { confirm: true } },
          { id: 'impl', title: '实现', agentId: parent.agentId, x: 520, y: 0 },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'plan' },
          { id: 'e2', from: 'plan', to: 'impl' },
          { id: 'e3', from: 'impl', to: 'end' },
        ],
      },
    ],
  })
  const steps = planTask(wf).steps
  // 报告同时记在节点上（和正式后端 submit_report 一样）：流程图节点详情底部的报告入口按它画（StageReportBar）
  Object.assign(steps[0], {
    status: 'running',
    startedAt: now,
    awaitConfirm: true,
    output: PLAN,
    submitted: { blockers: [], summary: '', left: '', at: now, reports: structuredClone(DEMO_STAGE_REPORTS) },
  })
  return {
    ...parent,
    id,
    title: '角标订阅购物车数据',
    autoTitle: false,
    mode: 'workflow',
    parentTaskId: '',
    rootTaskId: '',
    agentId: '',
    workflowName: '先出方案再实现',
    status: 'running',
    working: false,
    runSeq: 1,
    plans: [],
    // 父对话的运行记录、子任务和改动不跟过来：运行自己的那份由节点生成
    runs: [],
    todos: [],
    changes: [],
    requests: [
      {
        id: `${id}-confirm`,
        step: 'plan',
        agentId: parent.agentId,
        kind: 'confirm',
        title: '「方案」完成了，看一下结果再继续',
        detail: PLAN,
        reports: DEMO_STAGE_REPORTS,
        options: [],
        at: now,
      },
    ] as Task['requests'],
    steps,
    workflowId: wf.id,
    workflows: [wf],
    messages: [{ ...parent.messages[0], id: `${id}-m0`, text: '按「先出方案再实现」修角标不刷新', at: now }],
    flowRun: FlowRun.parse({
      owner: parent.id,
      workflowName: '先出方案再实现',
      kind: 'change',
      input: '修角标不刷新',
      phase: 'confirm',
    }),
  } as Task
}

/**
 * 演示里在流程图上选中节点直接发消息（POST /tasks/:id/messages 带 node）：判定和对运行的改动用正式后端同一份
 * （shared/flow/node-message.ts）；演示没有常驻 CLI，插话只记在节点上，答确认、重跑交给演示后端现成的做法
 */
export function demoNodeMessage(
  task: Task,
  m: { node: string; text: string; attachments: Attachment[]; messageId?: string },
  h: { answer: (reqId: string, a: { allow: boolean; answer: string }) => void; rerun: () => void },
): { error: string } | undefined {
  const plan = nodeMessagePlan(task, m.node)
  if ('error' in plan) return plan
  const at = new Date().toISOString()
  const push = (how: DeliveryHow) =>
    task.messages.push({
      id: m.messageId ?? `demo-${crypto.randomUUID()}`,
      role: 'user',
      agentId: '',
      step: plan.step.id,
      text: m.text,
      tools: [],
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
      delivery: { how, at },
      at,
    })
  const req = task.requests.find((r) => r.kind === 'confirm')
  if (plan.kind === 'revise' && req) {
    push('steer')
    h.answer(req.id, { allow: false, answer: m.text })
  } else if (plan.kind === 'steer') push('steer')
  else if (plan.kind === 'rerun') {
    if (!rerunFromNode(task, plan.step, m.text, at)) return { error: '这次运行里没有这个节点' }
    push('next')
    h.rerun()
  } else {
    noteForNode(task, plan.step, m.text, at)
    push('next-node')
  }
  return undefined
}
