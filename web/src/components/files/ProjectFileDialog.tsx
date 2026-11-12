import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { FileViewDialog, type FileSource } from './FileViewDialog'

/** 按扩展名先认出图片，直接看原图，不用等文本接口回来再切换 */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/**
 * 文件浏览页里点开一个文件：项目目录里读写，弹窗本身和对话里点开的文件是同一个（FileViewDialog）。
 */
export function ProjectFileDialog({
  projectId,
  dir,
  target,
  onOpenChange,
  onSaved,
}: {
  projectId: string
  /** 项目目录：拼「在编辑器中打开」的地址 */
  dir: string
  target: { path: string; line?: number } | null
  onOpenChange: (open: boolean) => void
  /** 保存成功后通知外面刷新文件树（大小、改动标记都会变） */
  onSaved?: () => void
}) {
  const source: FileSource = {
    read: (p) => api.projectFile(projectId, p),
    write: (p, content, mtime) => api.writeProjectFile(projectId, p, content, mtime),
    diff: (p) => api.projectFileDiff(projectId, p),
    image: (p) => (IMAGE.test(p) ? api.projectFileRaw(projectId, p) : ''),
    dir,
    missingText: t('项目目录里找不到这个文件，可能已经被移动或删除。'),
    binaryText: t('这是二进制文件，不显示内容。'),
    onSaved,
    projectId,
  }
  return <FileViewDialog source={source} target={target} onOpenChange={onOpenChange} />
}
