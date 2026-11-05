import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Attachment, Task } from '@shared/schema'
import { convChanges } from '@shared/conv-changes'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 撤回到某条消息、重新生成最后一条回复（设计报告 Agent P0-2、Chat P0-3）。
 * 以前撤回只截对话，代码还停在被撤掉的那几轮之后；现在可以连同那几轮改的文件一起撤（服务端 /rewind 的 files），
 * 撤不干净（之后又被改过）时什么都不动，把冲突说清楚
 */

type Rewound = { task: Task; text: string; attachments: Attachment[] }

/** 撤不干净时的提示：列前几个文件，多的写个数 */
function conflictToast(conflicts: { path: string; reason: string }[]) {
  const head = conflicts
    .slice(0, 3)
    .map((c) => c.path)
    .join('、')
  toast.error(
    t('有 {n} 个文件撤不干净，什么都没动：{files}。这些地方之后又被改过，请在编辑器里手动处理。', {
      n: conflicts.length,
      files: conflicts.length > 3 ? `${head}…` : head,
    }),
  )
}

/** 这条消息和之后几轮改过的文件（没撤销过的） */
const laterFiles = (task: Pick<Task, 'messages'>, messageId: string) => {
  const i = task.messages.findIndex((m) => m.id === messageId)
  return i < 0 ? [] : convChanges(task.messages.slice(i)).files
}

/** 撤回确认框：这条之后的几轮改过文件时，多一个「同时撤销这些改动」（默认勾上） */
export function RewindDialog({
  task,
  messageId,
  onClose,
  onDone,
}: {
  task: Pick<Task, 'id' | 'messages'>
  messageId: string
  onClose: () => void
  onDone: (r: Rewound) => void
}) {
  const files = messageId ? laterFiles(task, messageId) : []
  const [undo, setUndo] = useState(true)
  return (
    <ConfirmDialog
      open={!!messageId}
      onOpenChange={(o) => !o && onClose()}
      title={t('撤回到这条消息？')}
      description={
        files.length
          ? t(
              '这条消息和之后的对话会去掉，内容放回输入框，改了可以再发。Agent 会从这条之前接着聊；这期间建的计划作废、开的子对话停下并归档。',
            )
          : t(
              '这条消息和之后的对话会去掉，内容放回输入框，改了可以再发。Agent 会从这条之前接着聊；这期间建的计划作废、开的子对话停下并归档。这几轮没有改过文件。',
            )
      }
      extra={
        files.length > 0 && (
          <Checkbox
            checked={undo}
            onChange={setUndo}
            label={t('同时撤销这几轮改的 {n} 个文件', { n: files.length })}
            tip={t(
              '文件恢复成这条消息之前的样子，这几轮新建的文件会删掉；之后你或别的对话在这些文件里的改动会保留。改到同一处时什么都不撤，会列出冲突。',
            )}
          />
        )
      }
      confirmText={t('撤回')}
      onConfirm={async () => {
        try {
          const r = await api.rewindTask(task.id, messageId, files.length > 0 && undo)
          if (!r.ok) return conflictToast(r.conflicts)
          onDone(r)
          onClose()
        } catch (e) {
          toast.error((e as Error).message)
        }
      }}
    />
  )
}

/**
 * 最后一条回复下面的「重新生成」：撤回最后一条用户消息（连同那一轮改的文件），再把原文和附件原样发一次。
 * 撤不干净时什么都不动，提示冲突
 */
export function RegenerateButton({
  task,
  onRewound,
  send,
}: {
  task: Pick<Task, 'id' | 'messages'>
  onRewound: (task: Task) => void
  send: (text: string, attachments: Attachment[]) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const last = [...task.messages].reverse().find((m) => m.role === 'user' && !m.step)
  if (!last) return null
  return (
    <IconButton
      size="sm"
      icon={RotateCcw}
      label={t('重新生成')}
      title={t('重新生成这条回复：撤回最后一条消息和这一轮改的文件，再原样发一次')}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await api.rewindTask(task.id, last.id, laterFiles(task, last.id).length > 0)
          if (!r.ok) return conflictToast(r.conflicts)
          onRewound(r.task)
          await send(r.text, r.attachments ?? [])
        } catch (e) {
          toast.error((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}
