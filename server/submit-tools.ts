/**
 * 交结论、交结果的面板工具（ADR 0041 第 16 节）：状态只认这些工具调用，不看回复里写了什么字。
 * 从 orch-mcp.ts 拆出来：那个文件到了行数上限
 */
import type { Orchestra } from '../shared/engine.ts'
import { toDispatch } from '../shared/dispatch.ts'

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError && { isError }) })
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * 交结论（ADR 0041 第 16 节）：验收、带条件连线的节点、评审都用它交「通过 / 不通过」，面板只认这个工具，不看回复里的字。
 * 节点和子任务都挂着：用不到的不会调用；提示词里只在要结论的地方点名它
 */
const SUBMIT_VERDICT = {
  name: 'submit_verdict',
  title: '交结论',
  description:
    '交这一步的结论：验收、评审、要选分支的节点用它。面板只按这个工具判定通过还是不通过，不看回复里写了什么。不通过时 blockers 列出必须改的地方。交完就结束这一轮。',
  inputSchema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'], description: 'pass 通过，fail 不通过' },
      blockers: {
        type: 'array',
        description: '意见：必须处置的（原来的高级 / 中级）must 写 true；建议性的写 false 或不列',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '编号，例如 R1' },
            text: { type: 'string', description: '问题和修法，一两句' },
            must: { type: 'boolean', description: '要执行的一方逐条处置' },
          },
          required: ['text'],
        },
      },
    },
    required: ['verdict'],
  },
}

/** 子任务交结果：做完 / 没做完 / 卡住，面板只按它判断子任务做完没有 */
const SUBMIT_RESULT = {
  name: 'submit_result',
  title: '交结果',
  description:
    '子任务最后交结果：做完、没做完、做不下去都要交。面板只按这个工具判断你做完没有，不看回复里写了什么。没做完时先接着做，确实停下来才交 unfinished；交完就结束这一轮。',
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['done', 'unfinished', 'stuck'],
        description: 'done 做完；unfinished 没做完；stuck 做不下去（缺信息、缺权限、方向不对）',
      },
      summary: { type: 'string', description: '结论和关键文件，几句话；派你的 Agent 按它接着做' },
      left: { type: 'string', description: '没做完时还差什么；卡住时卡在哪、需要什么' },
    },
    required: ['state', 'summary'],
  },
}

/** 主 Agent 交决定：流程怎么走只认它（原来读回复里的 dispatch 代码块） */
const DISPATCH = {
  name: 'dispatch',
  title: '交决定',
  description:
    '主 Agent 交这一轮的决定：评估节点后继续 / 退回 / 委派 / 停下，对话的第一条或新要求时起运行 / 重做 / 只回答。面板只按这个工具决定流程怎么走，不看回复里写了什么。交完就结束这一轮。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['continue', 'rework', 'delegate', 'stop', 'run', 'restart', 'answer'],
        description: '决定',
      },
      branch: { type: 'string', enum: ['pass', 'fail'], description: 'continue 时后面有条件连线必须写：选哪条路' },
      note: { type: 'string', description: 'continue 时给后续节点交代的要点' },
      feedback: { type: 'string', description: 'rework / restart：哪里要改' },
      workflow: { type: 'string', description: 'delegate：交给哪个工作流（id）' },
      input: { type: 'string', description: 'delegate / run：交给它的任务' },
      reason: { type: 'string', description: 'stop：为什么停下' },
    },
    required: ['action'],
  },
}

/** 这个调用者能用的交结论 / 交结果 / 交决定工具 */
export function submitTools(o: Orchestra) {
  return [
    ...(o.submitResult ? [SUBMIT_RESULT] : []),
    ...(o.submitVerdict ? [SUBMIT_VERDICT] : []),
    ...(o.submitDispatch ? [DISPATCH] : []),
  ]
}

// oxlint-disable-next-line no-explicit-any -- MCP 的参数就是任意 JSON，和 orch-mcp.ts 的 callOrchTool 一样
export function callSubmitTool(o: Orchestra, name: string, a: any) {
  if (name === 'submit_verdict') {
    if (!o.submitVerdict) return text('这里不用交结论', true)
    const v = str(a?.verdict).trim().toLowerCase()
    if (v !== 'pass' && v !== 'fail') return text('verdict 只能是 pass 或 fail', true)
    const blockers = (Array.isArray(a?.blockers) ? a.blockers : [])
      .filter((b: unknown) => b && typeof b === 'object')
      .map((b: { id?: unknown; text?: unknown; must?: unknown }) => ({
        id: str(b.id).trim(),
        text: str(b.text).trim(),
        must: b.must === true,
      }))
      .filter((b: { text: string }) => b.text)
    const r = o.submitVerdict({ verdict: v, blockers })
    return text(r.info, !r.ok)
  }
  if (name === 'submit_result') {
    if (!o.submitResult) return text('只有子任务要交结果', true)
    const state = str(a?.state).trim().toLowerCase()
    if (state !== 'done' && state !== 'unfinished' && state !== 'stuck')
      return text('state 只能是 done、unfinished 或 stuck', true)
    const summary = str(a?.summary).trim()
    if (!summary) return text('summary 是空的：写结论和关键文件', true)
    const r = o.submitResult({ state, summary, left: str(a?.left).trim() })
    return text(r.info, !r.ok)
  }
  if (name === 'dispatch') {
    if (!o.submitDispatch) return text('只有主 Agent 交决定', true)
    const d = a && typeof a === 'object' ? toDispatch(a) : null
    if (!d)
      return text(
        '认不出这个决定：action 只能是 continue、rework、delegate、stop、run、restart、answer，delegate 要写 workflow',
        true,
      )
    const r = o.submitDispatch(d)
    return text(r.info, !r.ok)
  }
  return text(`未知工具：${name}`, true)
}
