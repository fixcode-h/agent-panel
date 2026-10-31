// 对话输入框通用的附件：选文件、粘贴截图、拖进来，图片显示缩略图。任务对话和 UI 设计的 AI 对话都用这一套，
// 以后新的对话输入框直接拿来用
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
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
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { ATTACHMENT_THUMB_WIDTH, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type Attachment } from '@shared/schema'
import {
  blocksSend,
  itemStatus,
  routeOf,
  sendAttachments,
  type ItemLike,
  type ItemState,
} from '@shared/attachment-view'
import type { DesignKind, SavedStyle } from '@shared/design'
import { entryFlow, topoOrder } from '@shared/flow'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { IconButton } from '@/components/ui/icon-button'
import { MenuSearch } from '@/components/ui/menu-search'
import type { RichInputHandle } from './RichInput'
import { useMenuBox } from './useMenuBox'
import { attachChip, chipMarker, type ChipKind } from '@shared/composer'
import { quoteName } from '@/lib/quote'
import { t } from '@shared/i18n'

/** 附件加进来、上传失败时通知输入框：照着在光标处放一张卡片 */
export interface AttachHooks {
  added?: (items: { name: string; mime: string; kind: ChipKind }[]) => void
  failed?: (name: string) => void
}

/**
 * 输入框里的一个附件：加进来马上显示，路径查找、拷贝 / 上传都在后台进行。
 * 状态和「发送时用哪一份」的判断在 shared/attachment-view.ts，界面和发送读的是同一套
 */
interface Item extends ItemLike {
  key: string
  /** 卡片上的预览图（缩略图），不用等上传完 */
  preview?: string
  /** 看大图用的原图地址：从草稿恢复时 preview 是缩略图，浮层不能用它 */
  full?: string
  /** 拷贝完成后数据目录里的路径：删卡片时用它把副本清掉 */
  copyPath?: string
}

/** 还在后台查找 / 拷贝 / 上传：删掉或换了对话后要登记取消，完成时丢掉结果、不留副本 */
const inFlight = (x: Pick<ItemLike, 'state'>) =>
  x.state === 'locating' || x.state === 'copying' || x.state === 'uploading'

export const isImage = (mime: string, name = '') =>
  mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)

/** 附件在输入框里的卡片类型：图片是图片卡片，其他都是文件卡片 */
export const chipKind = (mime: string, name: string): ChipKind => (isImage(mime, name) ? 'image' : 'file')

/** 输入框里一个附件对应的卡片类型（引用卡片看原文） */
export const itemKind = (x: Pick<ItemLike, 'name' | 'mime' | 'quote' | 'done'>): ChipKind =>
  x.quote !== undefined || x.done?.quote !== undefined ? 'quote' : chipKind(x.mime, x.name)

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
export async function attachmentUrl(a: Attachment, opts: { thumb?: boolean } = {}) {
  if (import.meta.env.VITE_DEMO) return (await import('@/lib/demo-backend')).demoUploads.get(a.path)
  // thumb：消息卡片只有一行字那么高，请服务端缩好再给（看大图、复制图片仍要原图）
  const w = opts.thumb ? `&w=${ATTACHMENT_THUMB_WIDTH}` : ''
  return `/api/uploads/raw?path=${encodeURIComponent(a.path)}${w}`
}

const readBase64 = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })

const ATTACH = 'chat-attach:'

/** 草稿里存下来的附件：拷好 / 传好的那份，加上显示用的原路径和状态 */
interface DraftItem {
  key: string
  name: string
  mime: string
  size: number
  done: Attachment
  source?: string
  state?: ItemState
}

