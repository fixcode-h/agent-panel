// 输入框接住视频：放进来的视频（拖、粘贴、选文件、粘贴路径）不当附件发，排队打开截帧弹窗，
// 选好的帧作为图片附件放回光标处。挂在 useComposerChips 里，任务对话和新建任务的输入框都有
import { useEffect, useState, type RefObject } from 'react'
import type { Attachment } from '@shared/schema'
import type { useAttachments } from '@/components/chat/Attachments'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { VideoFramesDialog, type VideoTarget } from './VideoFramesDialog'

export function useVideoIntake(
  files: ReturnType<typeof useAttachments>,
  editor: RefObject<RichInputHandle | null>,
  addReady: (a: Attachment) => void,
) {
  const [queue, setQueue] = useState<VideoTarget[]>([])
  useEffect(() => {
    const taker = files.videoTaker
    const take = (v: VideoTarget) => setQueue((q) => (q.some((x) => x.path === v.path) ? q : [...q, v]))
    taker.current = take
    // 只撤自己挂的：同一组附件换了输入框时，后挂上的那个不能被先卸载的这个清掉
    return () => {
      if (taker.current === take) taker.current = null
    }
  }, [files.videoTaker])
  return (
    <VideoFramesDialog
      target={queue[0] ?? null}
      onClose={() => setQueue((q) => q.slice(1))}
      onInsert={(list) => {
        editor.current?.focus()
        for (const a of list) addReady(a)
      }}
    />
  )
}
