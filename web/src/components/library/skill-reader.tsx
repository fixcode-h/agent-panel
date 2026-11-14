import { forwardRef, useMemo, type ButtonHTMLAttributes } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import type { LibraryEntryContent } from '@shared/library'
import { t } from '@shared/i18n'
import { entryName, type TreeRow } from '@/lib/library-tree'
import { fileIcon } from '@/lib/file-icon'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/segmented'
import { Markdown } from '@/components/tasks/Markdown'

/**
 * 技能详情页的文件浏览区（自带 Skill 和我的 Skill 共用一套样子）：
 * 左边文件树、右边阅读 / 编辑区，铺满详情页剩下的高度，中间用 1px 细线分开、不套卡片——
 * 以前是限宽 1100px 的两张卡片，右边没选文件时只有一个空框，整页大半是留白。
 */

const NO_TEAM = new Set<string>()

export const sizeText = (bytes: number) =>
  bytes >= 1024 ? t('{n} KB', { n: (bytes / 1024).toFixed(1) }) : t('{n} 字节', { n: bytes })

/** Markdown 才有「预览」：其它文件只有源码 */
export const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path)

/** 预览时去掉开头的 YAML 头：名字和说明页头已经写了，正文顶上再摆一遍是重复 */
const stripFront = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

/** 收起的目录集合：点一下目录就切换 */
export const toggleFolded = (s: ReadonlySet<string>, path: string) => {
  const next = new Set(s)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** 整个浏览区：左栏（树）+ 右栏（路径栏 + 内容），窄屏上下排 */
export function BrowserSplit({ tree, children }: { tree: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[420px] flex-1 flex-col border-t md:min-h-0 md:flex-row">
      <nav
        aria-label={t('文件结构')}
        className="flex max-h-[40vh] shrink-0 flex-col border-b md:max-h-none md:w-[260px] md:border-r md:border-b-0"
      >
        {tree}
      </nav>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</section>
    </div>
  )
}

/** 树的栏头：「文件结构」+ 文件数，右边可放新建按钮 */
export function TreeHead({ count, actions }: { count: number; actions?: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
      <h3 className="text-footnote font-medium text-muted">{t('文件结构')}</h3>
      <span className="text-caption text-subtle">{count}</span>
      {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
    </div>
  )
}

/** 树的滚动区 */
export function TreeBody({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3">{children}</div>
}

type RowProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  depth: number
  active: boolean
  /** 目录才传：展开着没有 */
  open?: boolean
  icon: React.ReactNode
  label: string
  mono?: boolean
  trailing?: React.ReactNode
}

/**
 * 树里的一行。箭头单独占一格，文件行和目录行的图标对齐在同一列。
 * 要转发 ref 和其余属性：右键菜单（ContextMenuTrigger asChild）要挂在这个按钮上。
 */
export const TreeButton = forwardRef<HTMLButtonElement, RowProps>(function TreeButton(
  { depth, active, open, icon, label, mono, trailing, className, style, ...rest },
  ref,
) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-current={active || undefined}
      style={{ paddingLeft: 6 + depth * 16, ...style }}
      className={cn(
        'flex h-7 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-footnote',
        active ? 'bg-sel text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      <span className="grid w-3 shrink-0 place-items-center">
        {open !== undefined && <Chevron className="h-3 w-3 text-subtle" />}
      </span>
      {icon}
      <span className={cn('min-w-0 truncate', mono && 'font-mono')}>{label}</span>
      {trailing}
    </button>
  )
})

/** 主文件那一行：置顶，图标用强调色 */
export const mainIcon = <FileText className="h-3.5 w-3.5 shrink-0 text-accent-text" />

/** 普通行的图标和显示名：目录是文件夹（随展开换样子），文件按扩展名挑、统一灰色，只有选中行亮起来 */
export function rowLook(r: TreeRow, folded: ReadonlySet<string>) {
  const dir = r.type === 'dir'
  const shut = folded.has(r.path)
  const Icon = dir ? (shut ? Folder : FolderOpen) : fileIcon(r.path)
  return {
    open: dir ? !shut : undefined,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />,
    label: entryName(r.path),
    mono: !dir,
  }
}

/** 右栏顶上的路径栏：面包屑、大小和行数、右边的操作 */
export function PathBar({
  path,
  meta,
  children,
}: {
  path: string
  meta?: React.ReactNode
  children?: React.ReactNode
}) {
  const crumbs = path.split('/')
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 font-mono text-footnote" title={path}>
        {crumbs.map((c, i) => (
          <span key={i} className={cn('flex items-center gap-1', i === crumbs.length - 1 ? 'min-w-0' : 'shrink-0')}>
            {i > 0 && <span className="text-subtle">/</span>}
            <span className={cn('truncate', i === crumbs.length - 1 ? 'text-fg' : 'text-subtle')}>{c}</span>
          </span>
        ))}
        {meta && <span className="ml-2 shrink-0 font-sans text-caption text-subtle">{meta}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

/** 大小 · 行数 */
export const fileMeta = (content: string, size: number) =>
  `${sizeText(size)} · ${t('{n} 行', { n: content.split('\n').length })}`

/** Markdown 的「预览 / 源码（编辑）」切换 */
export function ViewSwitch<T extends string>({
  value,
  onChange,
  source,
}: {
  value: T
  onChange: (v: T) => void
  /** 第二段的 id 和文字：只读时是「源码」，能编辑时是「编辑」 */
  source: { id: T; label: string }
}) {
  return (
    <Segmented
      size="sm"
      label={t('查看方式')}
      value={value}
      onChange={onChange}
      options={[{ id: 'preview' as T, label: t('预览') }, source]}
    />
  )
}

/** 按渲染效果看 Markdown：限一个舒服的行宽，左对齐在阅读区里 */
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="max-w-[860px] px-6 py-5 md:px-8">
      <Markdown text={stripFront(text)} teamNames={NO_TEAM} />
    </div>
  )
}

/** 只读的源码：带行号，悬停行浅底（和文件弹窗一样，不加斑马纹和暗底） */
export function SourceLines({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <pre className="py-3 font-mono text-footnote leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className="flex hover:bg-fg/4">
          <span className="w-12 shrink-0 pr-4 text-right text-subtle/55 select-none">{i + 1}</span>
          <span className="min-w-0 flex-1 pr-4 whitespace-pre-wrap [overflow-wrap:anywhere]">{l || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

/** 阅读区里的一句提示（读取失败、二进制、没内容） */
export function ReaderNote({ tone, children }: { tone?: 'warning'; children: React.ReactNode }) {
  return <p className={cn('px-6 py-5 text-body', tone === 'warning' ? 'text-warning' : 'text-subtle')}>{children}</p>
}

/** 读到的文件按类型挑画法：二进制只提示，Markdown 看预览或源码，其它看源码 */
export function FileBody({ file, preview }: { file: LibraryEntryContent; preview: boolean }) {
  if (file.binary)
    return <ReaderNote>{t('二进制文件（{size}），不显示内容。', { size: sizeText(file.size) })}</ReaderNote>
  return preview ? <MarkdownPreview text={file.content} /> : <SourceLines text={file.content} />
}
