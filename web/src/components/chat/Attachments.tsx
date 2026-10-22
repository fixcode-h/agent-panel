// 对话输入框通用的附件：选文件、粘贴截图、拖进来，图片显示缩略图。任务对话和 UI 设计的 AI 对话都用这一套，
// 以后新的对话输入框直接拿来用
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AtSign,
  Check,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FolderGit2,
  Gamepad2,
  Globe,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Palette,
  Paperclip,
  Plus,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type Attachment } from '@shared/schema'
import type { DesignKind, SavedStyle } from '@shared/design'
import { entryFlow, topoOrder } from '@shared/flow'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import type { RichInputHandle } from './RichInput'
import { attachChip, type ChipKind } from '@shared/composer'
import { quoteName } from '@/lib/quote'
import { t } from '@shared/i18n'

/** 附件加进来、上传失败时通知输入框：照着在光标处放一张卡片 */
export interface AttachHooks {
  added?: (items: { name: string; mime: string; kind: ChipKind }[]) => void
  failed?: (name: string) => void
}

/** 输入框里正在上传或已经上传好的一个附件 */
interface Item {
  key: string
  name: string
  mime: string
  size: number
  /** 本地预览（图片），不用等上传完 */
  preview?: string
  /** 引用卡片的原文：上传完之前也能点开看 */
  quote?: string
  done?: Attachment
}

export const isImage = (mime: string, name = '') =>
  mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)

/** 附件在输入框里的卡片类型：图片是图片卡片，其他都是文件卡片 */
export const chipKind = (mime: string, name: string): ChipKind => (isImage(mime, name) ? 'image' : 'file')

/** 输入框里一个附件对应的卡片类型（引用卡片看原文） */
export const itemKind = (x: { name: string; mime: string; quote?: string; done?: Attachment }): ChipKind =>
  x.quote !== undefined || x.done?.quote !== undefined ? 'quote' : chipKind(x.mime, x.name)

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 只发了附件、没写要求时交给 Agent 的一句话：输入框里不留附件文字，发送时补上 */
export const ATTACHMENT_PROMPT = t('请查看附件')

/** 超过多大的文件只引用原路径、不上传（设置 → 常规里改） */
export const largeBytes = (s: { largeFileMB?: number } | null | undefined) => (s?.largeFileMB ?? 10) * 1024 * 1024

