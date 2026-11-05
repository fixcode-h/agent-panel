// 输入框里的视频卡片：点卡片打开截帧弹窗，选好的帧记在这张卡片上，发送时换成帧图片（Agent 收不了视频）。
// 挂在 useComposerChips 里，任务对话和新建任务的输入框都有；视频本身只引用原路径，不拷、不上传
import { useEffect, useState } from 'react'
import type { useAttachments } from '@/components/chat/Attachments'
import { VideoFramesDialog } from './VideoFramesDialog'

export function useVideoIntake(files: ReturnType<typeof useAttachments>) {
  /** 正在选帧的视频卡片（附件的 key） */
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const host = files.videoHost
    const show = (key: string) => setOpen(key)
    host.current = show
    // 只撤自己挂的：同一组附件换了输入框时，后挂上的那个不能被先卸载的这个清掉
    return () => {
      if (host.current === show) host.current = null
    }
  }, [files.videoHost])
  const item = open ? files.items.find((x) => x.key === open) : undefined
  const path = item?.source ?? item?.done?.path
  return {
    /** 打开某张视频卡片的截帧弹窗 */
    open: setOpen,
    dialog: (
      <VideoFramesDialog
        target={item && path ? { path, name: item.name, chosen: item.frames ?? [] } : null}
        onClose={() => setOpen(null)}
        onInsert={(list) => item && files.setFrames(item.key, list)}
      />
    ),
  }
}
