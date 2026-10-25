// 输入框里附件卡片的通用逻辑：加文件、引入会话、点卡片查看、删卡片、粘贴路径认回卡片。
// 对话输入框（ChatComposer）和新建任务的输入框（TaskComposer）共用
import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from 'react'
import { Copy, FileText, Image as ImageIcon } from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  chipMarker,
  chips,
  dropChip,
  findPaths,
  isAttachChip,
  solePath,
  type Chip,
  type ChipKind,
} from '@shared/composer'
import { MAX_ATTACHMENTS, type Attachment } from '@shared/schema'
import { api } from '@/lib/api'
import { attachmentUrl } from './Attachments'
import { copyImage, imageCopyBlocked } from '@/lib/clipboard-image'
import { isElementRefText, pasteElementRefs, wrapElementRef } from '@/lib/element-ref'
import { MenuItem, PointMenu, MenuSeparator } from '@/components/ui/menu'
import { useData } from '@/lib/data'
import { insertFileRef, useFileRefDrop } from '@/lib/fileDrag'
import { t } from '@shared/i18n'
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
  const { settings } = useData()
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
  // 右键卡片弹出的菜单：位置是鼠标坐标；关闭时把焦点交回输入框
  const [menu, setMenu] = useState<{ chip: Chip; at: { x: number; y: number } } | null>(null)
  const closeMenu = useCallback(() => {
    setMenu(null)
    editor.current?.focus()
  }, [editor])
  const itemOf = useCallback((name: string) => files.items.find((x) => x.name === name), [files.items])

  /**
   * 卡片背后的原始图片：还在上传的卡片用本地预览（就是用户选的那个文件），
   * 传完的按附件地址再取一次（在线演示里是内存里的 blob）
   */
  const imageBlob = useCallback(
    async (name: string) => {
      const item = itemOf(name)
      if (!item) throw new Error(t('这张卡片已经不在输入框里了'))
      if (!item.done && !item.preview) throw new Error(t('图片还在上传，稍等一下再复制'))
      const url = item.done ? await attachmentUrl(item.done) : item.preview
      if (!url) throw new Error(t('读不到这张图片的内容'))
      const res = await fetch(url)
      if (!res.ok) throw new Error(t('读不到这张图片的内容'))
      return await res.blob()
    },
    [itemOf],
  )
  /** 复制图片到系统剪贴板：成功、失败都提示，不静默 */
  const copyImageOf = useCallback(
    (name: string) => {
      void imageBlob(name)
        .then(copyImage)
        .then(
          () => toast.success(t('图片已复制到剪贴板')),
          (e: Error) => toast.error(t('复制图片失败：{msg}', { msg: e.message })),
        )
    },
    [imageBlob],
  )
  /** 复制文字（文件路径、引用原文） */
  const copyTextOf = useCallback((text: string, done: string) => {
    if (!text) return toast.error(t('这张卡片没有可复制的内容'))
    void navigator.clipboard.writeText(text).then(
      () => toast.success(done),
      (e: Error) => toast.error(t('复制失败：{msg}', { msg: e.message })),
    )
  }, [])
  /**
   * 一张卡片复制到剪贴板时写什么：和右键菜单的两项一样——引用写带标记的原文（粘回输入框还原成同一张卡片），
   * 其他附件写它的本机路径（粘回输入框按路径认回卡片，见 lib/element-ref.ts、onPaste）
   */
  const copyOfChip = useCallback(
    (chip: Chip): string | undefined => {
      const item = files.items.find((x) => x.name === chip.name)
      const done = item?.done
      if (chip.kind === 'quote') {
        // 原文在本地就有（addQuote 时写入），不等上传完成
        const text = item?.quote ?? done?.quote ?? ''
        if (!text) return undefined
        return isElementRefText(text) ? wrapElementRef(text) : text
      }
      if (isAttachChip(chip.kind)) return done?.path || undefined
      // Skill / 命令没有背后文件：写成「/名字」，粘回去当普通文字
      return `/${chip.name}`
    },
    [files.items],
  )
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
      context: (chip, at) => setMenu({ chip, at }),
    }),
    [files, change, editor],
  )

  /** 右键卡片的菜单：图片能复制图片，文件复制路径，引用复制原文；菜单项用面板统一样式 */
  const chipMenu = menu ? (
    <PointMenu at={menu.at} open onOpenChange={(v) => !v && closeMenu()}>
      {menu.chip.kind === 'image' && (
        <>
          <MenuItem
            disabled={!!imageCopyBlocked()}
            onSelect={() => {
              copyImageOf(menu.chip.name)
              closeMenu()
            }}
          >
            <ImageIcon className="h-4 w-4" />
            {t('复制图片')}
          </MenuItem>
          {/* 禁用时把原因写出来，用户才知道为什么点不动 */}
          {imageCopyBlocked() && (
            <div className="px-2.5 pb-1.5 text-[0.6875rem] leading-snug text-subtle">{imageCopyBlocked()}</div>
          )}
          <MenuSeparator />
        </>
      )}
      {menu.chip.kind === 'file' && (
        <MenuItem
          disabled={!copyOfChip(menu.chip)}
          onSelect={() => {
            copyTextOf(copyOfChip(menu.chip) ?? '', t('路径已复制'))
            closeMenu()
          }}
        >
          <FileText className="h-4 w-4" />
          {t('复制路径')}
        </MenuItem>
      )}
      {menu.chip.kind === 'quote' && (
        <MenuItem
          onSelect={() => {
            copyTextOf(copyOfChip(menu.chip) ?? '', t('引用内容已复制'))
            closeMenu()
          }}
        >
          <Copy className="h-4 w-4" />
          {t('复制内容')}
        </MenuItem>
      )}
    </PointMenu>
  ) : null

  const drop = useDropPaste(addFiles, dropScope)
  // 文件树里右键拖过来的文件 / 文件夹：松手时在光标处插入 @路径，不当附件上传
  const dropRef = useRef<HTMLDivElement>(null)
  const refOver = useFileRefDrop(dropRef, (item) => {
    const ed = editor.current
    if (ed) insertFileRef(ed, item)
  })

  /**
   * 粘贴：有文件（截图、从文件管理器复制的文件）照旧上传一份（大文件只引用原路径，见 useAttachments 的 add）；
   * 很长的纯文字存成文本文件放卡片；
   * 只有文字时找里面的本机路径，确认是真实存在的文件就换成卡片，直接引用那个文件，不再拷贝
   * （复制对话里的消息得到的就是这些路径）
   */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      drop.onPaste(e)
      if (e.defaultPrevented) return
      const pasted = e.clipboardData.getData('text/plain')
      const ed = editor.current
      /**
       * 抓取的元素引用（带 [元素引用] 标记，见 lib/element-ref.ts）：每块换回一张引用卡片。
       * 原文就在粘贴的文字里，所以从别的对话、别的浏览器标签页、甚至另一个面板实例粘过来都能还原，
       * 不依赖本地存储和服务端地址。标记不完整的按普通文字走下面的流程
       */
      const room = Math.max(0, MAX_ATTACHMENTS - files.items.length)
      const quoted = ed
        ? pasteElementRefs(
            pasted,
            (ref) => {
              let name: string | undefined
              files.addQuote(ref, { added: (items) => (name = items[0]?.name), failed: hooks.failed })
              return name
            },
            room,
          )
        : undefined
      // made 为 0 时没有卡片可放，交给下面的超长 / 路径流程处理原文
      if (ed && quoted && quoted.made > 0) {
        // 没换成卡片的引用会按普通文字留在输入框里（内容不丢），但不能默默不提一句
        if (quoted.kept > 0) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
        e.preventDefault()
        // 卡片背后的附件 addQuote 已经放好了，这里把卡片标记和其余文字插回粘贴的位置
        const at = ed.caret()
        ed.focus()
        ed.setCaret(at)
        ed.insert(quoted.text)
        return
      }
      // 很长的一段文字（日志、整份文档）存成文本文件，输入框里放它的卡片，不把消息撑满
      const longAt = settings?.longPasteChars ?? 5000
      if (longAt > 0 && pasted.length > longAt) {
        e.preventDefault()
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
        addFiles([new File([pasted], `${t('粘贴的文字')}-${stamp}.txt`, { type: 'text/plain' })])
        return
      }
      const hits = findPaths(pasted)
      // 整段就一个路径（复制对话、复制文件路径）：只认这一个，粘贴后就是一张卡片
      const sole = solePath(pasted)
      const refs = sole ? [{ start: 0, end: pasted.length, path: sole }] : hits
      if (!refs.length || !ed) return
      e.preventDefault()
      // 等服务端确认的这一小会儿光标可能被挪走：记下粘贴时的位置
      const at = ed.caret()
      const put = (value: string) => {
        ed.focus()
        ed.setCaret(at)
        ed.insert(value)
      }
      void api
        .resolvePaths([...new Set(refs.map((h) => h.path))])
        .then(({ files: resolved }) => {
          const byFrom = new Map(resolved.map(({ from, ...a }) => [from, a]))
          const names = files.addRefs([...byFrom.values()])
          let out = ''
          let last = 0
          for (const h of refs) {
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
    [drop, editor, files, hooks, settings, addFiles],
  )

  return {
    addFiles,
    addReady,
    addQuote,
    onChange,
    onPaste,
    preview,
    chipActions,
    copyOfChip,
    drop,
    /** 绑到输入框外层容器上：接住文件树拖过来的引用 */
    dropRef,
    /** 现在有没有拖到输入框上（高亮用） */
    refOver,
    /** 右键卡片弹出的菜单，和 viewer 一样挂在输入框外层 */
    chipMenu,
    viewer: <AttachmentViewer target={view} onClose={() => setView(null)} />,
  }
}
