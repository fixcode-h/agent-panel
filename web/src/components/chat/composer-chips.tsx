// 输入框里附件卡片的通用逻辑：加文件、引入会话、点卡片查看、删卡片、粘贴路径认回卡片。
// 对话输入框（ChatComposer）和新建任务的输入框（TaskComposer）共用
import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from 'react'
import { chipMarker, chips, dropChip, findPaths, isAttachChip, type ChipKind } from '@shared/composer'
import type { Attachment } from '@shared/schema'
import { api } from '@/lib/api'
import { useDropPaste, type AttachHooks, type useAttachments } from './Attachments'
import { AttachmentViewer, viewOf, type ViewTarget } from './AttachmentView'
import type { ChipActions, RichInputHandle } from './RichInput'

/** 文字里附件卡片的名字 */
const attachNames = (text: string) => new Set(chips(text).flatMap((c) => (isAttachChip(c.kind) ? [c.name] : [])))

export function useComposerChips({
  files,
  editor,
  text,
  change,
  dropScope,
}: {
  files: ReturnType<typeof useAttachments>
  editor: RefObject<RichInputHandle | null>
  /** 输入框现在的内容：卡片被删掉时据此找出不再发送的附件 */
  text: string
  change: (v: string) => void
  dropScope?: HTMLElement | null
}) {
  const shown = useRef(text)
  shown.current = text
  const insert = useCallback(
    (items: { name: string; kind: ChipKind }[]) =>
      items.forEach((x) => editor.current?.insertChip({ kind: x.kind, name: x.name })),
    [editor],
  )
  /** 附件加进来时在光标处放一张卡片；上传失败就把卡片撤掉 */
  const hooks = useMemo<AttachHooks>(
    () => ({ added: insert, failed: (name) => change(dropChip(editor.current?.text() ?? '', name)) }),
    [insert, change, editor],
  )
  const addFiles = useCallback((list: File[]) => void files.add(list, hooks), [files, hooks])
  const addReady = useCallback((a: Attachment) => files.addReady(a, hooks), [files, hooks])
  /** 引用一段内容：放到输入框末尾 */
  const addQuote = useCallback(
    (quoted: string) => {
      const ed = editor.current
      if (!ed) return
      ed.focus()
      ed.setCaret(Number.MAX_SAFE_INTEGER)
      files.addQuote(quoted, hooks)
    },
    [editor, files, hooks],
  )

  /**
   * 文字变了：卡片被退格删掉、整段剪掉时，它背后的附件也不再发送（以前只有点右上角删除才会去掉附件，
   * 退格删掉的图片照样发了出去）
   */
  const onChange = useCallback(
    (v: string) => {
      const before = attachNames(shown.current)
      const after = attachNames(v)
      const gone = new Set([...before].filter((n) => !after.has(n)))
      if (gone.size) files.removeNames(gone)
      shown.current = v
      change(v)
    },
    [files, change],
  )

  /** 图片卡片显示图片本身 */
  const preview = useCallback((name: string) => files.items.find((x) => x.name === name)?.preview, [files.items])
  const [view, setView] = useState<ViewTarget | null>(null)
  const chipActions = useMemo<ChipActions>(
    () => ({
      open: (chip) => {
        const item = files.items.find((x) => x.name === chip.name)
        const images = files.items.flatMap((x) => (x.preview ? [{ src: x.preview, name: x.name }] : []))
        // 还在上传的引用也能看原文；还在上传的文件没有路径，等传完再看
        const a =
          item?.done ??
          (item?.quote !== undefined ? { name: item.name, path: '', size: 0, mime: '', quote: item.quote } : undefined)
        const v = viewOf(chip.kind, chip.name, a, images)
        if (v) setView(v)
      },
      remove: (name) => {
        const item = files.items.find((x) => x.name === name)
        if (!item) return
        files.remove(item.key)
        change(dropChip(editor.current?.text() ?? '', item.name))
      },
    }),
    [files, change, editor],
  )

  const drop = useDropPaste(addFiles, dropScope)

  /**
   * 粘贴：有文件（截图、从文件管理器复制的文件）照旧上传一份；
   * 只有文字时找里面的本机路径，确认是真实存在的文件就换成卡片，直接引用那个文件，不再拷贝
   * （复制对话里的消息得到的就是这些路径）
   */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      drop.onPaste(e)
      if (e.defaultPrevented) return
      const pasted = e.clipboardData.getData('text/plain')
      const hits = findPaths(pasted)
      const ed = editor.current
      if (!hits.length || !ed) return
      e.preventDefault()
      // 等服务端确认的这一小会儿光标可能被挪走：记下粘贴时的位置
      const at = ed.caret()
      const put = (value: string) => {
        ed.focus()
        ed.setCaret(at)
        ed.insert(value)
      }
      void api
        .resolvePaths([...new Set(hits.map((h) => h.path))])
        .then(({ files: found }) => {
          const byFrom = new Map(found.map(({ from, ...a }) => [from, a]))
          const names = files.addRefs([...byFrom.values()])
          let out = ''
          let last = 0
          for (const h of hits) {
            const a = byFrom.get(h.path)
            const chip = a && names.get(a.path)
            if (!chip) continue
            out += pasted.slice(last, h.start)
            // 卡片两边留空格，和在输入框里插卡片一样，不跟文字粘在一起
            if (out && !/\s$/.test(out)) out += ' '
            out += chipMarker(chip.kind, chip.name)
            last = h.end
            if (!/^\s/.test(pasted.slice(last))) out += ' '
          }
          put(out + pasted.slice(last))
        })
        .catch(() => put(pasted))
    },
    [drop, editor, files],
  )

  return {
    addFiles,
    addReady,
    addQuote,
    onChange,
    onPaste,
    preview,
    chipActions,
    drop,
    viewer: <AttachmentViewer target={view} onClose={() => setView(null)} />,
  }
}
