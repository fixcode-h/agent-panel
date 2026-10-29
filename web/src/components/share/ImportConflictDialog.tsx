import * as D from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
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
    // 和确认框一个样子（标题、说明、右下角按钮），所以只借 Modal 的外壳，D.Title 自己放
    <Modal
      open={!!conflict}
      onOpenChange={(open) => !open && onClose()}
      title={null}
      size="sm"
      bare
      closeOnOutside
      className="p-6"
    >
      <D.Title className="text-[0.9375rem] font-semibold">
        {t('{what}同名了', { what: conflict?.kind === 'workflow' ? t('工作流') : t('角色') })}
      </D.Title>
      <D.Description className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{conflict?.message}</D.Description>
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
    </Modal>
  )
}
