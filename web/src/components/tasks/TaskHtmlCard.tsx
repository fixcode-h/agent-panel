import { useEffect, useState } from 'react'
import { webViewContract as W } from '@shared/api-contract/web-view'
import { extOf, baseName } from '@/lib/file-ref'
import { call } from '@/lib/api/call'
import { toast } from '@/lib/toast'
import { sameTarget, useWebHost, useWebTabs, type WebTarget } from '@/lib/web-view/tabs'
import { useFileRef } from '@/components/files/FileRefLayer'
import { HtmlCard } from '@/components/ui/html-card'
import { WebFrame } from '@/components/ui/web-frame'

/** 超过这么大的文件不做缩略预览，只显示图标（设计稿 6.6） */
const PREVIEW_MAX = 5 * 1024 * 1024

/**
 * 对话里的一个 HTML 文件（回复里的文件标记、本轮产出）：HtmlCard 接上这个对话的文件。
 * - 标题取网页的 <title>（网页页签接口读文件开头），大小、在不在按文件标记那一层（FileRefLayer）解析
 * - 缩略预览用 WebFrame 的 thumb（进视口才加载、同时最多 3 个）
 * - 点了走文件标记的打开（FileRefLayer.open 把网页开到右栏的网页页签），右栏正显示它时描强调色
 */
export function TaskHtmlCard({
  path,
  size,
  variant = 'large',
  compact,
}: {
  path: string
  /** 两列排开时（本轮产出）：只留「打开」，新窗口和更多收掉，标题才放得下 */
  compact?: boolean
  /** 本轮产出已经查过大小时直接给；回复里的卡片自己按路径解析 */
  size?: number
  variant?: 'large' | 'small'
}) {
  const refs = useFileRef()
  const host = useWebHost()
  const [meta, setMeta] = useState<{ abs?: string; size?: number; missing?: boolean; title?: string }>({ size })
  useEffect(() => {
    if (!refs) return
    let off = false
    const ctx = { taskId: refs.taskId, projectId: refs.projectId }
    // 标题和大小走网页页签的接口（服务端读文件开头的 <title>）；它打不开就当文件不在了，只显示图标
    void call(W.file, { body: { path, ...ctx } }).then(
      (f) => !off && setMeta((m) => ({ ...m, title: f.title, size: size ?? f.size, missing: false })),
      () => !off && setMeta((m) => ({ ...m, missing: true })),
    )
    // 完整路径：子对话里的文件开在父对话右栏时也找得到，右栏页签按它比对「正在显示」
    void refs.info(path).then((r) => !off && r?.exists && setMeta((m) => ({ ...m, abs: r.abs })))
    return () => {
      off = true
    }
  }, [path, size, refs])
  const hostId = host?.taskId ?? refs?.taskId ?? ''
  const web = useWebTabs(hostId)
  const target: WebTarget = { kind: 'file', path: meta.abs ?? path }
  const active = !!web.tabs.find((x) => x.id === web.shown && sameTarget(x.target, target))
  const canPreview = variant === 'large' && meta.missing === false && (meta.size ?? 0) <= PREVIEW_MAX
  const newWindow = () =>
    void call(W.file, { body: { path, taskId: refs?.taskId, projectId: refs?.projectId } }).then(
      (f) => window.open(f.url, '_blank', 'noopener'),
      (e: Error) => toast.error(e.message),
    )
  return (
    <HtmlCard
      variant={variant}
      title={meta.title || baseName(path)}
      name={path}
      size={meta.size}
      kind={extOf(path) === 'svg' ? 'SVG' : 'HTML'}
      active={active}
      preview={
        canPreview && refs ? (
          <WebFrame
            target={{ kind: 'file', path }}
            taskId={refs.taskId}
            projectId={refs.projectId}
            mode="thumb"
            className="h-full w-full"
          />
        ) : undefined
      }
      onOpen={() => void refs?.open({ path })}
      onNewWindow={meta.missing || compact ? undefined : newWindow}
      onMore={refs && !compact ? (e) => refs.menu(e, { path }, e.currentTarget) : undefined}
    />
  )
}