/** 上次没发出去的附件；只记拷好 / 传好的，路径还在找、还在拷的切回来也续不上 */
function readAttachments(key: string): Item[] {
  try {
    const raw = localStorage.getItem(ATTACH + key)
    if (!raw) return []
    const list = JSON.parse(raw) as DraftItem[]
    if (!Array.isArray(list)) return []
    return list
      .filter((x) => x?.done?.path)
      .map((x) => ({
        key: x.key,
        name: x.name,
        mime: x.mime,
        size: x.size,
        done: x.done,
        source: x.source,
        // 老草稿没有状态：已经存下来的都是能发送的
        state: x.state ?? (x.done.ref ? 'ref' : 'ready'),
      }))
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
  /** 卡片删掉后，还在进行的拷贝 / 上传完成时不再回写；已经拷出来的副本顺手清掉 */
  const cancelled = useRef(new Set<string>())
  /** 已经认领的原路径：同一文件重复添加时去重，items 还没重新渲染时也认得出 */
  const claimed = useRef(new Set<string>())
  const { settings } = useData()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const names = useRef(new Set<string>())
  names.current = new Set(items.map((x) => x.name))
  // 同一个输入框换了对话：换成那个对话的附件
  const shown = useRef(draftKey)
  if (shown.current !== draftKey) {
    // 旧对话里还在查找 / 拷贝 / 上传的附件不再需要：完成后丢掉，不留孤儿；已经拷好的留在草稿里
    for (const x of itemsRef.current) if (inFlight(x)) cancelled.current.add(x.key)
    claimed.current.clear()
    shown.current = draftKey
    setItems(draftKey ? readAttachments(draftKey) : [])
  }

  // 记住没发出去的附件；发出去清空后连同记录一起删掉
  useEffect(() => {
    if (!draftKey) return
    try {
      const done = items
        .filter((x) => x.done)
        .map((x) => ({
          key: x.key,
          name: x.name,
          mime: x.mime,
          size: x.size,
          done: x.done,
          source: x.source,
          state: x.state,
        }))
      if (done.length) localStorage.setItem(ATTACH + draftKey, JSON.stringify(done))
      else localStorage.removeItem(ATTACH + draftKey)
    } catch {}
  }, [items, draftKey])

  // 恢复的图片没有本地预览：缩略图放卡片，原图留给看大图的浮层
  useEffect(() => {
    const need = items.filter((x) => !x.preview && x.done && isImage(x.done.mime, x.done.name))
    if (!need.length) return
    let alive = true
    void Promise.all(
      need.map(async (x) => {
        const [thumb, full] = await Promise.all([attachmentUrl(x.done!, { thumb: true }), attachmentUrl(x.done!)])
        return [x.key, thumb ?? '', full ?? ''] as const
      }),
    ).then((pairs) => {
      if (!alive) return
      const found = new Map(pairs.filter(([, thumb]) => thumb).map(([key, thumb, full]) => [key, { thumb, full }]))
      if (!found.size) return
      setItems((xs) =>
        xs.map((x) => {
          const hit = found.get(x.key)
          return hit && !x.preview ? { ...x, preview: hit.thumb, full: hit.full } : x
        }),
      )
    })
    return () => {
      alive = false
    }
  }, [items])

  /**
   * 把一个文件后台拷进数据目录。拷好之前它就能发送：发送时用原路径引用（见 shared/attachment-view.ts），
   * 拷好之后改用副本。拷不了（被占用、权限、源文件没了）就降级成引用原路径，不弹错也不拦发送。
   */
  const copyInto = useCallback(
    async (key: string, source: string, meta: { name: string; mime: string; size: number }) => {
      setItems((xs) => xs.map((i) => (i.key === key ? { ...i, source, state: 'copying' } : i)))
      try {
        const { files } = await api.copyPaths([source])
        const copied = files[0]
        if (!copied) throw new Error('copy failed')
        if (cancelled.current.delete(key)) {
          // 卡片已经删了：把刚拷出来的副本清掉，不留孤儿
          void api.discardPaths([copied.path]).catch(() => {})
          return
        }
        // 名字用卡片上的那个：同一个文件名重复添加时加了序号，发送时要和文字里的卡片标记对得上
        setItems((xs) =>
          xs.map((i) =>
            i.key === key ? { ...i, done: { ...copied, name: meta.name }, copyPath: copied.path, state: 'copied' } : i,
          ),
        )
      } catch {
        if (cancelled.current.delete(key)) return
        setItems((xs) =>
          xs.map((i) =>
            i.key === key
              ? {
                  ...i,
                  state: 'ref',
                  done: { name: meta.name, path: source, size: meta.size, mime: meta.mime, ref: true },
                }
              : i,
          ),
        )
      }
    },
    [],
  )

  /**
   * 没有原路径的附件（剪贴板截图）仍走浏览器上传：只有这一种要等它传完才能发送。
   * 浏览器读不了文件内容（Windows 上被别的程序占用、正在写）时返回 false，不提示也不删卡片，交给调用方改引用原路径
   */
  const uploadOne = useCallback(
    async (x: { key: string; name: string; mime: string; file: File }, hooks?: AttachHooks) => {
      if (cancelled.current.has(x.key)) return true
      setItems((xs) => xs.map((i) => (i.key === x.key ? { ...i, state: 'uploading' } : i)))
      const data = await readBase64(x.file).catch(() => null)
      if (data === null) return false
      try {
        const done = await api.upload({ name: x.name, mime: x.mime, data })
        if (cancelled.current.delete(x.key)) return
        setItems((xs) =>
          xs.map((i) => (i.key === x.key ? { ...i, done, mime: done.mime || i.mime, state: 'ready' } : i)),
        )
      } catch (e) {
        cancelled.current.delete(x.key)
        toast.error(t('「{name}」上传失败：{error}', { name: x.name, error: (e as Error).message }))
        setItems((xs) => xs.filter((i) => i.key !== x.key))
        hooks?.failed?.(x.name)
      }
      return true
    },
    [],
  )

  /**
   * 在本机弹选择框选文件，拿到的是原始路径：小于「大文件」阈值的后台拷一份，更大的直接引用。
   * added：文件名定下来的那一刻回调（输入框照着在光标处放卡片）
   */
  const pickLarge = useCallback(
    async (hooks?: AttachHooks) => {
      const room = MAX_ATTACHMENTS - count.current
      try {
        const { files } = await api.pickFiles()
        if (!files.length) return
        if (files.length > room) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
        const limit = largeBytes(settingsRef.current)
        const taken = new Set(names.current)
        const fresh: Item[] = []
        for (const a of files.slice(0, Math.max(room, 0))) {
          // 同一个文件已经附上（或者正在处理）：不重复加
          if (claimed.current.has(a.path) || [...itemsRef.current, ...fresh].some((x) => x.source === a.path)) continue
          claimed.current.add(a.path)
          const name = uniqueName(a.name, taken)
          taken.add(name)
          const ref = routeOf(a.size, limit) === 'ref'
          fresh.push({
            key: crypto.randomUUID(),
            name,
            mime: a.mime,
            size: a.size,
            source: a.path,
            done: ref ? { ...a, name, ref: true } : undefined,
            state: ref ? 'ref' : 'copying',
          })
        }
        if (!fresh.length) return
        itemsRef.current = [...itemsRef.current, ...fresh]
        setItems((xs) => [...xs, ...fresh])
        hooks?.added?.(fresh.map((x) => ({ name: x.name, mime: x.mime, kind: chipKind(x.mime, x.name) })))
        for (const x of fresh) if (x.state === 'copying' && x.source) void copyInto(x.key, x.source, x)
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    [copyInto],
  )

  /**
   * 浏览器读不了的文件（被占用）：不比大小、只按名字再在本机找一次原路径，找到就改成引用路径；
   * 正在写的文件大小一直在变，按名字 + 大小的那次查找对不上。还找不到才提示，让用户手动选文件来引用
   */
  const refUnreadable = useCallback(
    async (x: { key: string; name: string; file: File }, hooks?: AttachHooks) => {
      const hit = await api
        .locateFiles([{ name: x.file.name, size: x.file.size, mtime: x.file.lastModified || undefined }], {
          loose: true,
        })
        .then((r) => r.files[0])
        .catch(() => undefined)
      if (cancelled.current.delete(x.key)) return
      // 找到的文件已经附上了：不重复加
      const dup = hit && (claimed.current.has(hit.path) || itemsRef.current.some((i) => i.source === hit.path))
      if (!hit || dup) {
        setItems((xs) => xs.filter((i) => i.key !== x.key))
        hooks?.failed?.(x.name)
        if (!hit)
          toast.error(
            t('「{name}」被别的程序占用，读不了，也没找到它在本机的位置，可以手动选择这个文件来引用它', {
              name: x.name,
            }),
            {
              action: { label: t('选择文件'), onClick: () => void pickLarge(hooks) },
            },
          )
        return
      }
      claimed.current.add(hit.path)
      setItems((xs) =>
        xs.map((i) =>
          i.key === x.key
            ? {
                ...i,
                source: hit.path,
                size: hit.size,
                state: 'ref',
                done: { name: i.name, path: hit.path, size: hit.size, mime: hit.mime, ref: true },
              }
            : i,
        ),
      )
    },
    [pickLarge],
  )
  /** 上传一项，读不了内容（被占用）时改引用原路径 */
  const uploadOrRef = useCallback(
    (x: { key: string; name: string; mime: string; file: File }, hooks?: AttachHooks) =>
      void uploadOne(x, hooks).then((ok) => {
        if (ok === false) void refUnreadable(x, hooks)
      }),
    [refUnreadable, uploadOne],
  )

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
      const had = itemsRef.current.find((x) => x.done?.path === a.path || x.source === a.path)
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
      fresh.push({
        key: crypto.randomUUID(),
        name,
        mime: a.mime,
        size: a.size,
        done: { ...a, name },
        source: a.path,
        state: 'ref',
      })
      names.set(a.path, { name, kind: attachChip(a) })
    }
    if (full) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
    if (fresh.length) {
      itemsRef.current = [...itemsRef.current, ...fresh]
      setItems((xs) => [...xs, ...fresh])
    }
    return names
  }, [])

  /**
   * 加附件（选文件、粘贴、拖进来）。卡片马上放进输入框，路径查找、拷贝 / 上传都在后台：
   * 先在本机按名字、大小、修改时间找回原路径（浏览器给不出路径），小于设置里「大文件」的拷一份到数据目录，
   * 更大的或者拷不了的直接引用原路径。只有找不回路径的（剪贴板截图）才走浏览器上传。
   *
   * added：文件名定下来的那一刻回调（输入框照着在光标处放卡片）；failed：这张卡片不加了
   */
  const add = useCallback(
    async (files: File[], hooks?: AttachHooks, opts: { clipboard?: boolean } = {}) => {
      const room = MAX_ATTACHMENTS - count.current
      if (files.length > room) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
      const taken = new Set(names.current)
      const fresh = files.slice(0, Math.max(room, 0)).map((f) => {
        // 粘贴的截图没有像样的文件名
        const base =
          f.name && f.name !== 'image.png'
            ? f.name
            : `${t('截图')}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`
        const name = uniqueName(base, taken)
        taken.add(name)
        return {
          file: f,
          key: crypto.randomUUID(),
          name,
          mime: f.type,
          preview: isImage(f.type, name) ? URL.createObjectURL(f) : undefined,
        }
      })
      if (!fresh.length) return
      // 先放上卡片：路径还在找、文件还没拷，输入框里已经能看到 @路径、大小和状态，输入不受影响
      const shown: Item[] = fresh.map((x) => ({
        key: x.key,
        name: x.name,
        mime: x.mime,
        size: x.file.size,
        preview: x.preview,
        state: 'locating',
      }))
      itemsRef.current = [...itemsRef.current, ...shown]
      setItems((xs) => [...xs, ...shown])
      hooks?.added?.(fresh.map((x) => ({ name: x.name, mime: x.mime, kind: chipKind(x.mime, x.name) })))

      // 粘贴进来的图片是剪贴板截图，没有原路径：直接上传，省掉一次本机查找。
      // 拖入、选择文件、粘贴的文件仍先找原路径——真实文件也可能叫 image.png，不能只看文件名
      const direct = opts.clipboard ? fresh.filter((x) => isImage(x.mime, x.name)) : []
      for (const x of direct) uploadOrRef(x, hooks)
      const want = fresh.filter((x) => !direct.includes(x))
      if (!want.length) return

      const found = await api
        .locateFiles(
          want.map((x) => ({ name: x.file.name, size: x.file.size, mtime: x.file.lastModified || undefined })),
        )
        .then((r) => new Map(r.files.map((f) => [f.index, f])))
        .catch(() => new Map<number, Attachment & { index: number }>())
      const limit = largeBytes(settingsRef.current)
      for (const [index, x] of want.entries()) {
        if (cancelled.current.has(x.key)) continue
        const hit = found.get(index)
        if (!hit) {
          // 找不回原路径：不太大的照旧上传一份；太大的让用户自己选文件来引用
          if (x.file.size <= MAX_ATTACHMENT_BYTES) uploadOrRef(x, hooks)
          else {
            cancelled.current.add(x.key)
            setItems((xs) => xs.filter((i) => i.key !== x.key))
            hooks?.failed?.(x.name)
            toast.error(t('没找到「{name}」在本机的位置，可以手动选择这个文件来引用它', { name: x.name }), {
              action: { label: t('选择文件'), onClick: () => void pickLarge(hooks) },
            })
          }
          continue
        }
        // 同一个文件已经附过（或者同一批里前面那项刚认领）：不重复加，也不重复拷
        if (claimed.current.has(hit.path) || itemsRef.current.some((i) => i.key !== x.key && i.source === hit.path)) {
          cancelled.current.add(x.key)
          setItems((xs) => xs.filter((i) => i.key !== x.key))
          hooks?.failed?.(x.name)
          continue
        }
        claimed.current.add(hit.path)
        const ref = routeOf(hit.size, limit) === 'ref'
        setItems((xs) =>
          xs.map((i) =>
            i.key === x.key
              ? {
                  ...i,
                  source: hit.path,
                  state: ref ? 'ref' : 'copying',
                  done: ref ? { name: i.name, path: hit.path, size: hit.size, mime: hit.mime, ref: true } : undefined,
                }
              : i,
          ),
        )
        if (!ref) void copyInto(x.key, hit.path, { name: x.name, mime: hit.mime, size: hit.size })
      }
    },
    [copyInto, pickLarge, uploadOrRef],
  )
  /** 已经在服务端生成好的附件（引入的会话记录） */
  const addReady = useCallback((a: Attachment, hooks?: AttachHooks) => {
    if (count.current >= MAX_ATTACHMENTS) return toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
    setItems((xs) => [
      ...xs,
      {
        key: crypto.randomUUID(),
        name: a.name,
        mime: a.mime,
        size: a.size,
        done: a,
        source: a.ref ? a.path : undefined,
        state: a.ref ? 'ref' : 'ready',
      },
    ])
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
    setItems((xs) => [...xs, { key, name, mime: 'text/markdown', size, quote: text, state: 'uploading' }])
    hooks?.added?.([{ name, mime: 'text/markdown', kind: 'quote' }])
    void readBase64(new Blob([text], { type: 'text/markdown' }))
      .then((data) => api.upload({ name: `quote-${id}.md`, mime: 'text/markdown', data }))
      .then((done) =>
        setItems((xs) =>
          xs.map((i) => (i.key === key ? { ...i, done: { ...done, name, quote: text }, state: 'ready' } : i)),
        ),
      )
      .catch((e) => {
        toast.error(t('引用没有加上：{error}', { error: (e as Error).message }))
        setItems((xs) => xs.filter((i) => i.key !== key))
        hooks?.failed?.(name)
      })
  }, [])
  /** 换成另一组附件（撤回消息时把那条的附件放回输入框，卡片已经在文字里） */
  const replace = useCallback((list: Attachment[]) => {
    setItems(
      list.map((a) => ({
        key: crypto.randomUUID(),
        name: a.name,
        mime: a.mime,
        size: a.size,
        done: a,
        source: a.ref ? a.path : undefined,
        state: a.ref ? 'ref' : 'ready',
      })),
    )
  }, [])
  /** 删掉一个附件：已经拷出来的副本一并清掉，正在拷的完成后丢掉（见 copyInto 的 cancelled 判断） */
  const remove = (key: string) => {
    const item = itemsRef.current.find((x) => x.key === key)
    if (item?.copyPath) void api.discardPaths([item.copyPath]).catch(() => {})
    if (item?.source) claimed.current.delete(item.source)
    // 已经完成的不用记：没有还在跑的请求会回来找这个 key，记了只会一直攒着
    if (item && inFlight(item)) cancelled.current.add(key)
    setItems((xs) => xs.filter((x) => x.key !== key))
  }
  /** 卡片从文字里没了（退格删掉、整段剪掉）：这些名字的附件不再发送 */
  const removeNames = useCallback((gone: Set<string>) => {
    if (!gone.size) return
    for (const x of itemsRef.current) {
      if (!gone.has(x.name)) continue
      if (x.copyPath) void api.discardPaths([x.copyPath]).catch(() => {})
      if (x.source) claimed.current.delete(x.source)
      if (inFlight(x)) cancelled.current.add(x.key)
    }
    setItems((xs) => xs.filter((x) => !gone.has(x.name)))
  }, [])
  // 发送成功后页面马上切走，等不到 effect 删草稿；这里直接删，免得下次新建时附件又冒出来
  const clear = useCallback(() => {
    // 还在跑的：这条已经发出去了或者没人要了，完成时把拷出来的副本删掉
    for (const x of itemsRef.current) if (inFlight(x)) cancelled.current.add(x.key)
    claimed.current.clear()
    setItems([])
    if (!draftKey) return
    try {
      localStorage.removeItem(ATTACH + draftKey)
    } catch {}
  }, [draftKey])
  return {
    items,
    add,
    /** 在面板所在的本机选文件：拿到原路径后后台拷贝一份，太大的直接引用 */
    pick: pickLarge,
    addReady,
    addQuote,
    addRefs,
    replace,
    remove,
    removeNames,
    clear,
    /** 还没拿到路径、会拦住发送的那个附件的状态文案（没有时为空）：查找中 / 上传中 */
    waiting: (() => {
      const x = items.find(blocksSend)
      return x ? itemStatus(x.state) : ''
    })(),
    uploading: items.some(blocksSend),
    attachments: sendAttachments(items),
  }
}

