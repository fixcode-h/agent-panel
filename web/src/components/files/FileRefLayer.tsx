/**
 * 对话里的文件标记怎么用：单击打开、悬停看完整路径、右键菜单（打开、在文件夹中显示、复制路径、引用到输入框）。
 * 回复正文（HTML 字符串，事件委托）、工具行、用户消息的附件卡片都走这一层，行为只写一份。
 * 单击的规则（用户 2026-11-05 定的）：面板能看的（图片、文字）在面板里看，别的交给系统默认程序，
 * 会被当脚本执行的类型只在文件夹里选中（服务端 open.ts 的白名单）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, Copy, ExternalLink, Eye, FolderOpen } from 'lucide-react'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import type { PathInfo } from '@/lib/api-paths'
import { copyText } from '@/lib/copy-text'
import { referToComposer } from '@/lib/fileDrag'
import { baseName, clickAction, sizeText } from '@/lib/file-ref'
import { toast } from '@/lib/toast'
import { MenuItem, MenuSeparator, PointMenu, popoverPanel } from '@/components/ui/menu'
import { cn } from '@/lib/utils'

/** 一个文件标记指向的东西 */
export interface FileRefTarget {
  path: string
  line?: number
  /** 用户消息里的附件：本机的绝对路径，不按对话目录找 */
  local?: boolean
  /** 附件卡片自己的「在面板里看」（看图浮层、文件弹窗） */
  preview?: () => void
}

interface FileRefApi {
  open: (target: FileRefTarget) => void | Promise<void>
  menu: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    target: FileRefTarget,
    el: HTMLElement,
  ) => void
  hover: (el: HTMLElement, target: FileRefTarget) => void
  leave: () => void
  /** 把 root 里的文件标记按真实情况标出来：找不到的划掉（回复渲染完调用） */
  mark: (root: HTMLElement) => void
}

const FileRefCtx = createContext<FileRefApi | null>(null)
export const useFileRef = () => useContext(FileRefCtx)

/** 回复正文里的标记：路径和行号是 linkPaths 放在 data-* 上的 */
export function targetOf(el: HTMLElement): FileRefTarget {
  return { path: el.dataset.path ?? '', line: el.dataset.mdLine ? Number(el.dataset.mdLine) : undefined }
}

/** 解析结果留这么久：Agent 正在新建、删除文件，太久的「不存在」会骗人 */
const CACHE_MS = 15_000
/** 停这么久才弹悬停卡片：划过去不闪 */
const HOVER_DELAY = 400

