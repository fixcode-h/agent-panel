/**
 * 面板工具 end_turn（这一轮怎么结束）：定义、用法说明和调用都在这里（面板工具注册表的条目）。
 * 判定在 shared/end-turn.ts，结束前钩子和一轮结束后的提醒只认它（设计稿 docs/openspec/changes/end-check-signal/design-v2.md）
 */
import type { Orchestra } from '../../shared/engine/host.ts'
import { END_TURN_TOOL } from '../../shared/end-turn.ts'
import type { PanelTool } from './types.ts'

/** 父对话才有的 own：执行中用户插话里是对它自己这件事的调整、不用转给子对话的那几条（shared/orchestra/steer-pending.ts） */
const OWN_FIELD = {
  own: {
    type: 'array',
    items: { type: 'string' },
    description:
      '只有父对话写：执行中用户插的话里，是对你自己这件事的调整、不用转给子对话的那几条消息 id（插话说明里给了 id；最近一条写 "last"）。转给子对话的用 send_to_conversation 的 quote，不写在这里',
  },
}

const END_TURN_DEF = {
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
async function callEndTurn(o: Orchestra, a: { outcome?: unknown; need?: unknown; own?: unknown } | undefined) {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const own = Array.isArray(a?.own) ? a.own.map(String).filter(Boolean) : undefined
  const r = o.endTurn
    ? await o.endTurn(str(a?.outcome).trim(), str(a?.need), own)
    : { ok: false, info: '这里不用 end_turn：做完直接结束这一轮（子任务、工作流节点按各自的 submit_* 交结果）' }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}

export const END_TURN: PanelTool = {
  name: END_TURN_TOOL,
  when: (o) => !!o.endTurn,
  def: (o) =>
    o.coordinator
      ? {
          ...END_TURN_DEF,
          inputSchema: {
            ...END_TURN_DEF.inputSchema,
            properties: { ...END_TURN_DEF.inputSchema.properties, ...OWN_FIELD },
          },
        }
      : END_TURN_DEF,
  // 结束只认 end_turn（shared/end-turn.ts）：不写明的话模型照旧说完就停，面板只能再提醒一次
  hint: (_o, at) =>
    at === 'conv'
      ? 'end_turn 结束这一轮（做完了先写好结论，再调用 end_turn（outcome: done）作为最后一个动作，之后必须用一句话简短说明收尾、不要重复总结；做不下去用 outcome: blocked，need 写缺什么）；'
      : '',
  call: (o, a) => callEndTurn(o, a),
}