/**
 * 粘贴、拖放文件到输入框：返回要挂到外层容器和输入框上的事件。
 * scope：拖放的接收范围（例如整个对话页）。给了就在这个元素上监听，页面任何位置都能接住文件；
 * 只带文字、链接、节点时不拦截，交给浏览器和页面上原本的拖拽逻辑。
 */
export function useDropPaste(add: (f: File[]) => void, scope?: HTMLElement | null, paste = add) {
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
      paste(files)
    },
  }
}

/** 拖文件到整个对话页面上时盖住页面的提示 */
export function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-bg/80 backdrop-blur-[1px]">
      <span className="rounded-2xl border border-dashed border-accent bg-card px-5 py-3 text-prose text-accent-text shadow-pop">
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
            // 设计稿：只留图标、不出底色，悬停和菜单开着时图标变成前景色
            'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:text-fg data-[state=open]:text-fg',
            className,
          )}
        >
          <Paperclip className="h-4 w-4" strokeWidth={2.2} />
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
                <span className="text-caption text-subtle">{t('可粘贴 / 拖入')}</span>
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
                  <span className="font-mono text-caption text-subtle">@</span>
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
        <IconButton size="sm" icon={ChevronLeft} label={t('返回')} onClick={onBack} />
        <span className="px-1 text-body">{t('按工作流执行')}</span>
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        <button type="button" className={menuItem} onClick={() => onPick('')}>
          <MessageSquare className="h-4 w-4 shrink-0 text-subtle" />
          <span className="flex-1">{t('不用工作流，直接对话')}</span>
          {!value && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
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
                <span className="truncate text-caption text-subtle">
                  {t('{n} 个节点', { n: topoOrder(entryFlow(w)).length })}
                </span>
              </span>
              {w.id === value && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
            </button>
          )
        })}
        {workflows.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有工作流，先去工作流页面创建')}</p>
        )}
      </div>
      <p className="border-t px-3 py-2 text-caption leading-relaxed text-subtle">
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
        <IconButton size="sm" icon={ChevronLeft} label={t('返回')} onClick={onBack} />
        <MenuSearch value={q} onChange={setQ} placeholder={t('搜索风格')} className="mb-0 h-7 flex-1" />
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        {!list ? (
          <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin text-subtle" />
        ) : (
          groups.map((g) => (
            <div key={g.kind} className="flex flex-col" role="group" aria-label={g.title}>
              <p className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-caption font-medium text-subtle">
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
                  <Palette className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-body">
                      <span className="truncate">{s.name}</span>
                      {s.builtin && (
                        <span className="shrink-0 rounded-sm bg-field px-1 text-micro text-subtle">{t('内置')}</span>
                      )}
                    </span>
                    {s.summary && (
                      <span className="line-clamp-2 text-caption leading-snug text-subtle">{s.summary}</span>
                    )}
                  </span>
                </button>
              ))}
              {!g.items.length && <p className="px-2.5 py-2 text-xs text-subtle">{t('没有匹配的风格')}</p>}
            </div>
          ))
        )}
      </div>
      <p className="border-t px-3 py-2 text-caption leading-relaxed text-subtle">
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
        <IconButton size="sm" icon={ChevronLeft} label={t('返回')} onClick={onBack} />
        <MenuSearch value={q} onChange={setQ} placeholder={t('搜索会话')} className="mb-0 h-7 flex-1" />
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
            <span className="max-w-[96px] shrink-0 truncate text-caption text-subtle">{x.where}</span>
          </button>
        ))}
        {!items.length && <p className="px-2.5 py-3 text-center text-xs text-subtle">{t('没有可以引入的会话')}</p>}
      </div>
      <p className="border-t px-3 py-2 text-caption leading-relaxed text-subtle">
        {t('选中的会话会整理成一份记录附上，AI 拿它当参考，不会重新执行里面的要求。')}
      </p>
    </div>
  )
}

