/**
 * 对话之间收发的消息（父对话 ↔ 子对话、父对话 ↔ 同项目的其他父对话）在界面上怎么说。
 * 收件方的消息带 TaskMessage.peer，发件方是一次工具调用（send_to_conversation、message_parent、message_peer）；
 * 两边都画成一行「发送消息 / 接收消息 + 类型 + 内容标题」，类型决定图标和小标签
 */
import type { PeerFrom, PeerKind, Task, TaskMessage } from './schema.ts'
import { t } from './i18n.ts'

/** 正文开头的【收尾请求】【子对话状态】这类标签是说给 AI 的，标题里不重复它 */
export const LEAD_TAG = /^【[^】]{1,12}】/

/** waitNote（shared/plan.ts）推回结果时加在最前面的那句：「（计划步骤「a」、「b」等的结果到了……）」 */
const PLAN_NOTE = /^（计划步骤(.+?)等的结果到了(，已标为完成)?[：:].*）$/
/** 子对话状态上报的第一行：【子对话状态】「标题」（id xxx）状态：原因 */
const REPORT_HEAD = /^【子对话状态】「([^」]*)」(?:（id:? [^）\s]+）)?(.*)$/

/** 一行里放得下的内容标题：去掉开头的标签，取第一行非空的话 */
export function subjectLine(text: string, max = 120) {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      // 计划步骤那句是给 AI 的提醒，不当标题
      .filter((l) => !PLAN_NOTE.test(l))
      .map((l) => l.replace(LEAD_TAG, ''))
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function peerKindText(kind: PeerKind): string {
  switch (kind) {
    case 'task':
      return t('交代任务')
    case 'answer':
      return t('回答')
    case 'question':
      return t('提问')
    case 'report':
      return t('汇报')
    case 'wrapup':
      return t('请求收尾')
    case 'merge':
      return t('收尾结果')
    case 'build':
      return t('编译')
    case 'test':
      return t('父对话测试')
    case 'rule':
      return t('全局规则')
    case 'chat':
      return t('传话')
  }
}

/** 发件方是谁：「统筹」；同名时界面上再看对话标题 */
export function peerName(p: Pick<PeerFrom, 'name' | 'title' | 'rel'>) {
  return p.name || p.title || (p.rel === 'parent' ? t('父对话') : p.rel === 'child' ? t('子对话') : t('其他父对话'))
}

/**
 * 旧数据（加 peer 之前）里子对话交回父对话的消息：按 panel 和 child 补成一份 peer，界面同样画成「接收消息」。
 * 认不出是谁发的（面板替用户说的话）返回 undefined，照旧画成面板的一行
 */
export function peerOfMessage(m: TaskMessage): PeerFrom | undefined {
  if (m.peer) return m.peer
  if ((m.panel === 'child' || m.panel === 'wrapup') && m.child) {
    const kind: PeerKind = m.panel === 'wrapup' ? (/^【编译申请】/.test(m.text) ? 'build' : 'wrapup') : 'report'
    return {
      id: m.child.id,
      title: m.child.title,
      name: m.child.title,
      rel: 'child',
      kind,
      subject: '',
      ...(m.child.state === 'failed' && { failed: true }),
    }
  }
  return undefined
}

/**
 * 同一段话之前已经交给了别的子对话：返回那个子对话的 id。一条消息只交给一个子对话（用户 2026-10-24 定的），
 * 父对话把用户的一句话逐个转给四五个子对话会被拒绝。按对话里记下的 send_to_conversation 调用查，
 * 跨轮次也认得出；失败的那次不算，再发给同一个子对话（补充、催）照常放行
 */
export function sentToOther(task: Pick<Task, 'messages'>, id: string, message: string): string | undefined {
  const body = message.trim()
  if (!body) return undefined
  for (const m of task.messages)
    for (const tool of m.tools) {
      if (tool.failed || !/\bsend_to_conversation\b/.test(`${tool.name ?? ''} ${tool.label}`)) continue
      let a: { id?: unknown; message?: unknown }
      try {
        a = JSON.parse(tool.input ?? '')
      } catch {
        continue
      }
      const to = typeof a?.id === 'string' ? a.id.trim() : ''
      if (to && to !== id && typeof a.message === 'string' && a.message.trim() === body) return to
    }
  return undefined
}

/**
 * 子对话汇报拆成的字段：正文是写给父对话 AI 的一段纯文本，界面按字段排开，一眼看出
 * 哪个子对话、什么状态、为什么、对应计划哪一步、下一步做什么、最近的结果
 */
export interface PeerReport {
  /** 计划里等这个结果的步骤 */
  steps: string[]
  /** 那几步已经被标成完成（不只是「结果到了」） */
  stepsDone: boolean
  /** 子对话标题；不是状态上报（只有计划步骤那句）时为空 */
  child: string
  /** 状态（「已中断」），取自原因前的短词；说不出时为空 */
  state: string
  /** 原因（「父对话结束时一起结束」），没有短词前缀时就是整句 */
  reason: string
  /** 给父对话的下一步提示 */
  next: string[]
  /** 子对话最近一轮的回复 */
  result: string
  /** 认不出是哪个字段的其余文字（只有计划步骤那句时，是后面的结果原文） */
  rest: string
}

/**
 * 把汇报正文拆成字段：认得出计划步骤那句或【子对话状态】开头才算，其余返回 null 照旧画全文。
 * 只按服务端拼出的固定写法认（server/tasks/children.ts 的 reportChild、shared/plan.ts 的 waitNote），
 * 旧数据里「下一步」没写前缀的重试说明也归到下一步
 */
export function parseReport(text: string): PeerReport | null {
  const lines = text.replace(/\n处理完这个结果后[^\n]*$/, '').split('\n')
  const out: PeerReport = {
    steps: [],
    stepsDone: false,
    child: '',
    state: '',
    reason: '',
    next: [],
    result: '',
    rest: '',
  }
  const note = lines[0]?.trim().match(PLAN_NOTE)
  if (note) {
    out.steps = [...note[1].matchAll(/「([^」]+)」/g)].map((m) => m[1])
    out.stepsDone = !!note[2]
    lines.shift()
  }
  const head = lines[0]?.trim().match(REPORT_HEAD)
  if (head) {
    out.child = head[1]
    const why = head[2].trim()
    // 「已中断：父对话结束时一起结束」：冒号前是状态短词；没有短词（startup 的说明）整句当原因
    const m = why.match(/^([^：，。\s]{2,6})：(.+)$/s)
    out.state = m ? m[1] : ''
    out.reason = m ? m[2] : why
    lines.shift()
  }
  if (!note && !head) return null
  // 只有计划步骤那句（后台命令、子任务的结果）：后面整段是结果原文，不拆
  if (!head) {
    out.rest = lines.join('\n').trim()
    return out
  }
  const at = lines.findIndex((l) => l.startsWith('最近的结果：'))
  if (at >= 0) out.result = [lines[at].slice('最近的结果：'.length), ...lines.slice(at + 1)].join('\n').trim()
  for (const l of (at < 0 ? lines : lines.slice(0, at)).map((x) => x.trim()).filter(Boolean))
    // 「（id xxx）」是给 AI 调工具用的，界面上有打开子对话的按钮
    out.next.push(l.replace(/^下一步：/, '').replace(/（id:? [^）\s]+）/g, ''))
  return out
}