export function FileRefLayer({
  taskId,
  preview,
  children,
}: {
  taskId: string
  /** 在面板里看文件（任务页的文件弹窗） */
  preview: (path: string, line?: number) => void
  children: React.ReactNode
}) {
  const cache = useRef(new Map<string, { at: number; info: Promise<PathInfo | null> }>())
  const resolveMany = useCallback(
    (paths: string[]) => {
      const now = Date.now()
      const want = [...new Set(paths)].filter((p) => {
        const hit = cache.current.get(p)
        return !hit || now - hit.at > CACHE_MS
      })
      if (want.length) {
        const batch = api.taskPaths(taskId, want).then(
          (r) => new Map(r.items.map((x) => [x.path, x])),
          // 解析失败（导入的任务没有本机目录）不打扰：卡片只显示原样的路径
          () => new Map<string, PathInfo>(),
        )
        for (const p of want) cache.current.set(p, { at: now, info: batch.then((m) => m.get(p) ?? null) })
      }
      return Promise.all(paths.map((p) => cache.current.get(p)!.info))
    },
    [taskId],
  )
  const resolve = useCallback((p: string) => resolveMany([p]).then((r) => r[0]), [resolveMany])

  const [card, setCard] = useState<{ el: HTMLElement; target: FileRefTarget; info?: PathInfo | null } | null>(null)
  const timer = useRef(0)
  const [menu, setMenu] = useState<{
    at: { x: number; y: number }
    target: FileRefTarget
    el: HTMLElement
    info?: PathInfo | null
  } | null>(null)

  const openSystem = useCallback(
    (target: FileRefTarget, reveal = false) => {
      const run = target.local ? api.openLocalFile(target.path, reveal) : api.openTaskPath(taskId, target.path, reveal)
      void run
        .then((r) => !reveal && r.revealed && toast(t('这类文件不直接打开，已在文件夹中显示')))
        .catch((e) => toast.error((e as Error).message))
    },
    [taskId],
  )
  const previewOf = useCallback(
    async (target: FileRefTarget) => {
      if (target.local) return target.preview?.()
      // 在上级目录（工作区根）里找到的文件，面板预览要按完整路径读
      const info = await resolve(target.path)
      preview(info?.exists && !info.inTask ? info.abs : target.path, target.line)
    },
    [preview, resolve],
  )
  const open = useCallback(
    async (target: FileRefTarget) => {
      clearTimeout(timer.current)
      setCard(null)
      // 目录看扩展名看不出来：按解析结果（回复渲染完已经解析过，一般直接命中缓存）
      const dir = !target.local && !!(await resolve(target.path))?.dir
      if (dir || clickAction(target.path) === 'system') return openSystem(target)
      void previewOf(target)
    },
    [openSystem, previewOf, resolve],
  )

  const api_ = useMemo<FileRefApi>(
    () => ({
      open,
      menu: (e, target, el) => {
        e.preventDefault()
        clearTimeout(timer.current)
        setCard(null)
        el.dataset.menu = ''
        setMenu({ at: { x: e.clientX, y: e.clientY }, target, el })
        if (!target.local)
          void resolve(target.path).then((info) => setMenu((m) => (m && m.el === el ? { ...m, info } : m)))
      },
      hover: (el, target) => {
        clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          setCard({ el, target })
          if (!target.local)
            void resolve(target.path).then((info) => setCard((c) => (c && c.el === el ? { ...c, info } : c)))
        }, HOVER_DELAY)
      },
      leave: () => {
        clearTimeout(timer.current)
        setCard(null)
      },
      mark: (root) => {
        const els = [...root.querySelectorAll<HTMLElement>('[data-file-ref][data-path]')]
        if (!els.length) return
        void resolveMany(els.map((el) => el.dataset.path!)).then((infos) =>
          els.forEach((el, i) => {
            const info = infos[i]
            if (info && !info.exists) el.dataset.missing = ''
            else delete el.dataset.missing
            if (info?.dir) el.dataset.kind = 'folder'
          }),
        )
      },
    }),
    [open, resolve, resolveMany],
  )
  useEffect(() => () => clearTimeout(timer.current), [])
  // 滚动时卡片会和标记错开，直接收起
  useEffect(() => {
    if (!card) return
    const off = () => setCard(null)
    window.addEventListener('scroll', off, true)
    return () => window.removeEventListener('scroll', off, true)
  }, [card])

  const closeMenu = () => {
    if (menu) delete menu.el.dataset.menu
    setMenu(null)
  }
  return (
    <FileRefCtx.Provider value={api_}>
      {children}
      {card && <HoverCard el={card.el} target={card.target} info={card.info} />}
      {menu && (
        <PointMenu at={menu.at} open onOpenChange={(v) => !v && closeMenu()}>
          <RefMenu
            target={menu.target}
            info={menu.info}
            onPreview={() => void previewOf(menu.target)}
            onSystem={(reveal) => openSystem(menu.target, reveal)}
            onRefer={() => {
              const p = menu.target.local ? menu.target.path : menu.info?.rel || menu.info?.abs || menu.target.path
              if (!referToComposer({ path: p, kind: menu.info?.dir ? 'dir' : 'file' }, menu.el))
                toast(t('这里没有可以引用到的输入框'))
            }}
          />
        </PointMenu>
      )}
    </FileRefCtx.Provider>
  )
}

