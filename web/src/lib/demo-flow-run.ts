// 演示数据：示例父对话名下的一次工作流运行（不是子对话），停在「方案」节点等你确认，
// 父对话输入框上方的工作流栏、确认（查看结果 / 追问 / 交给父对话）都有东西看。从 demo-backend.ts 拆出（那个文件到了行数上限）
import { Workflow, type Task } from '@shared/schema'
import { FlowRun } from '@shared/task-flow-schema'
import { planTask } from '@shared/flow'

const PLAN = `## 方案：购物车角标改成订阅购物车数据

1. 角标组件不再自己缓存数量，改成订阅 \`useCart()\` 的 \`count\`。
2. 加入、删除商品后由购物车 store 统一广播，角标和结算栏同时刷新。
3. 补一条单测：连续加入两件商品后角标显示 2。`

/** 照着父对话建一条运行：项目、时间跟父对话走，节点是「方案 → 实现」，方案做完在等确认 */
export function demoFlowRun(parent: Task, id: string): Task {
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
