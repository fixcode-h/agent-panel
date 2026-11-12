import { createContext, useContext } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { isImagePath } from '@/lib/file-path'
import { ModalButton } from '@/components/ui/modal'
import { FileViewDialog, type FileSource } from '@/components/files/FileViewDialog'

/** 任务页提供：Agent 输出里的文件路径点了以后在这里打开；没有提供时路径就是普通的行内代码 */
export const FileOpenCtx = createContext<((path: string, line?: number) => void) | null>(null)
export const useFileOpen = () => useContext(FileOpenCtx)

/**
 * 在线演示没有项目目录：图片给一张内联的占位图，点开看大图这件事照样能演示。
 * data: 图片里用不了 CSS 变量，打开时从主题 token 里取当前的底色和强调色，换主题也不突兀
 */
function demoImg() {
  const css = getComputedStyle(document.documentElement)
  const bg = css.getPropertyValue('--card').trim()
  const fg = css.getPropertyValue('--accent').trim()
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${bg}"/><text x="320" y="210" fill="${fg}" font-size="24" text-anchor="middle" font-family="sans-serif">在线演示没有真实的项目目录</text></svg>`, // i18n-ok：演示版的占位图（演示内容不翻译）
    )
  )
}

/**
 * Agent 输出里点了一个文件路径：任务目录里读写，弹窗本身和文件浏览页是同一个（FileViewDialog），
 * 能切到编辑直接改完保存，Markdown 阅读时按对话里的样式渲染。
 * local：附件卡片（上传的、粘贴路径引用的本机文件），按绝对路径读、只读，不限在任务目录里；
 * 看不了内容的（PDF、Office 这类）可以用系统默认程序打开或在文件夹里显示
 */
export function FileDialog({
  taskId,
  projectId,
  target,
  onOpenChange,
}: {
  taskId: string
  /** 对话所在的项目：表格文件交给插件认领（在表格页打开、用项目的表头设置） */
  projectId?: string
  target: { path: string; line?: number; local?: boolean } | null
  onOpenChange: (open: boolean) => void
}) {
  const local = !!target?.local
  const openLocal = (reveal: boolean) =>
    target &&
    api
      .openLocalFile(target.path, reveal)
      .then((r) => !reveal && r.revealed && toast(t('这类文件不直接打开，已在文件夹中显示')))
      .catch((e) => toast.error((e as Error).message))
  const source: FileSource = {
    read: (p) => (local ? api.localFile(p).then((f) => ({ ...f, editable: false })) : api.taskFile(taskId, p)),
    write: local ? undefined : (p, content, mtime) => api.writeTaskFile(taskId, p, content, mtime),
    diff: local ? undefined : (p) => api.taskFileDiff(taskId, p),
    // 图片不显示文本：用看图的浮层看原图（和附件一样）；演示版没有项目目录，用内联占位图
    image: (p) =>
      !isImagePath(p)
        ? ''
        : import.meta.env.VITE_DEMO
          ? demoImg()
          : local
            ? `/api/uploads/raw?path=${encodeURIComponent(p)}`
            : api.taskFileRaw(taskId, p),
    missingText: local
      ? t('找不到这个文件，可能已经被移动或删除。')
      : import.meta.env.VITE_DEMO
        ? t('在线演示没有真的项目目录，下载到本机运行后可以在这里查看文件。')
        : t('项目目录里找不到这个文件，可能已经被移动或删除。'),
    binaryText: local
      ? t('这个文件不是文字，这里显示不了。可以用默认程序打开，或在文件夹中找到它。')
      : t('这是二进制文件，不显示内容。'),
    actions: (file) =>
      local &&
      file.exists && (
        <>
          <ModalButton icon={ExternalLink} label={t('用默认程序打开')} onClick={() => openLocal(false)} />
          <ModalButton icon={FolderOpen} label={t('在文件夹中显示')} onClick={() => openLocal(true)} />
        </>
      ),
    editorOk: (file) => !(local && file.binary),
    // 附件是拷进数据目录的副本，不是项目里的表格
    projectId: local ? undefined : projectId,
  }
  return <FileViewDialog source={source} target={target} onOpenChange={onOpenChange} />
}
