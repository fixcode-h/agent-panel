import { useEffect, useState } from 'react'
import { extOf, baseName } from '@/lib/file-ref'
import { useFileRef } from '@/components/files/FileRefLayer'
import { HtmlCard } from '@/components/ui/html-card'

/**
 * 对话里的一个 HTML 文件（回复里的文件标记、本轮产出）：HtmlCard 接上这个对话的文件。
 * 对话和项目从文件标记那一层（FileRefLayer）取；点了在右栏网页页签打开
 */
export function TaskHtmlCard({
  path,
  size,
  variant = 'large',
}: {
  path: string
  /** 本轮产出已经查过大小时直接给；回复里的卡片自己按路径解析 */
  size?: number
  variant?: 'large' | 'small'
}) {
  const refs = useFileRef()
  const [found, setFound] = useState<number | undefined>(size)
  useEffect(() => {
    if (size !== undefined || !refs) return
    let off = false
    void refs.info(path).then((r) => !off && setFound(r?.exists ? r.size : undefined))
    return () => {
      off = true
    }
  }, [path, size, refs])
  return (
    <HtmlCard
      variant={variant}
      title={baseName(path)}
      name={path}
      size={size ?? found}
      kind={extOf(path) === 'svg' ? 'SVG' : 'HTML'}
      onOpen={() => void refs?.open({ path })}
    />
  )
}
