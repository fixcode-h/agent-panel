import { log } from '../log.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import type { ToolUse } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

/** 重试前安静了这么久才写进重试提示：几秒以内的是正常的请求失败，不必说明 */
const QUIET_NOTE_S = 10

/**
 * 重试提示显示的那一行：CLI 往往等网关断开连接才报重试，之前可能已经干等了一分钟，
 * 写明安静了多久，看得出不是刚出错（用户 2026-11-06 报）。CLI 自己报了等待时间（首字节超时）就不重复
 */
export function retryNoticeText(ev: { text: string; kind?: string; waitedMs?: number }, quietMs: number) {
  const s = Math.round(quietMs / 1000)
  return ev.kind === 'retry' && !ev.waitedMs && s >= QUIET_NOTE_S
    ? `${ev.text}${t('（之前 {s} 秒没有新的输出）', { s })}`
    : ev.text
}

/**
 * CLI 报的提示（重试、失败、面板工具没接上）变成回复里的一行状态，例如「模型请求失败，2 秒后第 1 次重试」。
 * 都要写进日志：界面上只留一行，事后统计「总是失败」要能查到是哪一类、第几次、恢复没有。
 * quietMs 是报这条之前多久没有输出（stall-watch 的 quietMs）
 */
export function noticeRow(
  ev: Extract<CliEvent, { type: 'notice' }>,
  where: { task: string; step: string; cli: string },
  quietMs: number,
): ToolUse {
  const sec = { ...where, kind: ev.kind, attempt: ev.attempt, maxAttempts: ev.maxAttempts, error: ev.error }
  if (ev.failed) log.warn('agent', ev.text, sec)
  else if (ev.kind) log.info('agent', ev.text, sec)
  // CLI 自己报的重试、失败：画成警告行，点开看是哪一类、怎么办
  const kind = !ev.failed && (ev.kind === 'retry' || /重试|retry/i.test(ev.text)) ? 'retry' : undefined
  return {
    kind: 'other',
    name: t('提示'),
    label: retryNoticeText(ev, quietMs),
    detail: '',
    ...(ev.failed ? { failed: true } : {}),
    // 分类按 CLI 的原句判断（结尾是不是 unknown），补的说明只放在显示的那一行
    ...(ev.failed || kind ? { alert: makeAlert(ev.failed ? 'error' : 'warn', ev.text, kind) } : {}),
  }
}
