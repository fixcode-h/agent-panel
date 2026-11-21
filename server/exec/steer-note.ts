/**
 * 执行中插话交给模型的那段说明（从 steering.ts 拆出）：按收件的对话是谁换说法。
 *
 * 为什么要分：用户 2026-11-21 报，在父对话里执行中说「直接改 GetDecorationActorTopLocation」，
 * 父对话拿到的是通用那段「相关就调整方向、继续当前任务」，它回一句「我转给子对话」却先把手上的 changelist 做完，
 * 还按旧方案写了描述，那句话一直没送到在修的子对话；子对话执行中收到用户点名的修法，也只拿到通用那段，
 * 就说「这正是方案 A 的方向」把用户的说法并进自己的方案，不核实、不出新一版。
 * 于是：父对话（名下派过子对话）先判断是谁的事、是子对话的就马上转；走 Bug 诊断流程的子对话把用户点名的修法当成对报告的意见。
 * 判断「是不是在改方案」仍交给模型（ADR 0041、0049），面板只按对话的身份和状态挑说法。
 * 交给 Agent 的话是提示词，不翻译
 */
import type { Task, TaskMessage } from '../../shared/schema.ts'
import { diagnosisInFlow } from '../../shared/bug/phase.ts'
import { promptLangReminder } from '../../shared/prompt-lang.ts'

/** 这条插话交给谁、从哪来：决定用哪种说法 */
export interface SteerFrom {
  /** 对话（不是工作流节点） */
  chat: boolean
  /** 父对话 / 面板发来的（状态询问、收尾提醒、转述），不是用户补充 */
  fromParent?: boolean
  /** 名下派过子对话的顶层对话：用户的话可能是说给某个子对话的 */
  coordinator?: boolean
  /** 正在走 Bug 诊断流程（最新一版报告还没走完）：用户点名的修法是对报告的意见 */
  bug?: boolean
  /** 这条用户消息的 id：父对话转给子对话时写进 send_to_conversation 的 quote */
  messageId?: string
}

/** 按对话和消息定说法：调用方只给 task 和这条消息 */
export function steerFrom(
  task: Pick<Task, 'mode' | 'parentTaskId' | 'routes' | 'bug'>,
  msg?: Pick<TaskMessage, 'id' | 'peer'>,
): SteerFrom {
  const chat = task.mode !== 'workflow'
  return {
    chat,
    fromParent: msg?.peer?.rel === 'parent',
    // 派过子对话才有「这句话是谁的事」要分：还没派过的父对话照通用说法
    coordinator:
      chat && !task.parentTaskId && (task.routes ?? []).some((r) => r.target === 'child' || r.target === 'resend'),
    bug: chat && diagnosisInFlow(task),
    messageId: msg?.id,
  }
}

/** 走诊断流程时用户（或父对话转述的用户原话）点名了修法：当成对报告的意见，核实、比较，换方案就出新一版 */
const BUG_PART = `你在走 Bug 诊断流程。这条话里点名了修法、函数、文件或方向时，把它当成对诊断报告的意见，不要直接并进现在的方案：
1. 先读代码核实这个做法行不行、要改哪些文件，和现在的方案逐项比（修得全不全、改动面、风险、能不能验证）；方向接近也不要直接说「这就是方案 X」，写清两者差在哪。
2. 换了修法，或者要改现在方案之外的文件：停下手上的改动、编译和验证，交 submit_diagnosis phase: plan（带 fromChat，面板会附上用户原话），把这个做法列成一个候选、写清采用或不采用的理由，交完结束这一轮等用户确认。
3. 只是方案内的细节（改的还是方案里的文件、做法不变）：照着调，交 fix 时在 why 里写明按用户说的改了哪里。
4. 只是提问：先查清再回答，不改结论。`

/** 父对话收到用户补充：先分清是谁手上的事，子对话的事马上转、不压到手上的事做完以后 */
const coordinatorPart = (id?: string) => `你是父对话，先判断这条话说的是谁手上的事：
- 某个子对话正在做的事（它的方案、修法、范围、要改的函数或文件）：现在就用 send_to_conversation 交给那个子对话${id ? `，quote 写 ["${id}"]（面板把用户原话原样带过去）` : ''}，然后再接着做手上的事。不要先把手上的事做完再转，也不要只说「我转给它」却不调用。你手上依赖它旧方案的动作（按旧方案写提交说明、changelist 描述、提交、合并）先停下，等子对话按新说法交回再做。
- 对你自己当前这件事的调整：按它调整方向，继续当前任务。
- 都无关：先简短说明会等当前任务完成后再处理，然后继续手上的事，当前任务做完后再处理这条内容。`

/**
 * 交给 CLI 的补充。对话里先让模型判断这条补充和当前任务的关系：
 * 相关就调整方向；无关就先做完手上的事，再处理这条，别把当前任务丢在半路。
 * 工作流里交给正在跑的节点，按原来的说法结合当前任务处理。
 * fromParent：父对话 / 面板发来的（状态询问、收尾提醒），不是用户补充；用「用户补充」的措辞会让模型
 * 把它当成无关信息先放着，子对话就不会回答状态询问了。
 */
export const steerNote = (text: string, from: SteerFrom) => {
  // 补充是一条新的用户消息，重复一次语言要求，别让模型接着上一段换成别的语言
  const remind = promptLangReminder()
  const bug = from.chat && from.bug ? `\n\n${BUG_PART}` : ''
  if (from.fromParent)
    return (
      '父对话 / 面板在你执行中发来一条消息（不是用户发的补充）：\n' +
      '- 和当前任务有关（状态询问、交代任务、调整方向）：按它处理并回复；\n' +
      '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事。' +
      `${bug}\n\n${remind}\n\n内容：\n${text}`
    )
  if (!from.chat) return `用户在执行中补充了信息，请结合它继续当前的任务：\n${remind}\n\n${text}`
  const how = from.coordinator
    ? coordinatorPart(from.messageId)
    : '先判断它和当前任务的关系：\n' +
      '- 相关（对当前任务的调整、修改或补充）：按它调整方向，继续当前任务；\n' +
      '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事，不要现在开始做它；当前任务做完后再处理这条内容。'
  return `用户在你执行中补充了信息。${how}${bug}\n\n${remind}\n\n补充的内容：\n${text}`
}
