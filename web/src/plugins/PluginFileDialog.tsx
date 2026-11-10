import { Copy, FileText, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { copyText } from '@/lib/copy-text'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { fileViewerFor, usePlugins } from './registry'

/** 交给插件查看器的文件：path 是本机上的完整路径 */
export interface PluginFileTarget {
  path: string
  projectId?: string
  taskId?: string
}

/**
 * 插件来看的文件（.uasset 这类面板自己读不了的格式）：外壳和文件预览（FileViewDialog）一样——同样的尺寸、
 * 标题栏是等宽的路径、右边复制路径和关闭，内容交给插件登记的查看器（sdk.ts 的 FileViewer）。
 * 查看器出错只在弹窗里显示，不带崩对话页。
 */
export function PluginFileDialog({
  target,
  onOpenChange,
}: {
  target: PluginFileTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const plugins = usePlugins()
  const viewer = target ? fileViewerFor(target.path, plugins) : undefined
  const close = () => onOpenChange(false)
  return (
    <Modal
      open={!!target}
      onOpenChange={onOpenChange}
      title={null}
      bare
      closeOnOutside
      resizeKey={viewer ? `plugin-file:${viewer.plugin}:${viewer.id}` : 'plugin-file'}
      className="h-[min(760px,calc(100dvh-3.75rem))] max-w-[1000px]"
    >
      <ModalHeader
        icon={(viewer?.icon ?? FileText) as LucideIcon}
        title={target?.path}
        titleClass="font-mono"
        titleAttr={target?.path}
        actions={
          <ModalButton
            icon={Copy}
            label={t('复制路径')}
            onClick={() => void copyText(target?.path ?? '', { done: t('已复制'), fail: false })}
          />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {target && viewer ? (
          <ErrorBoundary resetKey={target.path}>
            <viewer.Viewer path={target.path} projectId={target.projectId} taskId={target.taskId} close={close} />
          </ErrorBoundary>
        ) : (
          // 弹窗开着的时候插件被关掉、删除了
          <p className="p-6 text-body text-subtle">{t('能看这个文件的插件已经关掉了')}</p>
        )}
      </div>
    </Modal>
  )
}
