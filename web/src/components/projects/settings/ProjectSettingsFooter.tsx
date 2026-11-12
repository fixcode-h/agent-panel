import { Loader2, Trash2 } from 'lucide-react'
import type { Project } from '@shared/schema'
import { TRASH_RETENTION_DAYS } from '@shared/task'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import type { useProjectSave } from './use-project-save'

/**
 * 项目设置的底栏（删除、取消、确认，以及为什么还存不了）和删除确认框（从 ProjectSettingsDialog.tsx 挪出）。
 */
export function ProjectSettingsFooter({
  project,
  save,
  valid,
  initialized,
  hasWorkflow,
  changedDocs,
  onSection,
  onClose,
}: {
  project?: Project
  save: ReturnType<typeof useProjectSave>
  /** 名称填了、有默认工作流 */
  valid: boolean
  /** 做过 AI 初始化（没做过不能保存） */
  initialized: boolean
  /** 有实际会用的默认工作流 */
  hasWorkflow: boolean
  /** 有改动的说明文件数 */
  changedDocs: number
  onSection: (s: string) => void
  onClose: () => void
}) {
  const { saving, confirm, deleting, setDeleting, remove } = save
  return (
    <>
      <footer className="flex shrink-0 items-center gap-2 border-t bg-panel/60 px-6 py-3.5">
        {project && (
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t('删除项目')}
          </Button>
        )}
        <span className="ml-auto" />
        <Button variant="secondary" onClick={onClose}>
          {t('取消')}
        </Button>
        {changedDocs > 0 && (
          <span className="text-xs text-subtle">{t('{n} 个说明文件有改动', { n: changedDocs })}</span>
        )}
        {!initialized && (
          <Button variant="link" tone="warning" className="text-xs" onClick={() => onSection('init')}>
            {t('先完成「AI 初始化项目」才能保存')}
          </Button>
        )}
        {initialized && !hasWorkflow && (
          <Button variant="link" tone="warning" className="text-xs" onClick={() => onSection('workflows')}>
            {t('请为项目选择子对话默认工作流')}
          </Button>
        )}
        <Button onClick={() => void confirm()} disabled={!valid || saving || !initialized}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {project ? t('确认') : t('创建')}
        </Button>
      </footer>

      {project && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('删除「{name}」？', { name: project.name })}
          description={t(
            '项目配置和它的所有对话一起放进回收站，{days} 天内可以在「设置 → 数据」里恢复；不会动本地目录里的文件。',
            { days: TRASH_RETENTION_DAYS },
          )}
          onConfirm={remove}
        />
      )}
    </>
  )
}
