import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

/**
 * 文件弹窗的「阅读 / 编辑」：任务页点开的文件和文件浏览页共用同一套切换和保存逻辑（FileViewDialog），
 * 两处的手感一致。阅读时 Markdown 按对话里的样式渲染、代码带行号；编辑时直接改源码。
 */
export type FileMode = 'read' | 'edit'

/** Markdown 文件：阅读模式渲染成文档，编辑模式改源码 */
export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path)

/**
 * 编辑状态：draft 为 null 表示还没进过编辑。切回阅读时不丢草稿，阅读里看到的是改过的内容
 * （改 Markdown 时切过去就能看渲染效果），保存或放弃之后才回到盘上的内容。
 */
export function useFileEditing({
  content,
  write,
  reload,
  resetKey,
  startEdit,
}: {
  /** 盘上的内容；文件还没读回来时是 undefined */
  content: string | undefined
  /** 保存：force 为 false 时带上打开时的修改时间，被别人改过会抛 409；抛错时把原因显示在标题栏下面 */
  write: (text: string, force: boolean) => Promise<void>
  /** 放弃修改后重新读一遍盘上的内容（可能已经被 Agent 改过） */
  reload: () => void
  /** 换了文件时重置（传路径、行号这类能区分一次打开的值） */
  resetKey: unknown
  /** 一打开就进编辑：带行号打开 Markdown 时要看那一行，渲染后的文档对不上行号 */
  startEdit: boolean
}) {
  const [mode, setMode] = useState<FileMode>('read')
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /** 保存时发现文件在打开之后被改过：等用户决定要不要覆盖 */
  const [conflict, setConflict] = useState(false)
  useEffect(() => {
    setMode(startEdit ? 'edit' : 'read')
    setDraft(null)
    setSaveError('')
    setConflict(false)
    // 只在换了一次打开时重置；startEdit 跟着 resetKey 一起变，不单独触发
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  const text = draft ?? content ?? ''
  const dirty = draft !== null && content !== undefined && draft !== content
  const save = async (force = false) => {
    if (!dirty || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await write(draft!, force)
      setDraft(null)
      setConflict(false)
      toast.success(t('已保存'))
    } catch (e) {
      // 被别人改过：不报错，弹确认问要不要覆盖；越界、太大、文件不在了这类错误由后端给原因，原文显示
      if ((e as { status?: number }).status === 409 && !force) setConflict(true)
      else setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const discard = () => {
    setDraft(null)
    setSaveError('')
    setConflict(false)
    reload()
  }
  return {
    mode,
    setMode,
    text,
    setText: setDraft,
    dirty,
    saving,
    saveError,
    save,
    discard,
    conflict,
    setConflict,
  }
}

export type FileEditing = ReturnType<typeof useFileEditing>

/** 标题栏右侧：阅读 / 编辑切换；有没保存的修改时跟着放弃和保存 */
export function FileModeBar({ ed }: { ed: FileEditing }) {
  return (
    <>
      <Segmented
        size="sm"
        // 标题栏一排都是 24px 高：段控件整体压到 24px（每段 20px），不折行、不被挤窄
        className="shrink-0 flex-nowrap *:h-5 *:px-2 *:whitespace-nowrap"
        label={t('阅读或编辑')}
        value={ed.mode}
        onChange={ed.setMode}
        options={[
          { id: 'read', label: t('阅读') },
          { id: 'edit', label: t('编辑') },
        ]}
      />
      {ed.dirty && (
        <>
          <Button variant="ghost" size="sm" className="h-6" onClick={ed.discard}>
            {t('放弃修改')}
          </Button>
          <Button size="sm" className="h-6" disabled={ed.saving} onClick={() => void ed.save()}>
            {ed.saving ? t('保存中') : t('保存')}
          </Button>
        </>
      )}
    </>
  )
}
