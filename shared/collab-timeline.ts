/**
 * 父子协作时间线：一个父对话和它名下的子对话之间「谁在什么时候给谁发了什么、是模型发的还是面板发的」。
 *
 * 调「消息太多」「为什么没叫醒」这类问题时要把父对话和每个子对话的对话来回翻（ADR 0032 收紧了父子之间发什么），
 * 这里从两边的消息里把收发的那几条挑出来排成一条线。只读已有字段（TaskMessage.peer / panel / child / ask），不另记数据。
 */
import { t } from './i18n.ts'
import { peerKindText, peerOfMessage, subjectLine } from './peer-message.ts'
import type { PeerKind, Task, TaskMessage } from './schema.ts'

/** 谁发的：模型（Agent 调工具发的）、面板（状态上报、推它接着做、收尾结果）、用户（直接在子对话里说的） */
export type CollabSource = 'model' | 'panel' | 'user'

export interface CollabEvent {
  /** 消息 id + 所在对话：界面点了能跳过去 */
  id: string
  taskId: string
  at: string
  from: { id: string; title: string }
  to: { id: string; title: string }
  kind: PeerKind | 'nudge' | 'user'
  /** 类型的说法：交代任务、汇报、推它接着做…… */
  label: string
  subject: string
  source: CollabSource
  failed?: boolean
}

/** 面板写的那几种开头：状态上报、推它接着做、收尾结果都以【…】开头，模型自己发的消息不会带 */
const PANEL_HEAD = /^【(面板|子对话状态|收尾结果|编译结果|父对话测试|收尾请求)/

type Conv = Pick<Task, 'id' | 'title' | 'messages'>

const who = (c: Conv) => ({ id: c.id, title: c.title })
const PANEL = { id: '', title: '' }
const USER = { id: '', title: '' }

function sourceOf(m: TaskMessage): CollabSource {
  if (m.panel === 'child' || m.panel === 'wrapup' || m.panel === 'ask') return 'panel'
  return PANEL_HEAD.test(m.text) ? 'panel' : 'model'
}

/**
 * 时间线（按时间从早到晚）。kids 是名下的子对话（完整消息）；limit 只留最后几条
 */
export function collabEvents(root: Conv, kids: Conv[], limit = 300): CollabEvent[] {
  const out: CollabEvent[] = []
  const kidById = new Map(kids.map((k) => [k.id, k]))
  // 父对话这边收到的：子对话的汇报、提问、收尾请求，面板的状态上报，以及面板推父对话自己接着做
  for (const m of root.messages) {
    if (m.panel === 'ask' && m.ask) {
      const kid = kidById.get(m.ask.from)
      out.push({
        id: m.id,
        taskId: root.id,
        at: m.at,
        from: kid ? who(kid) : { id: m.ask.from, title: m.ask.title },
        to: who(root),
        kind: 'question',
        label: peerKindText('question'),
        subject: subjectLine(m.ask.question || m.text),
        source: 'panel',
      })
      continue
    }
    const p = peerOfMessage(m)
    if (p && p.rel === 'child') {
      out.push({
        id: m.id,
        taskId: root.id,
        at: m.at,
        from: kidById.has(p.id) ? who(kidById.get(p.id)!) : { id: p.id, title: p.title },
        to: who(root),
        kind: p.kind,
        label: peerKindText(p.kind),
        subject: p.subject || subjectLine(m.text),
        source: sourceOf(m),
        ...(p.failed && { failed: true }),
      })
      continue
    }
    if (!p && m.text.startsWith('【面板】'))
      out.push({
        id: m.id,
        taskId: root.id,
        at: m.at,
        from: PANEL,
        to: who(root),
        kind: 'nudge',
        label: t('推它接着做'),
        subject: subjectLine(m.text),
        source: 'panel',
      })
  }
  // 子对话这边收到的：父对话交代、回答、传话，面板推它接着做，以及用户直接对它说的
  for (const kid of kids)
    for (const m of kid.messages) {
      const p = m.peer
      if (p && p.rel === 'parent') {
        const panel = sourceOf(m) === 'panel'
        const nudge = panel && m.text.startsWith('【面板】')
        out.push({
          id: m.id,
          taskId: kid.id,
          at: m.at,
          from: nudge ? PANEL : who(root),
          to: who(kid),
          kind: nudge ? 'nudge' : p.kind,
          label: nudge ? t('推它接着做') : peerKindText(p.kind),
          subject: p.subject || subjectLine(m.text),
          source: panel ? 'panel' : 'model',
        })
        continue
      }
      if (m.role === 'user' && !p && !m.panel && !m.step && !m.text.startsWith('【'))
        out.push({
          id: m.id,
          taskId: kid.id,
          at: m.at,
          from: USER,
          to: who(kid),
          kind: 'user',
          label: t('你直接说的'),
          subject: subjectLine(m.text),
          source: 'user',
        })
    }
  out.sort((a, b) => a.at.localeCompare(b.at))
  return out.slice(-limit)
}

/** 一条的「谁 → 谁」：面板、你、父对话、子对话标题 */
export function collabParty(x: { id: string; title: string }, rootId: string, source: CollabSource) {
  if (!x.id) return source === 'user' ? t('你') : t('面板')
  if (x.id === rootId) return t('父对话')
  return x.title || t('子对话')
}
