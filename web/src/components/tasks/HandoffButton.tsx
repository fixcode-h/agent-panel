import { useState } from 'react'
import { FolderGit2, FolderInput, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { attachChip, chipMarker } from '@shared/composer'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useData, useNav } from '@/lib/data'
import { IconButton } from '@/components/ui/icon-button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { presetDraft } from '@/components/chat/ChatComposer'
import { presetAttachments } from '@/components/chat/Attachments'

/**
 * Chat 页对话的「在项目里继续」（设计报告 Chat P0-1）：按 ADR 0038 的分工，要派子任务、走项目流程得到项目里做，
 * 以前只能自己复制粘贴。选一个项目：这段聊天整理成一份记录（和「引入会话」同一份，AI 拿它当参考、不会重新执行），
 * 放进那个项目新建对话的输入框，再写一句要求发出去——不替用户直接开跑，要做什么由用户说
 */
export function HandoffButton({ taskId }: { taskId: string }) {
  const { projects } = useData()
  const { go: nav } = useNav()
  const [busy, setBusy] = useState(false)
  if (!projects.length) return null
  const go = async (projectId: string) => {
    if (busy) return
    setBusy(true)
    try {
      const record = await api.taskTranscript(taskId)
      // 项目工作区新建对话的输入框（TaskComposer 的 draftKey）
      const key = `new:project:${projectId}`
      presetAttachments(key, [record])
      // 发给 Agent 的话：不翻译（会作为用户消息交给 CLI）。附件在输入框里是文字里的一张卡片，没有卡片标记就看不见
      presetDraft(key, `${chipMarker(attachChip(record), record.name)} 接着附上的这段聊天，在这个项目里继续：`)
      nav({ page: 'projects', id: projectId })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          size="sm"
          tone="bare"
          label={t('在项目里继续')}
          title={t('带上这段聊天，到项目里新建对话接着做（可以开子对话、跑工作流）')}
          disabled={busy}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
        </IconButton>
      </MenuTrigger>
      <MenuContent>
        <p className="px-2.5 pt-1 pb-1.5 text-caption text-subtle">{t('带上这段聊天，到哪个项目里继续')}</p>
        {projects.map((p) => (
          <MenuItem key={p.id} onSelect={() => void go(p.id)}>
            <FolderGit2 className="h-4 w-4" />
            <span className="min-w-0 truncate">{p.name}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
