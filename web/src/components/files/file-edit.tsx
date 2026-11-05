import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { highlightAll, type Hljs } from '@/lib/file-highlight'
import { indentEdit, indentUnit } from '@/lib/text-indent'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

/**
 * 文件弹窗的「阅读 / 编辑」：任务页点开的文件和文件浏览页共用同一套切换和保存逻辑（FileViewDialog），
 * 两处的手感一致。阅读时 Markdown 按对话里的样式渲染、代码带行号；编辑时直接改源码。
 */
export type FileMode = 'read' | 'edit'

/** Markdown 文件：阅读模式渲染成文档，编辑模式改源码 */
export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path)

/** 编辑区超过这么多字就不铺高亮：每敲一个字都要整段重新高亮，太大的文件会卡 */
const HIGHLIGHT_MAX = 200_000

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

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 编辑区：透明文字的输入框叠在一层高亮过的同样内容上，字体、行高、内边距完全一致，滚动时底图跟着挪，
 * 看起来就是带颜色的编辑器，输入、选中、撤销都还是原生输入框。不带行号（行号会随输入变，写起来反而碍眼）。
 * Tab / Shift+Tab 缩进和取消缩进（多行选中时整行），缩进单位按文件已有的缩进猜；
 * 带行号打开时把那一行滚到中间、光标放在行首。
 */
export function FileEditor({ ed, line, path, hl }: { ed: FileEditing; line?: number; path: string; hl: Hljs | null }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const under = useRef<HTMLPreElement>(null)
  // 高亮跟在输入后面一点：大文件连续打字时先让输入框跟上，底图稍后补上颜色
  const deferred = useDeferredValue(ed.text)
  const html = useMemo(() => {
    const code = deferred.length > HIGHLIGHT_MAX ? null : highlightAll(hl, deferred, path)
    // 结尾补一行：输入框最后是换行时底图也要多出这一行，滚到底才对得齐
    return (code ?? escapeHtml(deferred)) + '\n '
  }, [deferred, hl, path])
  const sync = () => {
    const a = ref.current
    const b = under.current
    if (!a || !b) return
    b.scrollTop = a.scrollTop
    b.scrollLeft = a.scrollLeft
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (!line) return
    const at =
      ed.text
        .split('\n')
        .slice(0, line - 1)
        .join('\n').length + (line > 1 ? 1 : 0)
    el.setSelectionRange(at, at)
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 2)
    sync()
    // 只在进编辑时定位一次，之后打字不跟着跳
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const indent = (el: HTMLTextAreaElement, outdent: boolean) => {
    const r = indentEdit(el.value, el.selectionStart, el.selectionEnd, outdent, indentUnit(el.value))
    if (!r) return
    el.setSelectionRange(r.from, r.to)
    // 走 insertText 让浏览器记进撤销栈（Ctrl+Z 能撤回这次缩进）；不支持时退回直接改值
    const ok = r.insert ? document.execCommand('insertText', false, r.insert) : document.execCommand('delete', false)
    if (!ok) ed.setText(el.value.slice(0, r.from) + r.insert + el.value.slice(r.to))
    requestAnimationFrame(() => el.setSelectionRange(r.selStart, r.selEnd))
  }
  // 两层的字体、行高、内边距、不折行必须一致，否则字会错位
  const layer = 'm-0 px-4 py-2 font-mono text-footnote leading-[1.6] whitespace-pre [tab-size:4]'
  return (
    <div className="relative h-full w-full overflow-hidden">
      <pre
        ref={under}
        aria-hidden
        className={`pointer-events-none absolute inset-0 overflow-hidden text-fg/90 ${layer}`}
        // 高亮结果是 highlight.js 生成的（内容已经过它转义）；认不出语言时自己转义
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={ref}
        value={ed.text}
        wrap="off"
        onChange={(e) => ed.setText(e.target.value)}
        onScroll={sync}
        onKeyDown={(e) => {
          // 编辑时随时能按 Ctrl/Cmd+S 保存，不用点按钮
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void ed.save()
          } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            indent(e.currentTarget, e.shiftKey)
          }
        }}
        aria-label={t('文件内容')}
        spellCheck={false}
        className={`absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-fg outline-none selection:bg-accent/25 selection:text-transparent ${layer}`}
      />
    </div>
  )
}