/**
 * 输入 @ 引用项目里的文件：光标前是「@关键字」时列出匹配的文件，上下键选、回车或 Tab 确认，
 * 选中后换成一张引用路径的文件卡片（和粘贴路径一样，只引用不拷贝）；服务端认不出这个文件时退回「@相对路径 」。
 */
export function useFileMention(
  project: { id: string; path?: string } | undefined,
  editor: React.RefObject<RichInputHandle | null>,
  attach: Pick<ReturnType<typeof useAttachments>, 'addRefs'>,
) {
  const projectId = project?.id
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
          // 换了关键词是一份新列表：菜单回到顶部，选中第一项
          if (box.current) box.current.scrollTop = 0
        })
        .catch(() => !off && setFiles([]))
    }, 120)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [query?.q, projectId, closed]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!query && !!projectId && !closed && files.length > 0

  // 菜单的滚动和高度：选中项跟着 ↑↓ 滚进可视区，矮窗口时压短（见 useMenuBox）
  const box = useMenuBox(active, open, 18)

  const pick = (f: string) => {
    const el = editor.current
    if (!query || !el) return
    // 先把「@关键字」删掉、记下位置：等服务端确认的这一小会儿光标可能被挪走
    const at = query.start
    el.replace(at, el.caret(), '')
    setQuery(null)
    const put = (value: string) => {
      el.focus()
      el.setCaret(at)
      el.insert(value)
    }
    const root = project?.path
    if (!root) return put(`@${f} `)
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
    const full = `${root.replace(/[\\/]+$/, '')}${sep}${sep === '/' ? f : f.replace(/\//g, sep)}`
    void api
      .resolvePaths([full])
      .then(({ files: resolved }) => {
        const a = resolved[0]
        const chip = a && attach.addRefs([a]).get(a.path)
        put(chip ? `${chipMarker(chip.kind, chip.name)} ` : `@${f} `)
      })
      .catch(() => put(`@${f} `))
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
    <ComposerPopover
      ref={box}
      role="listbox"
      aria-label={t('项目文件')}
      stretch
      scroll
      className="max-h-[min(18rem,60vh)]"
    >
      <div className="px-2.5 pt-1.5 pb-1 text-caption text-subtle">{t('项目文件 · ↑↓ 选择，回车确认')}</div>
      {files.map((f, i) => {
        const cut = f.lastIndexOf('/')
        return (
          <button
            key={f}
            type="button"
            role="option"
            aria-selected={i === active}
            data-i={i}
            onMouseDown={(e) => e.preventDefault()}
            // 用 mousemove 不用 mouseenter：滚动时列表会在鼠标底下换行，mouseenter 会跟着再改一次选中项，来回抖
            onMouseMove={() => setActive(i)}
            onClick={() => pick(f)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body',
              i === active ? 'bg-sel text-fg' : 'text-muted',
            )}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="shrink-0 font-mono">{f.slice(cut + 1)}</span>
            {cut > 0 && <span className="truncate font-mono text-caption text-subtle">{f.slice(0, cut)}</span>}
          </button>
        )
      })}
    </ComposerPopover>
  ) : null

  return { sync, onKeyDown, start, menu }
}

/** 拖文件进来时盖在输入框上的提示 */
export function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-3xl bg-card/90 text-body text-accent-text">
      {t('松开鼠标，把文件附到要求里')}
    </div>
  )
}

/** 从文件树右键拖文件 / 文件夹过来时盖在输入框上的提示 */
export function FileRefHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-3xl bg-card/90 text-body text-accent-text">
      {t('松开鼠标，插入引用')}
    </div>
  )
}
