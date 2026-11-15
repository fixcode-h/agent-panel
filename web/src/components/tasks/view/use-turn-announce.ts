/**
 * 读屏用的状态播报：一轮做完、出错时说一句（画面上靠转圈和颜色，读屏用户看不到）。
 * 从 TaskView.tsx 拆出来（复查报告 B2）
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'

/** working：CLI 真的在处理这一轮；failed：这一轮的结果是失败 */
export function useTurnAnnounce(working: boolean, failed: boolean) {
  // 只在「执行中 → 停下」那一下更新，打开对话时不播报
  const [announce, setAnnounce] = useState('')
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && !working) setAnnounce(failed ? t('这一轮执行出错了') : t('这一轮执行完了'))
    wasWorking.current = working
    // 只跟着 working 变：status 在同一次推送里一起到
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [working])
  return announce
}