/** 同名附件加序号，文件名才分得清 */
function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`
    if (!taken.has(next)) return next
  }
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

const ATTACH = 'chat-attach:'

/** 上次没发出去的附件；只记上传好的，还在上传的切回来也续不上 */
function readAttachments(key: string): Item[] {
  try {
    const raw = localStorage.getItem(ATTACH + key)
    if (!raw) return []
    const list = JSON.parse(raw) as { key: string; name: string; mime: string; size: number; done: Attachment }[]
    if (!Array.isArray(list)) return []
    return list
      .filter((x) => x?.done?.path)
      .map((x) => ({ key: x.key, name: x.name, mime: x.mime, size: x.size, done: x.done }))
  } catch {
    return []
  }
}

/**
 * 附件列表：选文件、粘贴、拖进来都走 add，选完马上上传。
 * 传了 draftKey（和文字草稿用同一个）就按对话记住，切到别的对话再回来还在。
 * 附件同时在输入框上方显示缩略图，并在光标处插一张行内卡片（图片卡片带缩略图）；
 * 从上面删掉时输入框里对应的卡片也一起去掉。
 */
export function useAttachments(draftKey?: string) {
  const [items, setItems] = useState<Item[]>(() => (draftKey ? readAttachments(draftKey) : []))
  const count = useRef(0)
  count.current = items.length
  // 同一次事件里连着加（粘贴好几个路径）时还没重新渲染，按这份最新的算
  const itemsRef = useRef(items)
  itemsRef.current = items
  const { settings } = useData()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const names = useRef(new Set<string>())
  names.current = new Set(items.map((x) => x.name))
  // 同一个输入框换了对话：换成那个对话的附件
  const shown = useRef(draftKey)
  if (shown.current !== draftKey) {
    shown.current = draftKey
    setItems(draftKey ? readAttachments(draftKey) : [])
  }

  // 记住没发出去的附件；发出去清空后连同记录一起删掉
  useEffect(() => {
    if (!draftKey) return
    try {
      const done = items
        .filter((x) => x.done)
        .map((x) => ({ key: x.key, name: x.name, mime: x.mime, size: x.size, done: x.done }))
      if (done.length) localStorage.setItem(ATTACH + draftKey, JSON.stringify(done))
      else localStorage.removeItem(ATTACH + draftKey)
    } catch {}
  }, [items, draftKey])

  // 恢复的图片没有本地预览，从服务端把缩略图取回来
  useEffect(() => {
    const need = items.filter((x) => !x.preview && x.done && isImage(x.done.mime, x.done.name))
    if (!need.length) return
    let alive = true
    void Promise.all(need.map(async (x) => [x.key, (await attachmentUrl(x.done!)) ?? ''] as const)).then((pairs) => {
      if (!alive) return
      const urls = Object.fromEntries(pairs.filter(([, u]) => u))
      if (Object.keys(urls).length)
        setItems((xs) => xs.map((x) => (urls[x.key] && !x.preview ? { ...x, preview: urls[x.key] } : x)))
    })
    return () => {
      alive = false
    }
  }, [items])

  /**
   * 加附件。added：文件名定下来的那一刻回调（输入框照着在光标处放卡片）；failed：上传失败时回调
   *
   * 超过上限的文件不经过浏览器上传（浏览器给不出原路径，也传不动）：改成在面板所在的本机弹选择框，
   * 拿到的就是原始路径，发给 Agent 时直接引用它。
   */
  const pickLarge = useCallback(async (hooks?: AttachHooks) => {
    const room = MAX_ATTACHMENTS - count.current
    try {
      const { files } = await api.pickFiles()
      if (!files.length) return
      if (files.length > room) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
      const accepted = files.slice(0, Math.max(room, 0))
      if (!accepted.length) return
      setItems((xs) => [
        ...xs,
        ...accepted.map((a) => ({ key: crypto.randomUUID(), name: a.name, mime: a.mime, size: a.size, done: a })),
      ])
      hooks?.added?.(accepted.map((a) => ({ name: a.name, mime: a.mime, kind: chipKind(a.mime, a.name) })))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  /**
   * 粘贴回来的路径：引用已有的文件，不上传也不拷贝。返回每个路径用的卡片名字（已经附上的同一个文件沿用原来的名字），
   * 超过上限的不加
   */
  const addRefs = useCallback((list: Attachment[]) => {
    const names = new Map<string, { name: string; kind: ChipKind }>()
    const taken = new Set(itemsRef.current.map((x) => x.name))
    const fresh: Item[] = []
    let full = false
    for (const a of list) {
      if (names.has(a.path)) continue
      const had = itemsRef.current.find((x) => x.done?.path === a.path)
      if (had) {
        names.set(a.path, { name: had.name, kind: itemKind(had) })
        continue
      }
      if (itemsRef.current.length + fresh.length >= MAX_ATTACHMENTS) {
        full = true
        continue
      }
      const name = a.quote !== undefined ? a.name : uniqueName(a.name, taken)
      taken.add(name)
      fresh.push({ key: crypto.randomUUID(), name, mime: a.mime, size: a.size, done: { ...a, name } })
      names.set(a.path, { name, kind: attachChip(a) })
    }
    if (full) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
    if (fresh.length) {
      itemsRef.current = [...itemsRef.current, ...fresh]
      setItems((xs) => [...xs, ...fresh])
    }
    return names
  }, [])
  /** 上传一批文件：卡片马上放进输入框，传完换成服务端的附件 */
  const upload = useCallback(async (files: File[], hooks?: AttachHooks) => {
    const taken = new Set(names.current)
    const accepted: { file: File; key: string; name: string; mime: string; preview?: string }[] = []
    for (const f of files) {
      // 粘贴的截图没有像样的文件名
      const base =
        f.name && f.name !== 'image.png'
          ? f.name
          : `${t('截图')}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`
      const name = uniqueName(base, taken)
      taken.add(name)
      accepted.push({
        file: f,
        key: crypto.randomUUID(),
        name,
        mime: f.type,
        preview: isImage(f.type, name) ? URL.createObjectURL(f) : undefined,
      })
    }
    if (!accepted.length) return
    setItems((xs) => [
      ...xs,
      ...accepted.map((x) => ({ key: x.key, name: x.name, mime: x.mime, size: x.file.size, preview: x.preview })),
    ])
    hooks?.added?.(accepted.map(({ name, mime }) => ({ name, mime, kind: chipKind(mime, name) })))
    for (const x of accepted) {
      try {
        const done = await api.upload({ name: x.name, mime: x.mime, data: await readBase64(x.file) })
        setItems((xs) => xs.map((i) => (i.key === x.key ? { ...i, done } : i)))
      } catch (e) {
        toast.error(t('「{name}」上传失败：{error}', { name: x.name, error: (e as Error).message }))
        setItems((xs) => xs.filter((i) => i.key !== x.key))
        hooks?.failed?.(x.name)
      }
    }
  }, [])

  /**
   * 加附件（选文件、粘贴、拖进来）。added：文件名定下来的那一刻回调（输入框照着在光标处放卡片）；failed：上传失败时回调。
   *
   * 超过设置里「大文件」大小的不上传、不拷贝：浏览器给不出原路径，交给面板在本机按名字、大小、修改时间找回原文件，
   * 直接引用它（卡片和普通附件一样）。找不到时，不算太大的照常上传一份；实在太大的提示用户自己选
   */
  const add = useCallback(
    async (files: File[], hooks?: AttachHooks) => {
      const room = MAX_ATTACHMENTS - count.current
      if (files.length > room) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
      const limit = largeBytes(settingsRef.current)
      const list = files.slice(0, Math.max(room, 0))
      const small = list.filter((f) => f.size <= limit)
      const big = list.filter((f) => f.size > limit)
      const uploading = upload(small, hooks)
      if (big.length) {
        const found = await api
          .locateFiles(big.map((f) => ({ name: f.name, size: f.size, mtime: f.lastModified || undefined })))
          .then((r) => r.files)
          .catch(() => [])
        const hit = new Set(found.map((x) => x.index))
        const refs = found.map(({ index: _, ...a }) => a)
        if (refs.length) {
          const names = addRefs(refs)
          hooks?.added?.(
            refs.flatMap((a) => {
              const n = names.get(a.path)
              return n ? [{ name: n.name, mime: a.mime, kind: n.kind }] : []
            }),
          )
        }
        const rest = big.filter((_, i) => !hit.has(i))
        void upload(
          rest.filter((f) => f.size <= MAX_ATTACHMENT_BYTES),
          hooks,
        )
        for (const f of rest.filter((x) => x.size > MAX_ATTACHMENT_BYTES))
          toast.error(t('没找到「{name}」在本机的位置，可以手动选择这个文件来引用它', { name: f.name }), {
            action: { label: t('选择文件'), onClick: () => void pickLarge(hooks) },
          })
      }
      await uploading
    },
    [pickLarge, upload, addRefs],
  )
  /** 已经在服务端生成好的附件（引入的会话记录） */
  const addReady = useCallback((a: Attachment, hooks?: AttachHooks) => {
    if (count.current >= MAX_ATTACHMENTS) return toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
    setItems((xs) => [...xs, { key: crypto.randomUUID(), name: a.name, mime: a.mime, size: a.size, done: a }])
    hooks?.added?.([{ name: a.name, mime: a.mime, kind: attachChip(a) }])
  }, [])
  /**
   * 引用对话里的一段：原文存成附件目录里的一个文件（复制消息时给这个路径，粘贴回来还认得出是引用），
   * 卡片马上放进输入框，不用等上传
   */
  const addQuote = useCallback((text: string, hooks?: AttachHooks) => {
    if (count.current >= MAX_ATTACHMENTS) return toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
    const { id, name } = quoteName(text)
    const key = crypto.randomUUID()
    const size = new Blob([text]).size
    setItems((xs) => [...xs, { key, name, mime: 'text/markdown', size, quote: text }])
    hooks?.added?.([{ name, mime: 'text/markdown', kind: 'quote' }])
    void readBase64(new Blob([text], { type: 'text/markdown' }))
      .then((data) => api.upload({ name: `quote-${id}.md`, mime: 'text/markdown', data }))
      .then((done) =>
        setItems((xs) => xs.map((i) => (i.key === key ? { ...i, done: { ...done, name, quote: text } } : i))),
      )
      .catch((e) => {
        toast.error(t('引用没有加上：{error}', { error: (e as Error).message }))
        setItems((xs) => xs.filter((i) => i.key !== key))
        hooks?.failed?.(name)
      })
  }, [])
  /** 换成另一组附件（撤回消息时把那条的附件放回输入框，卡片已经在文字里） */
  const replace = useCallback((list: Attachment[]) => {
    setItems(list.map((a) => ({ key: crypto.randomUUID(), name: a.name, mime: a.mime, size: a.size, done: a })))
  }, [])
  const remove = (key: string) => setItems((xs) => xs.filter((x) => x.key !== key))
  /** 卡片从文字里没了（退格删掉、整段剪掉）：这些名字的附件不再发送 */
  const removeNames = useCallback((gone: Set<string>) => {
    if (gone.size) setItems((xs) => xs.filter((x) => !gone.has(x.name)))
  }, [])
  // 发送成功后页面可能马上切走，等不到 effect 删草稿；这里直接删，免得下次新建时附件又冒出来
  const clear = useCallback(() => {
    setItems([])
    if (!draftKey) return
    try {
      localStorage.removeItem(ATTACH + draftKey)
    } catch {}
  }, [draftKey])
  return {
    items,
    add,
    /** 在面板所在的本机选文件，直接引用原路径（大文件用，也能选小文件） */
    pick: pickLarge,
    addReady,
    addQuote,
    addRefs,
    replace,
    remove,
    removeNames,
    clear,
    uploading: items.some((x) => !x.done),
    attachments: items.flatMap((x) => (x.done ? [x.done] : [])),
  }
}

/**
 * 粘贴、拖放文件到输入框：返回要挂到外层容器和输入框上的事件。
 * scope：拖放的接收范围（例如整个对话页）。给了就在这个元素上监听，页面任何位置都能接住文件；
 * 只带文字、链接、节点时不拦截，交给浏览器和页面上原本的拖拽逻辑。
 */
export function useDropPaste(add: (f: File[]) => void, scope?: HTMLElement | null) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent | DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
  // add 每次渲染都是新的（依赖附件和输入框的状态），放进依赖会让监听反复重建、
  // 刚显示的拖入提示被清理函数立刻关掉；只保留最新的引用
  const addRef = useRef(add)
  addRef.current = add
  // 范围上的监听用原生事件：外层容器的 React 事件只覆盖它自己，消息流、状态行都收不到
  useEffect(() => {
    if (!scope) return
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    }
    const overIt = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // 不 preventDefault 的话浏览器会打开这个文件，drop 也不会触发
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // 拖到子元素也会触发 leave：按进入次数配对，到 0 才算真的离开
      if (--depth.current > 0) return
      depth.current = 0
      setOver(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      addRef.current([...(e.dataTransfer?.files ?? [])])
    }
    scope.addEventListener('dragenter', enter)
    scope.addEventListener('dragover', overIt)
    scope.addEventListener('dragleave', leave)
    scope.addEventListener('drop', drop)
    return () => {
      scope.removeEventListener('dragenter', enter)
      scope.removeEventListener('dragover', overIt)
      scope.removeEventListener('dragleave', leave)
      scope.removeEventListener('drop', drop)
      depth.current = 0
    }
  }, [scope])
  return {
    over,
    container: scope
      ? {}
      : {
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

/** 拖文件到整个对话页面上时盖住页面的提示 */
export function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-bg/80 backdrop-blur-[1px]">
      <span className="rounded-2xl border border-dashed border-accent bg-card px-5 py-3 text-[0.875rem] text-accent shadow-pop">
        {t('松开鼠标，把文件附到要求里')}
      </span>
    </div>
  )
}

/** 输入框左下角的「+」：上传文件或图片、引用项目文件、引入别的会话，和 Claude Code 一样也可以直接粘贴、拖进来、输入 @ */
export function AttachMenu({
  onFiles,
  onMention,
  canMention,
  onSession,
  onStyle,
  styleKind,
  self,
  workflowId,
  onWorkflow,
  className,
}: {
  onFiles: (f: File[]) => void
  /** 没有「引用项目文件」时不传（例如 UI 设计的对话） */
  onMention?: () => void
  canMention: boolean
  /** 引入会话：选好的会话整理成附件交回来；不传就没有这一项 */
  onSession?: (a: Attachment) => void
  /** 按工作流执行：选好的工作流 id 交回来；不传就没有这一项（例如不属于项目的聊天） */
  onWorkflow?: (id: string) => void
  /** 现在选中的工作流，列表里打勾 */
  workflowId?: string
  /** 引入风格：选好的风格交回来（UI 设计的对话用）；不传就没有这一项 */
  onStyle?: (s: SavedStyle) => void
  /** 引入风格时只列这一类（游戏 / 网页）的风格；不写列两类，分开显示 */
  styleKind?: DesignKind
  /** 当前会话的 id：引入列表里不列自己 */
  self?: string
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  // 选了「引用项目文件」：焦点要留在输入框里弹出文件列表，不能被还给「+」按钮
  const mentioning = useRef(false)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'sessions' | 'styles' | 'workflows'>('menu')
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
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setView('menu')
        }}
      >
        <PopoverTrigger
          aria-label={t('添加文件、图片或引用')}
          title={t('添加文件、图片或引用')}
          className={cn(
            'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
            className,
          )}
        >
          <Plus className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={view === 'menu' ? 'w-[260px]' : 'w-[340px] p-0'}
          onCloseAutoFocus={(e) => {
            if (!mentioning.current) return
            mentioning.current = false
            e.preventDefault()
          }}
        >
          {view === 'styles' && onStyle ? (
            <StylePicker
              kind={styleKind}
              onBack={() => setView('menu')}
              onPick={(st) => {
                onStyle(st)
                setOpen(false)
                setView('menu')
              }}
            />
          ) : view === 'workflows' && onWorkflow ? (
            <WorkflowList
              value={workflowId}
              onBack={() => setView('menu')}
              onPick={(id) => {
                onWorkflow(id)
                setOpen(false)
                setView('menu')
              }}
            />
          ) : view === 'sessions' && onSession ? (
            <SessionPicker
              self={self}
              onBack={() => setView('menu')}
              onPick={(a) => {
                onSession(a)
                setOpen(false)
                setView('menu')
              }}
            />
          ) : (
            <>
              <PopoverClose className={menuItem} onClick={() => input.current?.click()}>
                <Paperclip className="h-4 w-4 shrink-0 text-subtle" />
                <span className="flex-1">{t('上传文件或图片')}</span>
                <span className="text-[0.6875rem] text-subtle">{t('可粘贴 / 拖入')}</span>
              </PopoverClose>
              {onMention && (
                <PopoverClose
                  className={menuItem}
                  disabled={!canMention}
                  onClick={() => {
                    mentioning.current = true
                    onMention()
                  }}
                >
                  <AtSign className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="flex-1">{t('引用项目文件')}</span>
                  <span className="font-mono text-[0.6875rem] text-subtle">@</span>
                </PopoverClose>
              )}
              {onWorkflow && (
                <button type="button" className={menuItem} onClick={() => setView('workflows')}>
                  <WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="flex-1">{t('按工作流执行')}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-subtle" />
                </button>
              )}
              {onStyle && (
                <button type="button" className={menuItem} onClick={() => setView('styles')}>
                  <Palette className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="flex-1">{t('引入风格')}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-subtle" />
                </button>
              )}
              {onSession && (
                <button type="button" className={menuItem} onClick={() => setView('sessions')}>
                  <MessagesSquare className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="flex-1">{t('引入会话')}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-subtle" />
                </button>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}

/** 按工作流执行时选工作流：第一项是不用工作流，直接对话；每项标出节点数和是否就绪 */
function WorkflowList({ value, onBack, onPick }: { value?: string; onBack: () => void; onPick: (id: string) => void }) {
  const { workflows, agents, clis } = useData()
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b px-1.5 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('返回')}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-1 text-[0.8125rem]">{t('按工作流执行')}</span>
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        <button type="button" className={menuItem} onClick={() => onPick('')}>
          <MessageSquare className="h-4 w-4 shrink-0 text-subtle" />
          <span className="flex-1">{t('不用工作流，直接对话')}</span>
          {!value && <Check className="h-4 w-4 shrink-0 text-accent" />}
        </button>
        {workflows.map((w) => {
          const ready = isReady(workflowChecks(w, agents, clis, workflows))
          return (
            <button key={w.id} type="button" className={menuItem} onClick={() => onPick(w.id)}>
              <span
                title={ready ? t('就绪') : t('未就绪')}
                className={cn('h-2 w-2 shrink-0 rounded-full', ready ? 'bg-success' : 'bg-warning')}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{w.name}</span>
                <span className="truncate text-[0.6875rem] text-subtle">
                  {t('{n} 个节点', { n: topoOrder(entryFlow(w)).length })}
                </span>
              </span>
              {w.id === value && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          )
        })}
        {workflows.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有工作流，先去工作流页面创建')}</p>
        )}
      </div>
      <p className="border-t px-3 py-2 text-[0.6875rem] leading-relaxed text-subtle">
        {t('选了工作流就按它的流程图执行；不选时直接和角色对话。')}
      </p>
    </div>
  )
}

/**
 * 引入风格的列表：风格库里的风格（自己存的 + 内置的），游戏和网页分开显示；
 * 选中的风格定为这个设计的整体风格，AI 按它做
 */
function StylePicker({
  kind,
  onBack,
  onPick,
}: {
  kind?: DesignKind
  onBack: () => void
  onPick: (s: SavedStyle) => void
}) {
  const [list, setList] = useState<SavedStyle[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    api
      .styles()
      .then(setList)
      .catch(() => setList([]))
  }, [])
  const kw = q.trim().toLowerCase()
  const match = (s: SavedStyle) => !kw || `${s.name} ${s.summary}`.toLowerCase().includes(kw)
  const groups = (['game', 'web'] as const)
    .filter((k) => !kind || k === kind)
    .map((k) => ({
      kind: k,
      title: k === 'game' ? t('游戏 UI') : t('网页 UI'),
      icon: k === 'game' ? Gamepad2 : Globe,
      items: [
        ...(list ?? []).filter((s) => s.kind === k && !s.builtin),
        ...(list ?? []).filter((s) => s.kind === k && s.builtin),
      ].filter(match),
    }))
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b px-1.5 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('返回')}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('搜索风格')}
          aria-label={t('搜索风格')}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-[0.8125rem] outline-none placeholder:text-subtle"
        />
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        {!list ? (
          <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin text-subtle" />
        ) : (
          groups.map((g) => (
            <div key={g.kind} className="flex flex-col" role="group" aria-label={g.title}>
              <p className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">
                <g.icon className="h-3 w-3" />
                {g.title}
              </p>
              {g.items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.en}
                  onClick={() => onPick(s)}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-sel"
                >
                  <Palette className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[0.8125rem]">
                      <span className="truncate">{s.name}</span>
                      {s.builtin && (
                        <span className="shrink-0 rounded bg-field px-1 text-[0.625rem] text-subtle">{t('内置')}</span>
                      )}
                    </span>
                    {s.summary && (
                      <span className="line-clamp-2 text-[0.71875rem] leading-snug text-subtle">{s.summary}</span>
                    )}
                  </span>
                </button>
              ))}
              {!g.items.length && <p className="px-2.5 py-2 text-xs text-subtle">{t('没有匹配的风格')}</p>}
            </div>
          ))
        )}
      </div>
      <p className="border-t px-3 py-2 text-[0.6875rem] leading-relaxed text-subtle">
        {t('选中后这个设计按这个风格来，发送时一起交给 AI。')}
      </p>
    </div>
  )
}

/**
 * 引入会话的列表：Agent 任务、Chat、UI 设计都能选，选中的会话整理成一份 Markdown 附件，
 * AI 把它当参考资料读（不会重新执行里面的要求）
 */
function SessionPicker({
  self,
  onBack,
  onPick,
}: {
  self?: string
  onBack: () => void
  onPick: (a: Attachment) => void
}) {
  const { tasks, designs, projects } = useData()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const kw = q.trim().toLowerCase()
  const items = [
    ...tasks.map((x) => ({
      id: x.id,
      kind: 'task' as const,
      title: x.title,
      at: x.updatedAt,
      icon: x.projectId ? FolderGit2 : MessageSquare,
      where: x.projectId ? (projects.find((p) => p.id === x.projectId)?.name ?? '') : t('Chat'),
    })),
    ...designs.map((x) => ({
      id: x.id,
      kind: 'design' as const,
      title: x.title,
      at: x.updatedAt,
      icon: x.kind === 'web' ? Globe : Gamepad2,
      where: t('UI 设计'),
    })),
  ]
    .filter((x) => x.id !== self && (!kw || `${x.title} ${x.where}`.toLowerCase().includes(kw)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 60)
  const pick = async (x: (typeof items)[number]) => {
    if (busy) return
    setBusy(x.id)
    try {
      onPick(await (x.kind === 'task' ? api.taskTranscript(x.id) : api.designTranscript(x.id)))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b px-1.5 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('返回')}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('搜索会话')}
          aria-label={t('搜索会话')}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-[0.8125rem] outline-none placeholder:text-subtle"
        />
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        {items.map((x) => (
          <button
            key={x.id}
            type="button"
            disabled={!!busy}
            onClick={() => void pick(x)}
            className={cn(menuItem, 'disabled:cursor-wait')}
          >
            {busy === x.id ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-subtle" />
            ) : (
              <x.icon className="h-4 w-4 shrink-0 text-subtle" />
            )}
            <span className="min-w-0 flex-1 truncate">{x.title}</span>
            <span className="max-w-[96px] shrink-0 truncate text-[0.6875rem] text-subtle">{x.where}</span>
          </button>
        ))}
        {!items.length && <p className="px-2.5 py-3 text-center text-xs text-subtle">{t('没有可以引入的会话')}</p>}
      </div>
      <p className="border-t px-3 py-2 text-[0.6875rem] leading-relaxed text-subtle">
        {t('选中的会话会整理成一份记录附上，AI 拿它当参考，不会重新执行里面的要求。')}
      </p>
    </div>
  )
}

/**
 * 输入 @ 引用项目里的文件：光标前是「@关键字」时列出匹配的文件，上下键选、回车或 Tab 确认，
 * 选中后换成「@相对路径 」。Agent 在项目目录里执行，看到路径就能自己读。
 */
export function useFileMention(projectId: string | undefined, editor: React.RefObject<RichInputHandle | null>) {
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)

  /** 根据光标位置判断是不是在输入 @ */
  const sync = useCallback(() => {
    const el = editor.current
    if (!el) return
    const before = el.text().slice(0, el.caret())
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    setQuery(m ? { q: m[2], start: before.length - m[2].length - 1 } : null)
    if (!m) setClosed(false)
  }, [editor])

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
    const el = editor.current
    if (!query || !el) return
    el.replace(query.start, el.caret(), `@${f} `)
    setQuery(null)
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
    const el = editor.current
    if (!el) return
    const pos = el.caret()
    const ins = pos > 0 && !/\s$/.test(el.text().slice(0, pos)) ? ' @' : '@'
    el.replace(pos, pos, ins)
    setClosed(false)
    el.focus()
    sync()
  }

  const menu = open ? (
    <div
      role="listbox"
      aria-label={t('项目文件')}
      className="absolute right-3 bottom-full left-3 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop"
    >
      <div className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] text-subtle">{t('项目文件 · ↑↓ 选择，回车确认')}</div>
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
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem]',
              i === active ? 'bg-sel text-fg' : 'text-muted',
            )}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="shrink-0 font-mono">{f.slice(cut + 1)}</span>
            {cut > 0 && <span className="truncate font-mono text-[0.71875rem] text-subtle">{f.slice(0, cut)}</span>}
          </button>
        )
      })}
    </div>
  ) : null

  return { sync, onKeyDown, start, menu }
}

/** 拖文件进来时盖在输入框上的提示 */
export function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[20px] bg-card/90 text-[0.8125rem] text-accent">
      {t('松开鼠标，把文件附到要求里')}
    </div>
  )
}

/** 从文件树右键拖文件 / 文件夹过来时盖在输入框上的提示 */
export function FileRefHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[20px] bg-card/90 text-[0.8125rem] text-accent">
      {t('松开鼠标，插入引用')}
    </div>
  )
}
