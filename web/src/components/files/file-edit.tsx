import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { escapeHtml, highlightLines, type Hljs } from '@/lib/file-highlight'
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

/** 底图一次画多少行（按这个对齐）：滚动跨过一块才重新高亮，平时滚动只挪位置 */
const BLOCK = 60
/** 高亮从可见区往上多带这么多行：块注释、多行字符串从上面开始时，可见的这几行颜色也对 */
const CONTEXT = 300

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

/**
 * 编辑区：透明文字的输入框叠在一层高亮过的同样内容上，字体、行高、内边距完全一致，滚动时底图跟着挪，
 * 看起来就是带颜色的编辑器，输入、选中、撤销都还是原生输入框。不带行号（行号会随输入变，写起来反而碍眼）。
 * Tab / Shift+Tab 缩进和取消缩进（多行选中时整行），缩进单位按文件已有的缩进猜；
 * 带行号打开时把那一行滚到中间、光标放在行首。
 *
 * 底图只画看得见的那几十行：以前每敲一个字都把整个文件重新高亮、整段换掉底图，一百多 KB 的文件打一个字卡一下。
 * 现在按 BLOCK 行对齐取一段（往上多带 CONTEXT 行一起高亮，多行注释的颜色才对），滚动时只挪位置，跨块才重画。
 */
export function FileEditor({ ed, line, path, hl }: { ed: FileEditing; line?: number; path: string; hl: Hljs | null }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  // 高亮跟在输入后面一点：大文件连续打字时先让输入框跟上，底图稍后补上颜色
  const deferred = useDeferredValue(ed.text)
  const lines = useMemo(() => deferred.split('\n'), [deferred])
  /** 底图画的是哪几行（[from, to)，按 BLOCK 对齐） */
  const [win, setWin] = useState({ from: 0, to: BLOCK * 2 })
  // 滚动、改大小的回调里读最新的那一段（ResizeObserver 只在挂上时接一次，闭包里的 win 会过期）
  const winRef = useRef(win)
  winRef.current = win
  const html = useMemo(() => {
    const from = Math.min(win.from, lines.length)
    const to = Math.min(win.to, lines.length)
    const ctx = Math.max(0, from - CONTEXT)
    const hlLines = highlightLines(hl, lines.slice(ctx, to).join('\n'), path)
    let out = ''
    for (let i = from; i < to; i++) {
      // 认不出语言、超长的行（highlightLines 给的是 undefined）按纯文本画，自己转义
      out += (hlLines?.[i - ctx] ?? escapeHtml(lines[i])) + '\n'
    }
    // 结尾补一行：输入框最后是换行时底图也要多出这一行，滚到底才对得齐
    return out + ' '
  }, [lines, win, hl, path])
  /**
   * 每行实际占多高：按输入框的内容总高除以行数算。不能直接用 CSS 的行高（19.2px）：浏览器排版按 1/64 像素取整，
   * 每行差一点点，滚到一千多行时底图就错开整整一行
   */
  const rowH = () => {
    const a = ref.current
    if (!a) return 20
    const cs = getComputedStyle(a)
    const css = parseFloat(cs.lineHeight) || 20
    if (a.scrollHeight <= a.clientHeight) return css
    const rows = a.value.split('\n').length
    const h = (a.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / rows
    return h > 0 ? h : css
  }
  // 底图的位置：画的第一行（win.from）应该在的位置减去滚掉的距离。只改 transform，不触发重新渲染
  const place = () => {
    const a = ref.current
    const b = inner.current
    if (!a || !b) return
    b.style.transform = `translate(${-a.scrollLeft}px, ${winRef.current.from * rowH() - a.scrollTop}px)`
  }
  const sync = () => {
    const a = ref.current
    if (!a) return
    const h = rowH()
    const first = Math.floor(a.scrollTop / h)
    const last = Math.ceil((a.scrollTop + a.clientHeight) / h)
    // 上下各多留一块，滚一点点不用重画
    const from = Math.max(0, (Math.floor(first / BLOCK) - 1) * BLOCK)
    const to = (Math.floor(last / BLOCK) + 2) * BLOCK
    const w = winRef.current
    if (from !== w.from || to !== w.to) setWin({ from, to })
    else place()
  }
  // 换了一段（或内容变了）之后按新的起点摆一次；必须在绘制前，不然会闪一帧错位
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(place, [html])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 弹窗改了大小（可见行数变了）也要重新取一段
    const ro = new ResizeObserver(() => sync())
    ro.observe(el)
    return () => ro.disconnect()
    // sync 每次渲染都是新函数，只在挂上时接一次；它读的是 winRef，不会用到过期的那一段
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
    el.scrollTop = Math.max(0, (line - 1) * rowH() - el.clientHeight / 2)
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
      <pre aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden text-fg/90 ${layer}`}>
        <div
          ref={inner}
          className="will-change-transform"
          // 高亮结果是 highlight.js 生成的（内容已经过它转义）；纯文本的行自己转义过
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
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
