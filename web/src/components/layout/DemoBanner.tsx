import { useState } from 'react'
import { FlaskConical, RotateCcw, X } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/dialog'
import { t } from '@shared/i18n'

/** 在线演示模式顶部提示条：数据只存在浏览器里，可一键恢复示例数据 */
export function DemoBanner() {
  const [open, setOpen] = useState(true)
  const [confirming, setConfirming] = useState(false)
  if (!open) return null
  const reset = async () => {
    const { resetDemo } = await import('@/lib/demo-backend')
    resetDemo()
    location.reload()
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-accent-soft px-4 py-2 text-[13px] text-fg">
      <FlaskConical className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
      <span className="min-w-0 flex-1">
        <b className="font-medium">{t('在线演示')}</b>
        <span className="text-subtle">{t('：数据只存在你的浏览器里，CLI 和本机目录是模拟的。')}</span>
      </span>
      <button
        onClick={() => setConfirming(true)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-accent hover:bg-accent-soft"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t('恢复示例数据')}
      </button>
      <button
        onClick={() => setOpen(false)}
        aria-label={t('关闭提示')}
        className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle hover:text-fg"
      >
        <X className="h-4 w-4" />
      </button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('恢复示例数据？')}
        description={t('你在演示里新建和修改的 Agent、工作流、项目和任务都会被清掉，换回最初的示例。')}
        confirmText={t('恢复')}
        onConfirm={reset}
      />
    </div>
  )
}
