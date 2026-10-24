/**
 * 对话之间收发的消息（父对话 ↔ 子对话、父对话 ↔ 同项目的其他父对话）在界面上怎么说。
 * 收件方的消息带 TaskMessage.peer，发件方是一次工具调用（send_to_conversation、message_parent、message_peer）；
 * 两边都画成一行「发送消息 / 接收消息 + 类型 + 内容标题」，类型决定图标和小标签
 */
import type { PeerFrom, PeerKind, TaskMessage } from './schema.ts'
import { t } from './i18n.ts'

/** 正文开头的【收尾请求】【子对话状态】这类标签是说给 AI 的，标题里不重复它 */
export const LEAD_TAG = /^【[^】]{1,12}】/

/** 一行里放得下的内容标题：去掉开头的标签，取第一行非空的话 */
export function subjectLine(text: string, max = 120) {
  const line =
    text
      .replace(LEAD_TAG, '')
      .split('\n')
      .map((l) => l.trim())
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
