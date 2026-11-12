/**
 * 交结论、交结果的面板工具（ADR 0041 第 16 节）：状态只认这些工具调用，不看回复里写了什么字。
 * 面板工具注册表（server/panel-tools/registry.ts）的条目
 */
import type { Orchestra } from '../shared/engine.ts'
import { str, text, type PanelTool, type ToolArgs } from './panel-tools/types.ts'

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

/** 面板工具注册表的条目：交结果给子任务、交结论给要结论的节点；dispatch 只认调用 */
export const SUBMIT_TOOLS: PanelTool[] = [
  {
    name: 'submit_result',
    when: (o) => !!o.submitResult,
    def: () => SUBMIT_RESULT,
    call: (o, a) => callSubmitTool(o, 'submit_result', a),
  },
  {
    name: 'submit_verdict',
    when: (o) => !!o.submitVerdict,
    def: () => SUBMIT_VERDICT,
    call: (o, a) => callSubmitTool(o, 'submit_verdict', a),
  },
  { name: 'dispatch', when: () => false, call: (o, a) => callSubmitTool(o, 'dispatch', a) },
]

function callSubmitTool(o: Orchestra, name: string, a: ToolArgs) {
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
  // 老会话的模型还记得主 Agent 的 dispatch 工具：主 Agent 去掉了，说清楚不悄悄吞掉
  if (name === 'dispatch') return text('工作流没有主 Agent 了，不用交决定', true)
  return text(`未知工具：${name}`, true)
}
