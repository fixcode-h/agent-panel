import { useState } from 'react'
import { ArrowUpRight, BarChart3, History, Link2, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableHit } from '@shared/tables'
import { cellRef } from '@shared/table-edit'
import { parseRef } from '@shared/table-struct'
import { Modal } from '@/components/ui/modal'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  MenuShortcut,
} from '@/components/ui/menu'

/** 菜单里怎么写一处引用：「C_Character.xlsx · ID = 1003」 */
const refLabel = (ref: string, v: string) => {
  const p = parseRef(ref)
  return p ? `${p.file.replace(/^.*\//, '')} · ${p.field} = ${v}` : `${ref} = ${v}`
}

/** 引用列一格里最多列几项跳转 */
const MAX_JUMPS = 8

export interface CellMenuOpts {
  /** 右键的这一格是引用列：引用写法和格子里的值（数组列拆成几项） */
  ref?: { ref: string; values: string[] }
  /** 有别的表引用这张表：可以查谁引用了这一行 */
  backRefs?: boolean
  /** 数据格子、这一列有字段名：可以看这一格的历史、统计这一列 */
  history?: boolean
  readOnly: boolean
}

/**
 * 表格内容区的右键菜单：整个表格只挂一个（几千格每格一个菜单太重），右键时由 at 算出是哪一格。
 * 引用列可以跳到被引用的那一行；「谁引用了这一行」在弹窗里列出来，点一处跳过去
 */
export function CellMenu({
  children,
  at,
  opts,
  onJump,
  onBackRefs,
  onHistory,
  onFill,
  onFind,
  onStats,
  onBatch,
  onAiRegion,
}: {
  /** 统计这一列、推断规则 */
  onStats?: (cell: { r: number; c: number }) => void
  /** 批量修改选中的格子 */
  onBatch?: () => void
  /** 让 AI 改选中的一片 */
  onAiRegion?: () => void
  children: React.ReactElement
  /** 右键的地方是哪一格（不在格子上返回 null） */
  at: (e: React.MouseEvent) => { r: number; c: number } | null
  opts: (cell: { r: number; c: number }) => CellMenuOpts
  onJump: (ref: string, value: string) => void
  onBackRefs: (r: number) => void
  onHistory: (cell: { r: number; c: number }) => void
  onFill: (series: boolean) => void
  onFind: () => void
}) {
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null)
  const o = cell ? opts(cell) : null
  return (
    <ContextMenu onOpenChange={(open) => !open && setCell(null)}>
      <ContextMenuTrigger asChild onContextMenu={(e) => setCell(at(e))}>
        {children}
      </ContextMenuTrigger>
      {cell && o && (
        <ContextMenuContent>
          {o.ref && o.ref.values.length > 0 && (
            <>
              <ContextMenuLabel>{t('跳到被引用的行')}</ContextMenuLabel>
              {o.ref.values.slice(0, MAX_JUMPS).map((v) => (
                <ContextMenuItem key={v} onSelect={() => onJump(o.ref!.ref, v)}>
                  <ArrowUpRight className="h-3.5 w-3.5 text-subtle" />
                  <span className="truncate font-mono">{refLabel(o.ref!.ref, v)}</span>
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
          {o.backRefs && (
            <ContextMenuItem onSelect={() => onBackRefs(cell.r)}>
              <Link2 className="h-3.5 w-3.5 text-subtle" />
              {t('谁引用了这一行')}
            </ContextMenuItem>
          )}
          {o.history && (
            <ContextMenuItem onSelect={() => onHistory(cell)}>
              <History className="h-3.5 w-3.5 text-subtle" />
              {t('这一格的历史')}
            </ContextMenuItem>
          )}
          {o.history && onStats && (
            <ContextMenuItem onSelect={() => onStats(cell)}>
              <BarChart3 className="h-3.5 w-3.5 text-subtle" />
              {t('统计这一列')}
            </ContextMenuItem>
          )}
          {(o.backRefs || o.history) && !o.readOnly && <ContextMenuSeparator />}
          {!o.readOnly && (
            <>
              <ContextMenuItem onSelect={() => onFill(false)}>
                {t('向下填充')}
                <MenuShortcut>Ctrl+D</MenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onFill(true)}>
                {t('按序列向下填充')}
                <MenuShortcut>Ctrl+Shift+D</MenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={onFind}>
                {t('查找替换')}
                <MenuShortcut>Ctrl+H</MenuShortcut>
              </ContextMenuItem>
              {onBatch && (
                <ContextMenuItem onSelect={onBatch}>
                  <Wand2 className="h-3.5 w-3.5 text-subtle" />
                  {t('批量修改…')}
                </ContextMenuItem>
              )}
              {onAiRegion && (
                <ContextMenuItem onSelect={onAiRegion}>
                  <Sparkles className="h-3.5 w-3.5 text-subtle" />
                  {t('让 AI 改这一片…')}
                </ContextMenuItem>
              )}
            </>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

/** 谁引用了这一行：结果列表，点一处打开那张表并跳到那一格 */
export function BackRefsDialog({
  title,
  hits,
  error,
  onPick,
  onClose,
}: {
  title: string
  /** null = 还在找 */
  hits: TableHit[] | null
  error: string
  onPick: (h: TableHit) => void
  onClose: () => void
}) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} size="lg">
      {error ? (
        <p className="text-body text-danger">{error}</p>
      ) : !hits ? (
        <div className="flex justify-center p-6 text-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !hits.length ? (
        <p className="py-6 text-center text-body text-subtle">{t('没有别的表引用这一行')}</p>
      ) : (
        <div role="list" aria-label={t('引用这一行的格子')} className="flex flex-col gap-px">
          <p className="pb-1.5 text-caption text-subtle">{t('{n} 处引用', { n: hits.length })}</p>
          {hits.map((h, i) => (
            <button
              key={i}
              type="button"
              role="listitem"
              onClick={() => onPick(h)}
              className="flex cursor-pointer items-center gap-3 rounded-(--c-row-radius) px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-body">{h.path}</span>
              <span className="shrink-0 font-mono text-caption text-subtle">
                {h.sheet} · {cellRef(h.row, h.col)}
              </span>
              <span className="max-w-[40%] min-w-0 truncate font-mono text-footnote text-muted">{h.text}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
