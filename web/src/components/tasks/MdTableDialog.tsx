import { useEffect, useMemo, useRef } from 'react'
import { ClipboardCopy, FileCode2, Search, Table2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SheetHeader } from '@shared/sheet-header'
import { copyText } from '@/lib/copy-text'
import { findCells } from '@/lib/sheet'
import { reorderMarkdown, toTsv } from '@/lib/markdown/table'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { DialogScroll } from '@/components/tasks/DiffDialog'
import { SheetTable } from '@/components/files/SheetTable'
import { FileSearchBar, useFileSearch } from '@/components/files/FileSearch'
import { useSheetView, type SheetHeaderStore } from '@/components/files/use-sheet-view'

/** 回复里的表格第一行就是表头（一行字段名），不用自动识别 */
const HEADER: SheetHeader = { start: 0, roles: ['name'] }
const STORE: SheetHeaderStore = { own: HEADER, save: () => {} }

/**
 * 回复里的表格全屏看（分析稿第 29 条）：用文件弹窗同一个表格部件（SheetTable），表头钉住、列宽自适应、
 * 能查找（Ctrl+F）、按列筛选和排序；复制按全屏里筛选、排序后的样子。只是看，不改回复
 */
export function MdTableDialog({
  table,
  onClose,
}: {
  /** rows：表头一行 + 数据行（回复里原来的顺序）；src 是表格的 Markdown 原文 */
  table: { rows: string[][]; src: string } | null
  onClose: () => void
}) {
  const rows = table?.rows ?? null
  const box = useRef<HTMLDivElement>(null)
  const view = useSheetView(`md-table:${table?.src ?? ''}`, rows, STORE)
  const search = useFileSearch()
  const hits = useMemo(() => {
    if (!search.open || !rows) return []
    const shown = view?.shown
    // 筛掉的行不算命中；表头一直显示
    return findCells(rows, search.query, search.caseSensitive).filter((h) => h.row === 0 || !shown || shown.has(h.row))
  }, [search.open, search.query, search.caseSensitive, rows, view?.shown])

  // Ctrl/Cmd+F 打开这里的搜索（表格是虚拟渲染的，浏览器自带的查找搜不到屏幕外的行）；F3 / Shift+F3 上一个下一个
  useEffect(() => {
    if (!table) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.show(getSelection()?.toString())
      } else if (e.key === 'F3' && search.open) {
        e.preventDefault()
        if (e.shiftKey) search.prev(hits.length)
        else search.next(hits.length)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!rows) return null
  const order = view?.order ?? rows.slice(1).map((_, i) => i + 1)
  // 复制按现在看到的：筛选、排序之后的行
  const copy = (kind: 'tsv' | 'md') =>
    void copyText(
      kind === 'tsv'
        ? toTsv([rows[0], ...order.map((r) => rows[r])])
        : reorderMarkdown(
            table!.src,
            order.map((r) => r - 1),
          ),
      { done: t('已复制'), fail: t('复制失败') },
    )
  const filtered = order.length !== rows.length - 1
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={null}
      bare
      closeOnOutside
      // 搜索框开着时 Esc 先关搜索框
      onEscapeKeyDown={(e) => {
        if (!search.open) return
        e.preventDefault()
        search.close()
      }}
      className="h-[min(760px,calc(100dvh-3.75rem))] max-w-[1100px]"
    >
      <ModalHeader
        icon={Table2}
        title={t('表格')}
        meta={
          filtered
            ? t('{shown} / {n} 行 · {cols} 列', { shown: order.length, n: rows.length - 1, cols: rows[0].length })
            : t('{n} 行 · {cols} 列', { n: rows.length - 1, cols: rows[0].length })
        }
        actions={
          <>
            <ModalButton icon={Search} label={t('在表格中查找')} onClick={() => search.show()} />
            <ModalButton icon={ClipboardCopy} label={t('复制成 TSV（能直接粘进 Excel）')} onClick={() => copy('tsv')} />
            <ModalButton icon={FileCode2} label={t('复制成 Markdown')} onClick={() => copy('md')} />
          </>
        }
      />
      <FileSearchBar search={search} total={hits.length} onClose={search.close} />
      <DialogScroll box={box}>
        <SheetTable
          rows={rows}
          scrollEl={box}
          hits={hits}
          current={search.index}
          seq={search.seq}
          header={HEADER}
          order={view?.order}
          filters={view?.filters}
          sort={view?.sort}
          onFilter={view?.setFilter}
          onSort={view?.setSort}
        />
      </DialogScroll>
    </Modal>
  )
}
