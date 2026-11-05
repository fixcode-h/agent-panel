import { useCallback, useRef } from 'react'
import { copyText } from '@shared/composer'
import { t } from '@shared/i18n'
import { useAttachments } from '@/components/chat/Attachments'
import { ChatComposer } from '@/components/chat/ChatComposer'
import type { RichInputHandle } from '@/components/chat/RichInput'

/**
 * 诊断报告弹窗的「整体意见」框直接用对话的输入框（用户 2026-11-05 要的）：日志文件、截图粘贴、拖进来、
 * 「+」里选文件都和对话里一样——先在本机找回原路径，小于设置里「大文件」阈值的后台拷一份，更大的直接引用原路径，
 * 交给 AI 的是路径，不再把整份文件上传成附件。图片和对话里一样，发送时由服务端拷进对话目录给 CLI 看
 */
export function useLogFiles() {
  const att = useAttachments()
  const list = att.attachments
  return {
    files: att,
    /** 交出去的那份：拷好的用副本路径，大文件和拷贝中的用原路径 */
    list,
    /** 还没拿到路径（查找中、截图上传中）：拦住提交 */
    busy: att.uploading,
    reset: att.clear,
    /** 输入框里的文字换成交给 AI 的样子：文件、图片卡片换成「@路径」 */
    plain: useCallback((text: string) => copyText(text, list), [list]),
  }
}

/** 整体意见框：对话输入框去掉发送按钮；Enter 换行（提交走弹窗底部的按钮） */
export function OverallComposer({
  value,
  onChange,
  logs,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  logs: ReturnType<typeof useLogFiles>
  placeholder: string
  disabled?: boolean
}) {
  const box = useRef<RichInputHandle>(null)
  return (
    <ChatComposer
      size="sm"
      value={value}
      onChange={onChange}
      onSubmit={() => {}}
      files={logs.files}
      taRef={box}
      label={t('整体意见')}
      placeholder={placeholder}
      disabled={disabled}
      attach={{}}
      actions={<></>}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey) return false
        e.preventDefault()
        box.current?.insert('\n')
        return true
      }}
    />
  )
}
