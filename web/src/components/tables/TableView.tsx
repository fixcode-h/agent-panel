import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { schemaHeader, type TableDoc, type TableSchema } from '@shared/tables'
import type { SheetHeader } from '@shared/sheet-header'
import { SheetTable, SheetTabs } from '@/components/files/SheetTable'
import { SheetHeaderBar } from '@/components/files/SheetHeaderBar'
import { useSheetView, type SheetHeaderStore } from '@/components/files/use-sheet-view'
import type { CellHit } from '@/lib/sheet'

/** 从内容搜索跳过来：切到这张表、滚到这一格 */
export interface TableJump {
  sheet: string
  row: number
  col: number
  /** 每跳一次加一：同一格再点也要滚过去 */
  seq: number
}

/**
 * 表格页右边打开的一个文件：工作表页签、表头栏（表头来自项目的表格结构文件，没有就自动识别）、表格。
 * 表头改了写进结构文件（onSchema），表格文件本身不动
 */
export function TableView({
  doc,
  schema,
  onSchema,
  jump,
  sheetIndex,
  onSheet,
}: {
  doc: TableDoc
  schema: TableSchema
  onSchema: (s: TableSchema) => void
  jump?: TableJump
  sheetIndex: number
  onSheet: (i: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const index = Math.min(sheetIndex, Math.max(0, doc.sheets.length - 1))
  const sheet = doc.sheets[index]
  const rows = sheet?.rows ?? null
  const fileKey = `${doc.path}#${sheet?.name ?? ''}`
  const store = useMemo<SheetHeaderStore>(
    () => ({
      own: schema.files[fileKey],
      style: sheet ? schemaHeader({ ...schema, files: {} }, doc.path, sheet.name) : undefined,
      save: (h: SheetHeader | null) => {
        const files = { ...schema.files }
        if (h) files[fileKey] = { start: h.start, roles: h.roles }
        else delete files[fileKey]
        onSchema({ ...schema, files })
      },
    }),
    [schema, fileKey, sheet, doc.path, onSchema],
  )
  const view = useSheetView(fileKey, rows, store)

  // 搜索跳转：切表在外面做（onSheet），这里只管滚到那一格
  const [hit, setHit] = useState<{ hits: CellHit[]; seq: number }>({ hits: [], seq: 0 })
  useEffect(() => {
    if (!jump || jump.sheet !== sheet?.name) return
    setHit({ hits: [{ row: jump.row, col: jump.col }], seq: jump.seq })
  }, [jump, sheet?.name])

  if (doc.kind === 'xls')
    return (
      <p className="p-6 text-body leading-relaxed text-subtle">
        {t('老的 .xls（Excel 97–2003）格式只能列出来，不能在这里打开和修改。用 Excel / WPS 另存为 .xlsx 后就能用了。')}
      </p>
    )
  if (!sheet || !rows || !view) return <p className="p-6 text-body text-subtle">{t('这个文件里没有工作表')}</p>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {doc.sheets.length > 1 && <SheetTabs sheets={doc.sheets} index={index} onChange={onSheet} />}
      <SheetHeaderBar
        view={view}
        rows={rows}
        where={t('记在项目的表格结构文件里（项目设置 → 表格），表格文件一个字节都不改。')}
      />
      <div ref={box} className="thin-scroll min-h-0 flex-1 overflow-auto">
        <SheetTable
          rows={rows}
          scrollEl={box}
          hits={hit.hits}
          current={0}
          seq={hit.seq}
          header={view.header}
          order={view.order}
          filters={view.filters}
          sort={view.sort}
          onFilter={view.setFilter}
          onSort={view.setSort}
        />
      </div>
    </div>
  )
}
