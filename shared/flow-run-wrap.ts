/**
 * 工作流运行的固定收尾（docs/openspec/changes/workflow-runs/design.md 第 3.4 节，D2）：改代码的运行跑完流程图后，
 * 面板在流程图末尾接一个「收尾」节点——执行角色补齐、提交改动；节点的验收流程是「评审 → 测试」，不通过时意见交回
 * 收尾节点修，修完再评审、再测，最多 maxRounds 轮，超过按节点失败停下等父对话决定。都过了运行停在待合回。
 * 不另写一套执行：用的就是节点的验收回路（engine.ts 的 review），这里只负责把节点和验收流程拼进运行的工作流快照。
 */
import { END, Flow, FlowNode, type Workflow } from './schema.ts'

/** 收尾节点和它的验收流程的 id：固定的，界面、进度按它认 */
export const WRAP_NODE = 'wrapup'
export const WRAP_FLOW = 'wrapup-review'

/** 收尾的修复最多几轮（评审或测试不通过算一轮） */
export const WRAP_ROUNDS = 3

const WRAP_TEXT = `工作流的节点都做完了，现在是运行的收尾。
1. 对照这次运行的需求检查改动是否完整：没做完的补上，明显的问题修掉；不做和这次需求无关的改动。
2. 把改动提交到当前分支（git add、git commit，提交说明写清这次运行做了什么）。
之后面板会安排评审和测试；不通过时意见会交回给你，按意见修好、再提交。最后简要总结改了什么。`

const REVIEW_TEXT = `评审这次运行在当前分支上的全部改动（和运行开始时比）：是否满足需求、有没有明显的缺陷、遗漏和不该有的改动。
用 submit_verdict 交结论：没有阻断问题交 pass；有必须修的问题交 fail，并把每个问题写成 blockers。`

const TEST_TEXT = `按项目的测试步骤，跑这次运行的改动影响到的测试和编译。
用 submit_verdict 交结论：全部通过交 pass；有失败交 fail，把失败的命令和关键输出写进 blockers。`

/** 收尾用到的角色：执行（修和提交）、评审、测试；项目里没有的那一项就不排 */
export interface WrapRoles {
  worker?: string
  reviewer?: string
  tester?: string
}

/** 按内置来源找角色 id（停用的不算） */
export function wrapRoles(agents: { id: string; origin?: string; enabled?: boolean }[]): WrapRoles {
  const of = (origin: string) => agents.find((a) => a.origin === origin && a.enabled !== false)?.id
  return { worker: of('builtin:worker'), reviewer: of('builtin:reviewer'), tester: of('builtin:tester') }
}

/**
 * 给工作流的入口流程接上收尾：原来连到「结束」的线都改连到收尾节点，收尾节点再连到「结束」。
 * 已经接过（续跑、重读快照）原样返回；没有执行角色时不接（没人能修，交回父对话自己看）
 */
export function withWrapUp(w: Workflow, roles: WrapRoles): Workflow {
  const entry = w.flows.find((f) => f.id === w.entryFlowId) ?? w.flows[0]
  if (!entry || !roles.worker || entry.nodes.some((n) => n.id === WRAP_NODE)) return w
  const checks = [
    roles.reviewer &&
      FlowNode.parse({ id: 'review', title: '评审', agentId: roles.reviewer, instructions: REVIEW_TEXT }),
    roles.tester && FlowNode.parse({ id: 'test', title: '测试', agentId: roles.tester, instructions: TEST_TEXT }),
  ].filter((n) => !!n)
  // 评审不通过就不用测了：评审到测试的线只在通过时走
  const chain = ['start', ...checks.map((n) => n.id), END]
  const reviewFlow = Flow.parse({
    id: WRAP_FLOW,
    name: '收尾评审',
    nodes: checks.map((n, i) => ({ ...n, x: 200 + i * 220, y: 0 })),
    edges: [
      ...chain.slice(1).map((to, i) => ({
        id: `w${i}`,
        from: chain[i],
        to,
        ...(i > 0 && to !== END ? { when: 'pass' as const } : {}),
      })),
      // 评审不通过直接走到结束：评审意见才会作为验收流程的结果交回收尾节点（停在半路的流程没有输出）
      ...(checks.length > 1 ? [{ id: 'w_fail', from: checks[0].id, to: END, when: 'fail' as const }] : []),
    ],
  })
  const right = Math.max(0, ...entry.nodes.map((n) => n.x))
  const wrap = FlowNode.parse({
    id: WRAP_NODE,
    title: '收尾',
    agentId: roles.worker,
    instructions: WRAP_TEXT,
    x: right + 240,
    y: 0,
    hooks: {
      start: null,
      review: checks.length ? { kind: 'sub', id: WRAP_FLOW } : null,
      end: null,
      maxRounds: WRAP_ROUNDS,
    },
  })
  const flow = {
    ...entry,
    nodes: [...entry.nodes, wrap],
    edges: [
      ...entry.edges.map((e) => (e.to === END ? { ...e, to: WRAP_NODE } : e)),
      { id: 'e_wrapup_end', from: WRAP_NODE, to: END },
    ],
    endPos: { ...entry.endPos, x: Math.max(entry.endPos.x, right + 480) },
  }
  return {
    ...w,
    flows: [...w.flows.map((f) => (f.id === entry.id ? flow : f)), ...(checks.length ? [reviewFlow] : [])],
  }
}
