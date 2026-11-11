/**
 * 面板工具 end_turn（这一轮怎么结束）：定义和调用拆在这里，orch-mcp.ts 到了行数上限。
 * 判定在 shared/end-turn.ts，结束前钩子和一轮结束后的提醒只认它（设计稿 docs/openspec/changes/end-check-signal/design-v2.md）
 */
import type { Orchestra } from '../shared/engine.ts'
import { END_TURN_TOOL } from '../shared/end-turn.ts'

export const END_TURN_DEF = {
  name: END_TURN_TOOL,
  title: '结束这一轮',
  description:
    '这一轮的事做完了、或者做不下去时调用，面板只按它判断这一轮结束了，不看你写了什么。做完了：先写好结论或总结，再调用 end_turn（outcome: done）作为最后一个动作，之后必须用一句话简短说明收尾，不要重复总结；计划没做完、子对话改了文件还没 submit_merge 时会被拒绝。做不下去：outcome: blocked，need 写缺什么、需要用户做什么；能写出具体步骤让用户去做（跑一次、复现、给日志或文件）的用 request_user_action，不用 blocked。要用户在几个做法里选时用 suggest_next_step，在等后台命令、子对话、子任务的结果或等用户操作时直接结束这一轮，这几种不用调用 end_turn。',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['done', 'blocked'],
        description: 'done：这次的事做完了；blocked：做不下去，需要用户给东西',
      },
      need: { type: 'string', description: 'outcome 为 blocked 时必填：缺什么、需要用户做什么才能继续' },
    },
    required: ['outcome'],
  },
}

/** 执行一次 end_turn：没有这个工具（子任务、工作流节点、Chat 页）时报错 */
export async function callEndTurn(o: Orchestra, a: { outcome?: unknown; need?: unknown } | undefined) {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const r = o.endTurn
    ? await o.endTurn(str(a?.outcome).trim(), str(a?.need))
    : { ok: false, info: '这里不用 end_turn：做完直接结束这一轮（子任务、工作流节点按各自的 submit_* 交结果）' }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}
