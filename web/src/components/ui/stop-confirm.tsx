import { useState } from 'react'
import { t } from '@shared/i18n'
import { Checkbox } from './checkbox'
import { ConfirmDialog } from './dialog'

/**
 * AI 排查时关窗口的提醒：关闭会停止排查，可以勾选「以后不再提醒」，之后关闭直接停止。
 * 「AI 处理」和 MCP 工具的 AI 排查共用这一个设置
 */
const KEY = 'ai-fix-close-no-confirm'
export const skipStopConfirm = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** ask(running) 返回 true 表示可以直接关；否则弹出提醒，确认后调 onStop */
export function useStopConfirm(onStop: () => void) {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const ask = (running: boolean) => {
    if (!running || skipStopConfirm()) return true
    setRemember(false)
    setOpen(true)
    return false
  }
  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t('停止 AI 排查？')}
      description={t('关闭窗口会停止这次排查。只想先放到一边的话，点「最小化」，排查会接着进行。')}
      confirmText={t('停止并关闭')}
      extra={<Checkbox checked={remember} onChange={setRemember} label={t('以后不再提醒，关闭时直接停止')} />}
      onConfirm={() => {
        if (remember)
          try {
            localStorage.setItem(KEY, '1')
          } catch {}
        setOpen(false)
        onStop()
      }}
    />
  )
  return { ask, dialog }
}
