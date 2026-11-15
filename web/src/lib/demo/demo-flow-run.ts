import { FlowRun } from '@shared/tasks/flow-schema'
import { Workflow, type NewTaskInput, type Task } from '@shared/schema'
import { planTask } from '@shared/flow'

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
  Object.assign(steps[0], { status: 'running', startedAt: now, awaitConfirm: true, output: PLAN })
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
