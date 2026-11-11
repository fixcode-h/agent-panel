import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BookA,
  EyeOff,
  History,
  Replace,
  ListChecks,
  Lock,
  Plus,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react'
import { t } from '@shared/i18n'
import { TYPE_NAMES, schemaHeader, type TableDoc, type TableHit, type TableSchema } from '@shared/tables'
import type { CellSet, RowOp, SheetEdit } from '@shared/table-edit'
import type { SheetHeader } from '@shared/sheet-header'
import type { TableExport } from '@shared/table-export'
import { colCount, colName as colLetter, type CellHit } from '@/lib/sheet'
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
import { EnumRenameDialog } from './EnumRenameDialog'
import { findEnumRenames, type EnumRename } from '@shared/table-enum-rename'
import { ListEditor } from './ListEditor'
import { ProblemsBar } from './ProblemsBar'
import { useTableStruct } from './use-table-struct'
import { TableSaveDialog } from './TableSaveDialog'
import { TableHistoryDialog } from './TableHistoryDialog'
import {
  dirtyCells,
  pendingOf,
  redoIn,
  rowOpIn,
  rowOpWithCells,
  rowsOf,
  setCellsIn,
  undoIn,
  type Edits,
} from './table-edits'
import { nextKey } from '@shared/table-tools'
import { useGridEdit } from './use-grid-edit'
import { ExportMenu } from './ExportMenu'
import { useColLayout } from './use-col-layout'
import { FindReplaceDialog } from './FindReplaceDialog'
import { BackRefsDialog, CellMenu } from './CellMenu'
import { findBackRefs, refsTo } from '@shared/table-refs'

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
  onCheckout,
  exports,
  onExport,
  onRefJump,
  onOpenHit,
  stale,
  onReload,
  onKeepMine,
  onFilesChanged,
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
  /** 把本地文件切换到某一版；失败时抛出原因 */
  onCheckout: (rev: string) => Promise<void>
  /** 项目设置里的导表脚本 */
  exports: TableExport[]
  /** 对这张表执行第几个导表脚本 */
  onExport: (index: number) => void
  /** 引用列的值：打开被引用的表、跳到那一行 */
  onRefJump: (ref: string, value: string) => void
  /** 打开别的表的某一格（反向引用的结果） */
  onOpenHit: (h: TableHit) => void
  /** 文件在外面被改过、页面上又有没保存的改动 */
  stale?: boolean
  /** 重新载入；keep 时把改过的格子写回新内容上 */
  onReload: (keep: boolean) => void
  /** 不管外面的改动，接着改（保存时只写改过的格子） */
  onKeepMine: () => void
  /** 别的操作（枚举改名替换）改了这些文件：重新载入 */
  onFilesChanged: (paths: string[]) => void
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
  const [layout, setLayout] = useColLayout(`${projectId}:${fileKey}`)
  const hiddenSet = useMemo(() => new Set(layout.hidden), [layout.hidden])
  const readOnly = !!doc.readOnly
  const dirty = useMemo(() => (sheet ? dirtyCells(edits, sheet) : new Set<string>()), [edits, sheet])
  const pending = useMemo(() => pendingOf(edits, doc.sheets), [edits, doc.sheets])
  const [saving, setSaving] = useState(false)
  const [enumsOpen, setEnumsOpen] = useState<string | null>(null)
  const [renames, setRenames] = useState<EnumRename[] | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const [backRefs, setBackRefs] = useState<{ title: string; hits: TableHit[] | null; error: string } | null>(null)
  const hasBackRefs = useMemo(() => refsTo(schema, doc.path).length > 0, [schema, doc.path])
  /** 谁引用了这一行：按这一行的「字段名 → 值」去引用方的表里找 */
  const showBackRefs = (r: number) => {
    if (!sheet || !rows) return
    const row: Record<string, string> = {}
    struct.infos.forEach((info, c) => info.field && (row[info.field] = rows[r]?.[c] ?? ''))
    setBackRefs({ title: t('谁引用了第 {n} 行', { n: r + 1 }), hits: null, error: '' })
    findBackRefs(schema, doc.path, sheet.name, row, async (f) => (await loadDoc(f))?.sheets)
      .then((hits) => setBackRefs((b) => b && { ...b, hits }))
      .catch((e) => setBackRefs((b) => b && { ...b, error: (e as Error).message }))
  }
  const [finding, setFinding] = useState<{ sel: { rows: number[]; cols: number[] } | null } | null>(null)
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

  // 保存前检查：改到的行里不合规的格子（改了一格可能让同一行的必填、组合唯一出问题，所以按行算）
  const touchedProblems = useMemo(() => {
    if (!saving) return []
    const touched = new Set([...dirty].map((k) => Number(k.slice(0, k.indexOf(':')))))
    return struct.problems.filter((p) => touched.has(p.r)).map((p) => ({ ...p, field: struct.infos[p.c]?.field ?? '' }))
  }, [saving, dirty, struct.problems, struct.infos])
  const setCells = (cells: CellSet[]) => sheet && onEdits((e) => setCellsIn(e, sheet, cells))
  const rowOp = (op: RowOp) => sheet && onEdits((e) => rowOpIn(e, sheet, op))
  // 主键列：新增行自动编号（最大的整数 + 1），复制行时主键 +1
  const keyCol = struct.infos.findIndex((i) => !!schema.style.key && i.field === schema.style.key)
  /** 在 at 插一行：主键列填下一个编号；copy 是要复制的那一行 */
  const insertRow = (at: number, copy?: number) => {
    if (!sheet || !rows) return
    const from = view?.from ?? 0
    const id = keyCol >= 0 ? nextKey(rows, from, keyCol) : ''
    const src = copy === undefined ? [] : (rows[copy] ?? [])
    const cells: CellSet[] = src.map((v, c) => ({ r: at, c, v })).filter((x) => x.v)
    if (id && at >= from) cells.push({ r: at, c: keyCol, v: id })
    onEdits((e) => rowOpWithCells(e, sheet, { at, n: 1 }, cells))
    grid.go({ row: at, col: Math.max(0, keyCol) })
  }
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
      if (info?.list) return <ListEditor init={init} sep={info.sep} options={opts} title={title} onDone={done} />
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
      const cls = [
        dirty.has(k) && 'sheet-dirty',
        struct.problemAt.has(k) && 'sheet-bad',
        // 没字段名的备注列：灰字，不检查
        r >= (view?.from ?? 0) && struct.infos[c]?.remark && 'sheet-remark',
      ]
        .filter(Boolean)
        .join(' ')
      return cls || undefined
    },
    tip: (r, c) => struct.problemAt.get(`${r}:${c}`),
    hiddenCol: (c) => hiddenSet.has(c),
    onFind: () => setFinding({ sel: grid.selection() }),
    rowMenu: readOnly
      ? undefined
      : (r, trigger) => (
          <ContextMenu>
            <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => insertRow(r)}>{t('在上方插入一行')}</ContextMenuItem>
              <ContextMenuItem onSelect={() => insertRow(r + 1)}>{t('在下方插入一行')}</ContextMenuItem>
              <ContextMenuItem onSelect={() => insertRow(r + 1, r)}>
                {keyCol >= 0 ? t('复制这一行插到下方（主键自动编号）') : t('复制这一行插到下方')}
              </ContextMenuItem>
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
      {stale && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/8 px-3 py-1.5 text-footnote text-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="mr-auto">
            {t('文件在外面被改过了（Excel / WPS、版本控制或别人），页面上还有没保存的改动。')}
          </span>
          {pending.every((p) => !p.rows.length) && (
            <Button size="sm" variant="secondary" className="h-6" onClick={() => onReload(true)}>
              {t('载入新内容，保留我改的格子')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6" onClick={() => onReload(false)}>
            {t('载入新内容，丢掉我的改动')}
          </Button>
          <Button size="sm" variant="ghost" className="h-6" onClick={onKeepMine}>
            {t('先不管')}
          </Button>
        </div>
      )}
      <SheetHeaderBar
        view={view}
        rows={rows}
        where={t('记在项目的表格结构文件里（项目设置 → 表格），表格文件一个字节都不改。')}
      >
        {layout.hidden.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-accent-text"
            title={t('列名上右键可以隐藏列、冻结列')}
            onClick={() => setLayout({ ...layout, hidden: [] })}
          >
            <EyeOff className="h-3.5 w-3.5" />
            {t('隐藏了 {n} 列 · 全部显示', { n: layout.hidden.length })}
          </Button>
        )}
        <ColumnSetup
          info={grid.focus ? struct.infos[grid.focus.col] : undefined}
          file={doc.path}
          schema={schema}
          files={files}
          fields={struct.infos.map((i) => i.field)}
          onSchema={onSchema}
        />
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setHistOpen(true)}>
          <History className="h-3.5 w-3.5" />
          {t('版本')}
        </Button>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            title={t('查找替换（Ctrl+H）')}
            onClick={() => setFinding({ sel: grid.selection() })}
          >
            <Replace className="h-3.5 w-3.5" />
            {t('替换')}
          </Button>
        )}
        <ExportMenu exports={exports} onRun={onExport} />
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
            <IconButton icon={Plus} label={t('在末尾加一行')} onClick={() => insertRow(rows.length)} />
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
      <CellMenu
        at={(e) => {
          const el = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null
          return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null
        }}
        opts={({ r, c }) => {
          const info = r >= view.from ? struct.infos[c] : undefined
          const v = rows[r]?.[c] ?? ''
          const values =
            info?.ref && v ? (info.list ? v.split(info.sep) : [v]).map((x) => x.trim()).filter(Boolean) : []
          return {
            ref: info?.ref ? { ref: info.ref, values } : undefined,
            backRefs: hasBackRefs && r >= view.from,
            readOnly,
          }
        }}
        onJump={onRefJump}
        onBackRefs={showBackRefs}
        onFill={grid.fill}
        onFind={() => setFinding({ sel: grid.selection() })}
      >
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
            layout={layout}
            onLayout={setLayout}
          />
        </div>
      </CellMenu>
      {backRefs && (
        <BackRefsDialog
          {...backRefs}
          onPick={(h) => {
            setBackRefs(null)
            onOpenHit(h)
          }}
          onClose={() => setBackRefs(null)}
        />
      )}
      {finding && (
        <FindReplaceDialog
          rows={rows}
          order={view.order.filter((r) => r >= view.from)}
          cols={colCount(rows)}
          focusCol={grid.focus?.col}
          selection={finding.sel}
          colName={(c) => struct.infos[c]?.field || colLetter(c)}
          hidden={hiddenSet}
          onApply={setCells}
          onClose={() => setFinding(null)}
        />
      )}
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
          onSave={(enums) => {
            onSchema({ ...schema, enums })
            const r = findEnumRenames(schema.enums, enums)
            if (r.length) setRenames(r)
          }}
        />
      )}
      {renames && (
        <EnumRenameDialog
          projectId={projectId}
          renames={renames}
          onClose={() => setRenames(null)}
          onApplied={onFilesChanged}
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
          onCheckout={readOnly ? undefined : onCheckout}
          dirty={pending.length > 0}
        />
      )}
      {saving && (
        <TableSaveDialog
          open
          doc={doc}
          sheets={Object.fromEntries(doc.sheets.map((s) => [s.name, rowsOf(edits, s)]))}
          pending={pending}
          problems={touchedProblems}
          mode={schema.style.saveCheck}
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