/** 单击会做什么：写在悬停卡片底部，点之前就知道 */
function clickHint(target: FileRefTarget, info?: PathInfo | null) {
  if (info?.dir) return t('单击 在文件夹中打开')
  const how = clickAction(target.path)
  if (how === 'image') return t('单击 查看图片')
  if (how === 'text') return t('单击 在面板中查看')
  return t('单击 用默认程序打开')
}

function HoverCard({ el, target, info }: { el: HTMLElement; target: FileRefTarget; info?: PathInfo | null }) {
  const r = el.getBoundingClientRect()
  const width = Math.min(440, window.innerWidth - 16)
  // 默认在标记下面，贴近底边时翻到上面；左右不出视口
  const below = r.bottom + 6 + 120 < window.innerHeight
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  const style: React.CSSProperties = below
    ? { left, top: r.bottom + 6, width }
    : { left, bottom: window.innerHeight - r.top + 6, width }
  const abs = target.local ? target.path : info?.abs
  const row = (k: string, v: string) => (
    <div className="grid grid-cols-[4.5em_1fr] gap-2">
      <span className="text-subtle">{k}</span>
      <span className="min-w-0 font-mono text-caption break-all text-fg/90">{v}</span>
    </div>
  )
  return createPortal(
    <div
      role="tooltip"
      data-file-card
      style={style}
      className={cn(popoverPanel, 'pointer-events-none fixed min-w-0 space-y-1 px-3 py-2.5 text-footnote')}
    >
      {info?.rel && row(t('项目内'), info.rel + (target.line ? `:${target.line}` : ''))}
      {row(t('完整路径'), abs ?? target.path)}
      {info?.exists && info.size !== undefined && row(t('大小'), sizeText(info.size))}
      {info?.exists && info.mtime && row(t('修改时间'), new Date(info.mtime).toLocaleString())}
      {info && !info.exists && <p className="text-danger">{t('找不到这个文件，可能已删除或路径写错')}</p>}
      <div className="mt-1.5 flex flex-wrap gap-x-4 border-t border-line pt-1.5 text-caption text-subtle">
        <span>{clickHint(target, info)}</span>
        <span>{t('右键 更多')}</span>
      </div>
    </div>,
    document.body,
  )
}

function RefMenu({
  target,
  info,
  onPreview,
  onSystem,
  onRefer,
}: {
  target: FileRefTarget
  info?: PathInfo | null
  onPreview: () => void
  onSystem: (reveal: boolean) => void
  onRefer: () => void
}) {
  const how = info?.dir ? 'system' : clickAction(target.path)
  const missing = !!info && !info.exists
  const abs = target.local ? target.path : (info?.abs ?? '')
  const line = target.line ? `:${target.line}` : ''
  const copy = (text: string) => void copyText(text, { done: t('已复制') })
  const canPreview = how !== 'system' && (!target.local || !!target.preview)
  return (
    <>
      {canPreview && (
        <MenuItem disabled={missing} onSelect={onPreview}>
          <Eye className="h-4 w-4" />
          {how === 'image' ? t('查看图片') : t('在面板中查看')}
        </MenuItem>
      )}
      {!info?.dir && (
        <MenuItem disabled={missing} onSelect={() => onSystem(false)}>
          <ExternalLink className="h-4 w-4" />
          {t('用默认程序打开')}
        </MenuItem>
      )}
      <MenuItem disabled={missing} onSelect={() => onSystem(true)}>
        <FolderOpen className="h-4 w-4" />
        {info?.dir ? t('在文件夹中打开') : t('在文件夹中显示')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={!abs} onSelect={() => copy(abs)}>
        <Copy className="h-4 w-4" />
        {t('复制完整路径')}
      </MenuItem>
      {!target.local && info?.rel && (
        <MenuItem onSelect={() => copy(info.rel + line)}>
          <Copy className="h-4 w-4" />
          {t('复制相对路径')}
        </MenuItem>
      )}
      <MenuItem onSelect={() => copy(baseName(target.path))}>
        <Copy className="h-4 w-4" />
        {t('复制文件名')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={onRefer}>
        <AtSign className="h-4 w-4" />
        {t('引用到输入框')}
      </MenuItem>
    </>
  )
}
