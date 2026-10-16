import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AtSign, File as FileIcon, FileCode2, Loader2, Paperclip, Plus, X } from 'lucide-react'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type Attachment } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 输入框里正在上传或已经上传好的一个附件 */
interface Item {
  key: string
  name: string
  mime: string
  size: number
  /** 本地预览（图片），不用等上传完 */
  preview?: string
  done?: Attachment
}

export const isImage = (mime: string, name = '') =>
  mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 附件在页面上的地址：正式版从服务端的附件目录读，在线演示用内存里的内容 */
export async function attachmentUrl(a: Attachment) {
  if (import.meta.env.VITE_DEMO) return (await import('@/lib/demo-backend')).demoUploads.get(a.path)
  return `/api/uploads/raw?path=${encodeURIComponent(a.path)}`
}

const readBase64 = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })

/** 附件列表：选文件、粘贴、拖进来都走 add，选完马上上传 */
export function useAttachments() {
  const [items, setItems] = useState<Item[]>([])
  const count = useRef(0)
  count.current = items.length

  const add = useCallback(async (files: File[]) => {
    const room = MAX_ATTACHMENTS - count.current
    if (files.length > room) toast.error(`一次最多附上 ${MAX_ATTACHMENTS} 个文件`)
    for (const f of files.slice(0, Math.max(room, 0))) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`「${f.name}」超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
        continue
      }
      // 粘贴的截图没有像样的文件名
      const name =
        f.name && f.name !== 'image.png'
          ? f.name
          : `截图-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`
      const key = crypto.randomUUID()
      const preview = isImage(f.type, name) ? URL.createObjectURL(f) : undefined
      setItems((xs) => [...xs, { key, name, mime: f.type, size: f.size, preview }])
      try {
        const done = await api.upload({ name, mime: f.type, data: await readBase64(f) })
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, done } : x)))
      } catch (e) {
        toast.error(`「${name}」上传失败：${(e as Error).message}`)
        setItems((xs) => xs.filter((x) => x.key !== key))
      }
    }
  }, [])
  const remove = (key: string) => setItems((xs) => xs.filter((x) => x.key !== key))
  const clear = () => setItems([])
  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((x) => !x.done),
    attachments: items.flatMap((x) => (x.done ? [x.done] : [])),
  }
}

/** 粘贴、拖放文件到输入框：返回要挂到外层容器和输入框上的事件 */
export function useDropPaste(add: (f: File[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return {
    over,
    container: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: React.DragEvent) => hasFiles(e) && e.preventDefault(),
      onDragLeave: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        if (--depth.current <= 0) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        add([...e.dataTransfer.files])
      },
    },
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files]
      if (!files.length) return
      // 只粘了文件（截图）时不要把文件名当文字粘进去
      e.preventDefault()
      add(files)
    },
  }
}

/** 输入框上方的附件条：图片显示缩略图，其他文件显示名字和大小 */
export function AttachmentChips({ items, onRemove }: { items: Item[]; onRemove: (key: string) => void }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((x) => (
        <div
          key={x.key}
          className="group relative flex h-14 max-w-[240px] items-center gap-2.5 rounded-xl border bg-field/60 pr-3 pl-1.5"
          title={x.name}
        >
          {x.preview ? (
            <img src={x.preview} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-card text-subtle">
              <FileIcon className="h-5 w-5" strokeWidth={1.6} />
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px]">{x.name}</span>
            <span className="flex items-center gap-1 text-[11px] text-subtle">
              {!x.done && <Loader2 className="h-3 w-3 animate-spin" />}
              {x.done ? formatSize(x.size) : '上传中'}
            </span>
          </span>
          <button
            type="button"
            aria-label={`移除 ${x.name}`}
            onClick={() => onRemove(x.key)}
            className="absolute -top-1.5 -right-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full border bg-card text-muted opacity-0 shadow-card transition group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** 用户消息里的附件：图片缩略图，点开看原图；其他文件显示名字 */
export function MessageAttachments({ items, className }: { items: Attachment[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap justify-end gap-2', className)}>
      {items.map((a) => (
        <MessageAttachment key={a.path} a={a} />
      ))}
    </div>
  )
}

function MessageAttachment({ a }: { a: Attachment }) {
  const [url, setUrl] = useState<string>()
  const img = isImage(a.mime, a.name)
  useEffect(() => {
    if (img) void attachmentUrl(a).then(setUrl)
  }, [a, img])
  if (img && url)
    return (
      <a href={url} target="_blank" rel="noreferrer" title={a.name} className="block overflow-hidden rounded-xl border">
        <img src={url} alt={a.name} className="h-24 max-w-[200px] object-cover" />
      </a>
    )
  return (
    <span
      title={a.path}
      className="inline-flex h-9 max-w-[260px] items-center gap-2 rounded-xl border bg-field/60 px-3 text-[12.5px]"
    >
      <FileIcon className="h-4 w-4 shrink-0 text-subtle" strokeWidth={1.7} />
      <span className="truncate">{a.name}</span>
      <span className="shrink-0 text-[11px] text-subtle">{formatSize(a.size)}</span>
    </span>
  )
}

/** 输入框左下角的「+」：上传文件或图片、引用项目文件，和 Claude Code 一样也可以直接粘贴、拖进来、输入 @ */
export function AttachMenu({
  onFiles,
  onMention,
  canMention,
  className,
}: {
  onFiles: (f: File[]) => void
  onMention: () => void
  canMention: boolean
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <Popover>
        <PopoverTrigger
          aria-label="添加文件、图片或引用"
          title="添加文件、图片或引用"
          className={cn(
            'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
            className,
          )}
        >
          <Plus className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[260px]">
          <PopoverClose className={menuItem} onClick={() => input.current?.click()}>
            <Paperclip className="h-4 w-4 shrink-0 text-subtle" />
            <span className="flex-1">上传文件或图片</span>
            <span className="text-[11px] text-subtle">可粘贴 / 拖入</span>
          </PopoverClose>
          <PopoverClose className={menuItem} disabled={!canMention} onClick={onMention}>
            <AtSign className="h-4 w-4 shrink-0 text-subtle" />
            <span className="flex-1">引用项目文件</span>
            <span className="font-mono text-[11px] text-subtle">@</span>
          </PopoverClose>
        </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * 输入 @ 引用项目里的文件：光标前是「@关键字」时列出匹配的文件，上下键选、回车或 Tab 确认，
 * 选中后换成「@相对路径 」。Agent 在项目目录里执行，看到路径就能自己读。
 */
export function useFileMention(
  projectId: string | undefined,
  text: string,
  setText: (v: string) => void,
  ta: React.RefObject<HTMLTextAreaElement | null>,
) {
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)

  /** 根据光标位置判断是不是在输入 @ */
  const sync = useCallback(() => {
    const el = ta.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart ?? el.value.length)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    setQuery(m ? { q: m[2], start: before.length - m[2].length - 1 } : null)
    if (!m) setClosed(false)
  }, [ta])

  useEffect(() => {
    if (!query || !projectId || closed) return
    let off = false
    const t = setTimeout(() => {
      api
        .projectFiles(projectId, query.q)
        .then((fs) => {
          if (off) return
          setFiles(fs)
          setActive(0)
        })
        .catch(() => !off && setFiles([]))
    }, 120)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [query?.q, projectId, closed]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!query && !!projectId && !closed && files.length > 0

  const pick = (f: string) => {
    if (!query) return
    const el = ta.current
    const end = el?.selectionStart ?? text.length
    const ins = `@${f} `
    const next = text.slice(0, query.start) + ins + text.slice(end)
    setText(next)
    setQuery(null)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = query.start + ins.length
      el.setSelectionRange(pos, pos)
    })
  }

  /** 菜单打开时接管上下键、回车、Tab、Esc；返回 true 表示已处理 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + d + files.length) % files.length)
      return true
    }
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'Tab') {
      e.preventDefault()
      pick(files[active])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosed(true)
      return true
    }
    return false
  }

  /** 菜单里的「引用项目文件」：在光标处插入 @ */
  const start = () => {
    const el = ta.current
    if (!el) return
    const pos = el.selectionStart ?? text.length
    const pre = text.slice(0, pos)
    const ins = pre && !/\s$/.test(pre) ? ' @' : '@'
    setText(pre + ins + text.slice(pos))
    setClosed(false)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos + ins.length, pos + ins.length)
      sync()
    })
  }

  const menu = open ? (
    <div
      role="listbox"
      aria-label="项目文件"
      className="absolute right-3 bottom-full left-3 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop"
    >
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">项目文件 · ↑↓ 选择，回车确认</div>
      {files.map((f, i) => {
        const cut = f.lastIndexOf('/')
        return (
          <button
            key={f}
            type="button"
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(f)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
              i === active ? 'bg-sel text-fg' : 'text-muted',
            )}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="shrink-0 font-mono">{f.slice(cut + 1)}</span>
            {cut > 0 && <span className="truncate font-mono text-[11.5px] text-subtle">{f.slice(0, cut)}</span>}
          </button>
        )
      })}
    </div>
  ) : null

  return { sync, onKeyDown, start, menu }
}
