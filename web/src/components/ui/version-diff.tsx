import { useSyncExternalStore, type ReactNode } from 'react'
import { History, Loader2 } from 'lucide-react'
import { compValue } from '@shared/component-style'
import { t } from '@shared/i18n'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import { cn } from '@/lib/utils'
import { Modal, ModalHeader } from './modal'
import { ResizeHandle, usePaneWidth } from './resize'

/** 一条版本记录（形状和服务端 server/exec/vcs-history.ts 的 FileRev 一样） */
export interface VersionRev {
  id: string
  label: string
  author?: string
  time?: string
  message?: string
}

/** 版本记录列表：没拿到时传 null（转圈） */
export interface VersionList {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  revs: VersionRev[]
  error?: string
}

/**
 * 设置 → 组件「版本差异」里不是 CSS 的几项（UE 插件的资源版本差异读）：读取超过几秒提示 UE 在忙、
 * 属性来历一次往回读几版、「同一次提交改的资源」默认展开还是收起
 */
export function useVersionDiffPrefs() {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  return {
    busySec: Number(compValue(style, 'versionDiff', 'busySec')) || 60,
    historyMax: Number(compValue(style, 'versionDiff', 'historyMax')) || 20,
    sameCommitOpen: compValue(style, 'versionDiff', 'sameCommit') !== 'closed',
  }
}

/** 选中的是「本地改动」还是第几个提交 */
export type VersionPick = 'local' | number

/**
 * 版本差异弹窗的外壳（表格、UE 资源都用）：左边是这个文件的版本记录（本地改动 + 历次提交），可以拖宽、记住宽度；
 * 右边上面一行是调用方的头部（标题、摘要、和哪一版比、切换、只看变化），下面是调用方自己的差异视图。
 * 列表项的样子（默认宽度、提交说明显示几行）在设置 → 组件「版本差异」里调
 */
export function VersionDiffShell({
  open,
  onClose,
  meta,
  list,
  failed,
  pick,
  onPick,
  local,
  tags,
  header,
  children,
  paneKey,
  className,
}: {
  open: boolean
  onClose: () => void
  /** 标题后面的灰字：文件路径 · 工作表 / 资源类型 */
  meta: ReactNode
  list: VersionList | null
  /** 版本记录取不到（接口出错）：左栏显示原因，不一直转圈 */
  failed?: string
  pick: VersionPick
  onPick: (p: VersionPick) => void
  /** 「本地改动」那一项的说明；不传就不列这一项 */
  local?: { meta: string; message: string }
  /** 列表项下面的小标签（已经算过的「改了什么」），按版本 id 给；本地改动的键是 local */
  tags?: Record<string, ReactNode>
  header: ReactNode
  children: ReactNode
  /** 左栏宽度记在本机的键：表格和资源各记各的 */
  paneKey: string
  className?: string
}) {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const navW = Number(compValue(style, 'versionDiff', 'navW')) || 288
  const pane = usePaneWidth(`version-diff:${paneKey}`, navW, 200, 480)
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={null}
      bare
      closeOnOutside
      className={cn('h-[min(820px,calc(100dvh-3.75rem))] max-w-[1280px]', className)}
    >
      <ModalHeader icon={History} title={t('版本差异')} meta={meta} />
      <div className="flex min-h-0 flex-1">
        {/* 拖动条放在不滚动的外层：放进滚动的列表里，列表一滚它就跟着滚走了 */}
        <div style={{ width: pane.width }} className="relative flex shrink-0 border-r">
          <nav
            aria-label={t('版本记录')}
            className="thin-scroll flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
          >
            <VersionNav list={list} failed={failed} pick={pick} onPick={onPick} local={local} tags={tags} />
          </nav>
          <ResizeHandle pane={pane} side="right" label={t('拖动调整版本列表宽度')} />
        </div>
        <section aria-label={t('差异')} className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">{header}</header>
          {children}
        </section>
      </div>
    </Modal>
  )
}

/** 左栏的列表本身（设置里的样张也用它） */
export function VersionNav({
  list,
  failed,
  pick,
  onPick,
  local,
  tags,
}: {
  list: VersionList | null
  failed?: string
  pick: VersionPick
  onPick: (p: VersionPick) => void
  local?: { meta: string; message: string }
  tags?: Record<string, ReactNode>
}) {
  if (!list && failed) return <p className="px-2 py-4 text-caption text-danger">{failed}</p>
  if (!list)
    return (
      <div className="flex justify-center p-6 text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  if (list.vcs === 'none')
    return (
      <p className="px-2 py-4 text-footnote leading-relaxed text-subtle">
        {t('这个项目没有用 Git / P4 / SVN 管理，看不了版本差异。')}
      </p>
    )
  return (
    <>
      <p className="px-2 pt-1 pb-1.5 text-caption text-subtle">
        {t('{vcs} · 选一个版本看它改了什么', { vcs: list.vcs.toUpperCase() })}
      </p>
      {local && (
        <RevItem
          active={pick === 'local'}
          onClick={() => onPick('local')}
          label={t('本地改动')}
          meta={local.meta}
          message={local.message}
          tags={tags?.local}
        />
      )}
      {list.revs.map((r, i) => (
        <RevItem
          key={r.id}
          active={pick === i}
          onClick={() => onPick(i)}
          label={r.label}
          meta={r.time ? new Date(r.time).toLocaleString() : ''}
          message={[r.author, r.message].filter(Boolean).join(' · ')}
          tags={tags?.[r.id]}
        />
      ))}
      {list.error && <p className="px-2 py-2 text-caption text-danger">{list.error}</p>}
    </>
  )
}

function RevItem({
  active,
  onClick,
  label,
  meta,
  message,
  tags,
}: {
  active: boolean
  onClick: () => void
  label: string
  meta: string
  message: string
  tags?: ReactNode
}) {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const wrap = compValue(style, 'versionDiff', 'msgLines') === '2'
  return (
    <button
      type="button"
      aria-current={active || undefined}
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded-(--c-row-radius) px-2.5 py-2 text-left hover:bg-hover',
        active && 'bg-sel hover:bg-sel',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-body font-medium">{label}</span>
        <span className="ml-auto truncate text-caption text-subtle">{meta}</span>
      </span>
      {message && (
        <span className={cn('text-footnote text-muted', wrap ? 'line-clamp-2' : 'truncate')} title={message}>
          {message}
        </span>
      )}
      {tags && <span className="mt-0.5 flex flex-wrap gap-1">{tags}</span>}
    </button>
  )
}
