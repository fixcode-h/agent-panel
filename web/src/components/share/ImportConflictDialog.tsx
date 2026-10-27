import * as D from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'
import type { ShareMode } from '@shared/agent-share'
import type { ImportConflict } from '@/lib/transfer'

/**
 * 导入分享包撞上同名时的选择：覆盖本机那份 / 另存为副本。
 * 内置的那份由面板同步，只给「另存为副本」——导入不能把它绕过去。
 * 单独一个弹窗而不是 ConfirmDialog：这里要三个动作（取消、另存为副本、覆盖），
 * ConfirmDialog 只有「取消 / 删除」两个按钮。
 */
export function ImportConflictDialog({
  conflict,
  onPick,
  onClose,
}: {
  /** 没有就是没打开 */
  conflict?: ImportConflict
  onPick: (mode: ShareMode) => void
  onClose: () => void
}) {
  return (
    <D.Root open={!!conflict} onOpenChange={(open) => !open && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-card p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <D.Title className="text-[0.9375rem] font-semibold">
            {t('{what}同名了', { what: conflict?.kind === 'workflow' ? t('工作流') : t('角色') })}
          </D.Title>
          <D.Description className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">
            {conflict?.message}
          </D.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="secondary" onClick={() => onPick('copy')}>
              {t('另存为副本')}
            </Button>
            {!conflict?.builtin && (
              <Button variant="danger" onClick={() => onPick('overwrite')}>
                {t('覆盖本机那份')}
              </Button>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
