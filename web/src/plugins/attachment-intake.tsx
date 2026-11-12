// 输入框里插件认领的附件卡片（插件接口 6，WebPlugin.attachmentIntakes）：点卡片打开认领它的插件的弹窗，
// 在里面选好的东西（视频插件截的帧图片）记在这张卡片上，发送时换上去。挂在 useComposerChips 里，
// 任务对话和新建任务的输入框都有；文件本身只引用原路径，不拷、不上传
import { useCallback, useEffect, useState } from 'react'
import type { useAttachments } from '@/components/chat/Attachments'
import { usePlugins } from './registry'
import { intakeByKey } from './attachment-intakes'

export function useAttachmentIntake(files: ReturnType<typeof useAttachments>) {
  /** 正在处理的卡片（附件的 key） */
  const [open, setOpen] = useState<string | null>(null)
  const plugins = usePlugins()
  useEffect(() => {
    const host = files.intakeHost
    const show = (key: string) => setOpen(key)
    host.current = show
    // 只撤自己挂的：同一组附件换了输入框时，后挂上的那个不能被先卸载的这个清掉
    return () => {
      if (host.current === show) host.current = null
    }
  }, [files.intakeHost])
  /** 卡片上的状态（插件给的，例如「3 帧」「点击选帧」）；认领它的插件关掉了时为空，照普通附件显示 */
  const status = useCallback(
    (x: { intake?: string; picks?: unknown[] }) =>
      x.intake ? intakeByKey(plugins.web.entries(), x.intake)?.status(x.picks?.length ?? 0) : undefined,
    [plugins],
  )
  const item = open ? files.items.find((x) => x.key === open) : undefined
  const path = item?.source ?? item?.done?.path
  const intake = item?.intake ? intakeByKey(plugins.web.entries(), item.intake) : undefined
  // 认领它的插件一直挂着弹窗（target 为空时是关着的）：开关有过渡，不用每次重新挂
  const Dialog = intake?.Dialog
  return {
    /** 打开某张卡片的插件弹窗 */
    open: setOpen,
    status,
    dialog: Dialog ? (
      <Dialog
        target={item && path ? { path, name: item.name, chosen: item.picks ?? [] } : null}
        onClose={() => setOpen(null)}
        onInsert={(list) => item && files.setPicks(item.key, list)}
      />
    ) : null,
  }
}
