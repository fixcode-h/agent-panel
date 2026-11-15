/**
 * 失败分类（复查报告 A5，摸底报告第 10 条）：这次失败是临时的（网关、网络断开、限流、并发超限、额度用完），
 * 还是真做错了。临时的过一会儿或换个时间继续就能接着做，父对话不该跟着把整棵树判失败。
 *
 * 只看报错原文的分类（shared/alerts.ts 的 classifyError，CLI 报告时已经记在 alert.kind 上），不看模型回复的文字。
 * 仍然显示给用户、不悄悄重试（硬规则）：到点自动继续只在用户在设置里打开时做（server/tasks/quota-resume.ts）
 */
import { classifyError } from '../alerts.ts'
import type { AlertKind, TaskMessage } from '../schema.ts'

/** 过一会儿再试就可能好的几类 */
const TRANSIENT: readonly AlertKind[] = ['gateway', 'network', 'rate_limit', 'quota']

export const transientKind = (kind: AlertKind | undefined) => !!kind && TRANSIENT.includes(kind)

/** 最后一条还没恢复的报错是哪一类（和 lastFailureNote 找的是同一条）；没有报错返回 undefined */
export function lastFailureKind(messages: TaskMessage[] = []): AlertKind | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    for (const tool of [...(m.tools ?? [])].reverse())
      if (tool.alert?.level === 'error' && !tool.alert.resolved)
        return tool.alert.kind ?? classifyError(tool.alert.detail || tool.label)
    if (m.alert?.level === 'error' && !m.alert.resolved) return m.alert.kind ?? classifyError(m.alert.detail || m.text)
    if (m.error && !m.alert?.resolved && m.text.trim()) return classifyError(m.text)
  }
  return undefined
}
