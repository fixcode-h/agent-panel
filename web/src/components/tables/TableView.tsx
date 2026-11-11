import { useEffect, useMemo, useState } from 'react'
import { BookA, History, ListChecks, Lock, Plus, Redo2, Save, Undo2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { TYPE_NAMES, schemaHeader, type TableDoc, type TableSchema } from '@shared/tables'
import type { CellSet, RowOp, SheetEdit } from '@shared/table-edit'
import type { SheetHeader } from '@shared/sheet-header'
import { colCount, type CellHit } from '@/lib/sheet'
import { cn } from '@/lib/utils'
import { SheetTable, SheetTabs } from '@/components/files/SheetTable'
import { SheetHeaderBar } from '@/components/files/SheetHeaderBar'
import { useSheetView, type SheetHeaderStore } from '@/components/files/use-sheet-view'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { CellEditor } from './CellEditor'
import { ColumnSetup } from './ColumnSetup'
import { EnumPicker } from './EnumPicker'
import { EnumsDialog } from './EnumsDialog'
import { ListEditor } from './ListEditor'
import { ProblemsBar } from './ProblemsBar'
import { useTableStruct } from './use-table-struct'
import { TableSaveDialog } from './TableSaveDialog'
import { TableHistoryDialog } from './TableHistoryDialog'
import { dirtyCells, pendingOf, redoIn, rowOpIn, rowsOf, setCellsIn, undoIn, type Edits } from './table-edits'
import { useGridEdit } from './use-grid-edit'

/** 从内容搜索跳过来：切到这张表、滚到这一格 */
export interface TableJump {
  sheet: string
  row: number
  col: number
  /** 每跳一次加一：同一格再点也要滚过去 */
  seq: number
}

/**
 * 表格页右边打开的一个文件：工作表页签、表头栏（表头来自项目的表格结构文件，没有就自动识别）、能改的表格。
 * 表头改了写进结构文件（onSchema）；格子的改动先记在页面上（edits），点保存才写回文件
 */
export function TableView({
  doc,
  schema,
  onSchema,
  jump,
  sheetIndex,
  onSheet,
  edits,
  onEdits,
  onSave,
  loadDoc,
  files,
  projectId,
}: {
  projectId: string
  /** 读别的表格文件（枚举表、被引用的表） */
  loadDoc: (path: string) => Promise<TableDoc | undefined>
  /** 项目里的表格文件（列结构里选引用用） */
  files: string[]
  doc: TableDoc
  schema: TableSchema
  onSchema: (s: TableSchema) => void
  jump?: TableJump
  sheetIndex: number
  onSheet: (i: number) => void
  edits: Edits | undefined
  onEdits: (f: (e: Edits) => Edits) => void
  /** 保存：成功返回 null，失败返回原因 */
  onSave: (pending: SheetEdit[], force: boolean) => Promise<string | null>
}) {
  const index = Math.min(sheetIndex, Math.max(0, doc.sheets.length - 1))
  const sheet = doc.sheets[index]
  const rows = useMemo(() => (sheet ? rowsOf(edits, sheet) : null), [edits, sheet])
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
  const readOnly = !!doc.readOnly
  const dirty = useMemo(() => (sheet ? dirtyCells(edits, sheet) : new Set<string>()), [edits, sheet])
  const pending = useMemo(() => pendingOf(edits, doc.sheets), [edits, doc.sheets])
  const [saving, setSaving] = useState(false)
  const [enumsOpen, setEnumsOpen] = useState<string | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const struct = useTableStruct({
    schema,
    doc,
    sheet,
    rows,
    header: view?.header,
    from: view?.from ?? 0,
    loadDoc,
  })
  /** 新增枚举值：记进结构文件 */
  const addEnumValue = (name: string, value: string) => {
    const e = schema.enums[name] ?? { values: [] }
    onSchema({ ...schema, enums: { ...schema.enums, [name]: { ...e, values: [...e.values, { name: value }] } } })
  }

  const setCells = (cells: CellSet[]) => sheet && onEdits((e) => setCellsIn(e, sheet, cells))
  const rowOp = (op: RowOp) => sheet && onEdits((e) => rowOpIn(e, sheet, op))
  const grid = useGridEdit({
    rows: rows ?? [],
    cols: Math.max(1, rows ? colCount(rows) : 1),
    from: view?.from ?? 0,
    order: view?.order ?? [],
    readOnly,
    onCells: setCells,
    onUndo: () => onEdits(undoIn),
    onRedo: () => onEdits(redoIn),
    onSave: () => pending.length && setSaving(true),
    editor: (p, init, done) => {
      const info = p.row >= (view?.from ?? 0) ? struct.infos[p.col] : undefined
      // 表头格子：这一行在设置里选了取值（通用枚举 / 类型名）就下拉选
      const head =
        view && p.row >= view.header.start && p.row < view.from
          ? view.header.roles[p.row - view.header.start]
          : undefined
      const headEnum = head ? schema.style.roleEnums?.[head] : undefined
      const headOpts = headEnum ? struct.enumOpts.get(headEnum) : undefined
      if (headEnum && headOpts?.length)
        return (
          <EnumPicker
            init={init}
            options={headOpts}
            title={headEnum === TYPE_NAMES ? t('类型') : headEnum}
            onDone={done}
          />
        )
      const opts = info?.enumName
        ? struct.enumOpts.get(info.enumName)
        : info?.ref
          ? struct.refOpts.get(info.ref)
          : undefined
      const title = info?.enumName ?? info?.ref ?? info?.field ?? ''
      if (info?.list)
        return <ListEditor init={init} sep={schema.style.listSep || ';'} options={opts} title={title} onDone={done} />
      if (info && opts)
        return (
          <EnumPicker
            init={init}
            options={opts}
            title={title}
            onDone={done}
            onAdd={info.enumName ? (v) => addEnumValue(info.enumName!, v) : undefined}
          />
        )
      return <CellEditor init={init} onDone={done} />
    },
    mark: (r, c) => {
      const k = `${r}:${c}`
      const cls = [dirty.has(k) && 'sheet-dirty', struct.problemAt.has(k) && 'sheet-bad'].filter(Boolean).join(' ')
      return cls || undefined
    },
    tip: (r, c) => struct.problemAt.get(`${r}:${c}`),
    rowMenu: readOnly
      ? undefined
      : (r, trigger) => (
          <ContextMenu>
            <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => rowOp({ at: r, n: 1 })}>{t('在上方插入一行')}</ContextMenuItem>
              <ContextMenuItem onSelect={() => rowOp({ at: r + 1, n: 1 })}>{t('在下方插入一行')}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem danger onSelect={() => rowOp({ at: r, n: -1 })}>
                {t('删除第 {n} 行', { n: r + 1 })}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ),
  })

  // 搜索跳转：切表在外面做（onSheet），这里选中那一格并滚过去
  const [hit, setHit] = useState<CellHit[]>([])
  const { go } = grid
  useEffect(() => {
    if (!jump || jump.sheet !== sheet?.name) return
    setHit([{ row: jump.row, col: jump.col }])
    go({ row: jump.row, col: jump.col })
  }, [jump, sheet?.name, go])

  if (doc.kind === 'xls')
    return (
      <p className="p-6 text-body leading-relaxed text-subtle">
        {t('老的 .xls（Excel 97–2003）格式只能列出来，不能在这里打开和修改。用 Excel / WPS 另存为 .xlsx 后就能用了。')}
      </p>
    )
  if (!sheet || !rows || !view) return <p className="p-6 text-body text-subtle">{t('这个文件里没有工作表')}</p>
  const canUndo = !!edits?.undo.length
  const canRedo = !!edits?.redo.length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {doc.sheets.length > 1 && <SheetTabs sheets={doc.sheets} index={index} onChange={onSheet} />}
      {(doc.locked || doc.readOnly) && (
        <p className="flex shrink-0 items-center gap-2 border-b bg-warning/8 px-3 py-1.5 text-footnote text-warning">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          {doc.readOnly ?? t('文件正在 Excel / WPS 里打开：可以先改，保存前要在那边关掉')}
        </p>
      )}
      <SheetHeaderBar
        view={view}
        rows={rows}
        where={t('记在项目的表格结构文件里（项目设置 → 表格），表格文件一个字节都不改。')}
      >
        <ColumnSetup
          info={grid.focus ? struct.infos[grid.focus.col] : undefined}
          file={doc.path}
          schema={schema}
          files={files}
          onSchema={onSchema}
        />
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setHistOpen(true)}>
          <History className="h-3.5 w-3.5" />
          {t('版本')}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setEnumsOpen('')}>
          <BookA className="h-3.5 w-3.5" />
          {t('枚举')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={cn('h-7', struct.problems.length > 0 && 'text-danger')}
          aria-pressed={checkOpen}
          onClick={() => setCheckOpen((o) => !o)}
        >
          <ListChecks className="h-3.5 w-3.5" />
          {struct.problems.length ? t('{n} 处不合规', { n: struct.problems.length }) : t('检查')}
        </Button>
        {!readOnly && (
          <span className="flex shrink-0 items-center gap-0.5">
            <IconButton icon={Undo2} label={t('撤销（Ctrl+Z）')} disabled={!canUndo} onClick={() => onEdits(undoIn)} />
            <IconButton icon={Redo2} label={t('重做（Ctrl+Y）')} disabled={!canRedo} onClick={() => onEdits(redoIn)} />
            <IconButton
              icon={Plus}
              label={t('在末尾加一行')}
              onClick={() => {
                rowOp({ at: rows.length, n: 1 })
                grid.go({ row: rows.length, col: 0 })
              }}
            />
            <Button
              size="sm"
              className="ml-1 h-7"
              variant={pending.length ? 'primary' : 'ghost'}
              disabled={!pending.length}
              onClick={() => setSaving(true)}
              title={t('保存（Ctrl+S）')}
            >
              <Save className="h-3.5 w-3.5" />
              {t('保存')}
            </Button>
          </span>
        )}
      </SheetHeaderBar>
      <div
        ref={grid.box}
        tabIndex={0}
        aria-label={t('表格内容')}
        onKeyDown={grid.onKeyDown}
        onPaste={grid.onPaste}
        className="thin-scroll min-h-0 flex-1 overflow-auto outline-none"
      >
        <SheetTable
          rows={rows}
          scrollEl={grid.box}
          hits={hit}
          header={view.header}
          order={view.order}
          filters={view.filters}
          sort={view.sort}
          onFilter={view.setFilter}
          onSort={view.setSort}
          edit={grid.edit}
          fill
          widthKey={`${projectId}:${fileKey}`}
        />
      </div>
      {checkOpen && (
        <ProblemsBar
          problems={struct.problems}
          infos={struct.infos}
          onPick={(p) => grid.go({ row: p.r, col: p.c })}
          onClose={() => setCheckOpen(false)}
        />
      )}
      {enumsOpen !== null && (
        <EnumsDialog
          open
          schema={schema}
          initial={enumsOpen || (grid.focus ? struct.infos[grid.focus.col]?.enumName : undefined)}
          onOpenChange={(o) => !o && setEnumsOpen(null)}
          onSave={(enums) => onSchema({ ...schema, enums })}
        />
      )}
      {histOpen && (
        <TableHistoryDialog
          open
          onClose={() => setHistOpen(false)}
          projectId={projectId}
          path={doc.path}
          sheet={sheet.name}
          rows={rows}
          schema={schema}
          onRestore={readOnly ? undefined : setCells}
        />
      )}
      {saving && (
        <TableSaveDialog
          open
          doc={doc}
          sheets={Object.fromEntries(doc.sheets.map((s) => [s.name, rowsOf(edits, s)]))}
          pending={pending}
          onCancel={() => setSaving(false)}
          onSave={async (force) => {
            const err = await onSave(pending, force)
            if (!err) setSaving(false)
            return err
          }}
        />
      )}
    </div>
  )
}
