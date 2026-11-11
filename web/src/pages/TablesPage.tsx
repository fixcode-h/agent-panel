import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCompareArrows, Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableDoc, TableHit, TableSchema, TableSearch, TablesIndex } from '@shared/tables'
import { useNav } from '@/lib/data'
import { tablesApi } from '@/lib/tables-api'
import { rememberTablesProject, useTablesEntry, useTablesProjects } from '@/lib/tables-nav'
import { toast, toastError } from '@/lib/toast'
import { parseRef } from '@shared/table-struct'
import { findRefTarget } from '@shared/table-refs'
import { ListPane } from '@/components/layout/ListPane'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { TableTree } from '@/components/tables/TableTree'
import { TableQuick } from '@/components/tables/TableQuick'
import { useTableMarks } from '@/components/tables/use-table-marks'
import { TableHits } from '@/components/tables/TableHits'
import { TableCheckList } from '@/components/tables/TableCheckList'
import { TablesCompareDialog } from '@/components/tables/TablesCompareDialog'
import { TableTabs } from '@/components/tables/TableTabs'
import { TableView, type TableJump } from '@/components/tables/TableView'
import { noEdits, pendingOf, setCellsIn, type Edits } from '@/components/tables/table-edits'
import { useExternalChange } from '@/components/tables/use-external-change'
import { ConfirmDialog } from '@/components/ui/dialog'
import { TableExportDialog } from '@/components/tables/TableExportDialog'
import type { SheetEdit } from '@shared/table-edit'
import type { TableExport } from '@shared/table-export'

type Mode = 'name' | 'content' | 'check'

/**
 * 表格页（项目设置 → 表格设了目录才有入口）：左边文件树和搜索（名字 / 内容），右边打开的表格。
 * 一次看一个项目的表格，项目在左栏顶上切；表头、枚举这些结构信息读写项目的表格结构文件，不碰表格本身
 */
export function TablesPage() {
  const { route, go, openProject } = useNav()
  const projects = useTablesProjects()
  const fallback = useTablesEntry()
  const projectId = projects.some((p) => p.id === route.id) ? route.id! : fallback
  useEffect(() => {
    if (projectId) rememberTablesProject(projectId)
  }, [projectId])

  if (!projectId)
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center p-6">
        <EmptyPanel as="div" className="flex max-w-md flex-col items-center gap-3">
          {t('还没有项目设置表格目录。在项目设置 → 表格里填上配置表所在的目录，这里就会列出来。')}
          {projects.length === 0 && (
            <Button size="sm" variant="secondary" onClick={() => go({ page: 'home' })}>
              {t('回到主页')}
            </Button>
          )}
        </EmptyPanel>
      </main>
    )
  return (
    <Workbench
      key={projectId}
      projectId={projectId}
      projects={projects.map((p) => ({ value: p.id, label: p.name }))}
      exports={projects.find((p) => p.id === projectId)?.tables?.exports ?? []}
      onProject={(id) => go({ page: 'tables', id })}
      onSettings={() => openProject(projectId, 'tables')}
    />
  )
}

/** 一个项目的表格工作台；换项目时整个重建（key），打开的文件、搜索都清掉 */
function Workbench({
  projectId,
  projects,
  onProject,
  onSettings,
  exports,
}: {
  projectId: string
  projects: { value: string; label: string }[]
  /** 项目设置里的导表脚本 */
  exports: TableExport[]
  onProject: (id: string) => void
  onSettings: () => void
}) {
  const [index, setIndex] = useState<TablesIndex | null>(null)
  const [indexError, setIndexError] = useState('')
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [mode, setMode] = useState<Mode>('name')
  /** 存了表格或结构文件后加一：「检查」重新查 */
  const [checkSeq, setCheckSeq] = useState(0)
  const [comparing, setComparing] = useState(false)
  const others = projects.filter((p) => p.value !== projectId)
  const [query, setQuery] = useState('')
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [docs, setDocs] = useState<Record<string, TableDoc | { error: string }>>({})
  const [sheetOf, setSheetOf] = useState<Record<string, number>>({})
  const [jump, setJump] = useState<TableJump>()
  // 每个打开的文件还没保存的改动；关页签、换项目前要确认
  const [edits, setEdits] = useState<Record<string, Edits>>({})
  const [closing, setClosing] = useState('')
  // 搜索跳转时文件还没读到：记下要切的表，读到后再切
  const pendingSheet = useRef<{ path: string; sheet: string } | null>(null)

  const reload = useCallback(
    (fresh = false) => {
      setIndexError('')
      tablesApi
        .list(projectId, fresh)
        .then(setIndex)
        .catch((e) => setIndexError((e as Error).message))
    },
    [projectId],
  )
  useEffect(() => {
    reload()
    tablesApi
      .schema(projectId)
      .then(setSchema)
      .catch((e) => toast.error((e as Error).message))
  }, [projectId, reload])

  const load = useCallback(
    (path: string, force = false) => {
      if (!force && docs[path] && !('error' in docs[path])) return
      tablesApi
        .open(projectId, path)
        .then((d) => setDocs((m) => ({ ...m, [path]: d })))
        .catch((e) => setDocs((m) => ({ ...m, [path]: { error: (e as Error).message } })))
    },
    [projectId, docs],
  )
  const marks = useTableMarks(projectId, active)
  const open = (path: string) => {
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    setActive(path)
    load(path)
  }
  const dirtyPaths = new Set(
    Object.keys(edits).filter((p) => {
      const d = docs[p]
      return d && 'sheets' in d && pendingOf(edits[p], d.sheets).length > 0
    }),
  )
  // 有没保存的改动时关页面、刷新先提醒
  const anyDirty = dirtyPaths.size > 0
  useEffect(() => {
    if (!anyDirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])
  const close = (path: string, force = false) => {
    if (!force && dirtyPaths.has(path)) return setClosing(path)
    setEdits(({ [path]: _, ...m }) => m)
    const i = tabs.indexOf(path)
    const rest = tabs.filter((p) => p !== path)
    setTabs(rest)
    if (active === path) setActive(rest[Math.min(i, rest.length - 1)] ?? '')
    setDocs(({ [path]: _, ...m }) => m)
  }
  const openHit = (h: TableHit) => {
    open(h.path)
    const doc = docs[h.path]
    const i = doc && 'sheets' in doc ? doc.sheets.findIndex((s) => s.name === h.sheet) : -1
    pendingSheet.current = { path: h.path, sheet: h.sheet }
    if (i >= 0) setSheetOf((m) => ({ ...m, [h.path]: i }))
    setJump((j) => ({ sheet: h.sheet, row: h.row, col: h.col, seq: (j?.seq ?? 0) + 1 }))
  }
  // 读到文件后补上搜索跳转要切的表
  useEffect(() => {
    const p = pendingSheet.current
    const doc = p && docs[p.path]
    if (!p || !doc || !('sheets' in doc)) return
    const i = doc.sheets.findIndex((s) => s.name === p.sheet)
    if (i >= 0) setSheetOf((m) => ({ ...m, [p.path]: i }))
    pendingSheet.current = null
  }, [docs])

  const search = useContentSearch(projectId, mode === 'content' ? query : '')
  // 别的表格文件（枚举表、被引用的表）：打开过的直接用，没打开的读一次记下
  const extDocs = useRef(new Map<string, Promise<TableDoc | undefined>>())
  const loadDoc = useCallback(
    (path: string) => {
      const open = docs[path]
      if (open && 'sheets' in open) return Promise.resolve(open)
      let p = extDocs.current.get(path)
      if (!p) {
        p = tablesApi.open(projectId, path).catch(() => undefined)
        extDocs.current.set(path, p)
      }
      return p
    },
    [projectId, docs],
  )
  // 正在保存、切换版本：这期间文件的修改时间会变，外部改动检测先别看
  const busy = useRef(false)
  // 被外面改过、页面上又有没保存改动的文件：表格上方提示，用户决定怎么办
  const [stale, setStale] = useState<Record<string, true>>({})
  const activeDoc = active ? docs[active] : undefined
  useExternalChange(projectId, activeDoc && 'sheets' in activeDoc ? activeDoc : undefined, busy, (path) => {
    const d = docs[path]
    if (d && 'sheets' in d && pendingOf(edits[path], d.sheets).length) return setStale((m) => ({ ...m, [path]: true }))
    // 没有没保存的改动：直接载入新内容
    reloadDoc(path, false)
    toast.info(t('{name} 在外面被改过，已载入最新内容', { name: path.slice(path.lastIndexOf('/') + 1) }))
  })
  /** 重新载入：keep 时把页面上改过的格子按位置写回新内容上（只改格子、没插删行时才行） */
  const reloadDoc = (path: string, keep: boolean) => {
    const old = docs[path]
    const pending = old && 'sheets' in old ? pendingOf(edits[path], old.sheets) : []
    return tablesApi
      .open(projectId, path)
      .then((d) => {
        setDocs((m) => ({ ...m, [path]: d }))
        extDocs.current.delete(path)
        setStale(({ [path]: _, ...m }) => m)
        setEdits(({ [path]: _, ...m }) => {
          if (!keep || !pending.length) return m
          let e = noEdits()
          for (const p of pending) {
            const s = d.sheets.find((x) => x.name === p.name) ?? (d.sheets.length === 1 ? d.sheets[0] : undefined)
            if (s) e = setCellsIn(e, s, p.cells)
          }
          return { ...m, [path]: e }
        })
        setCheckSeq((n) => n + 1)
        return d
      })
      .catch((e) => {
        toastError(e)
        return undefined
      })
  }
  const saveDoc = async (doc: TableDoc, pending: SheetEdit[], force: boolean) => {
    busy.current = true
    try {
      const next = await tablesApi.save(projectId, { path: doc.path, mtime: doc.mtime, sheets: pending, force })
      setDocs((m) => ({ ...m, [doc.path]: next }))
      extDocs.current.delete(doc.path)
      setEdits(({ [doc.path]: _, ...m }) => m)
      setCheckSeq((n) => n + 1)
      setStale(({ [doc.path]: _, ...m }) => m)
      toast.success(t('已保存 {name}', { name: doc.path.slice(doc.path.lastIndexOf('/') + 1) }))
      return null
    } catch (e) {
      return (e as Error).message
    } finally {
      busy.current = false
    }
  }
  // 切换到某一版：整个文件换掉，页面上的改动作废
  const checkoutDoc = async (doc: TableDoc, rev: string) => {
    busy.current = true
    const next = await tablesApi.checkout(projectId, doc.path, rev).finally(() => (busy.current = false))
    setStale(({ [doc.path]: _, ...m }) => m)
    setDocs((m) => ({ ...m, [doc.path]: next }))
    extDocs.current.delete(doc.path)
    setEdits(({ [doc.path]: _, ...m }) => m)
    setCheckSeq((n) => n + 1)
    toast.success(t('已把 {name} 切换到所选版本', { name: doc.path.slice(doc.path.lastIndexOf('/') + 1) }))
  }
  // 引用跳转：读被引用的表，找到值相等的那一行，打开并跳过去
  const jumpRef = (ref: string, value: string) => {
    const p = parseRef(ref)
    if (!p || !schema) return
    loadDoc(p.file)
      .then((d) => {
        const at = d && findRefTarget(schema, ref, value, d.sheets)
        if (!at) return toast.error(t('{file} 里没有 {field} = {value} 的行', { file: p.file, field: p.field, value }))
        openHit({ path: p.file, sheet: at.sheet, row: at.row, col: at.col, text: value })
      })
      .catch(toastError)
  }
  // 正在执行的导表：第几个脚本、哪些表
  const [exporting, setExporting] = useState<{ index: number; paths: string[]; seq: number } | null>(null)
  const runExport = (index: number, paths: string[]) => setExporting((x) => ({ index, paths, seq: (x?.seq ?? 0) + 1 }))
  const saveSchema = useCallback(
    (s: TableSchema) => {
      setSchema(s)
      tablesApi
        .saveSchema(projectId, s)
        .then(() => setCheckSeq((n) => n + 1))
        .catch((e) => toast.error((e as Error).message))
    },
    [projectId],
  )

  const doc = active ? docs[active] : undefined
  const files = index?.files ?? []
  const fileSet = useMemo(() => new Set((index?.files ?? []).map((f) => f.path)), [index])
  const quick = marks.prune((p) => fileSet.has(p))
  return (
    <>
      <ListPane
        title={t('表格')}
        count={files.length}
        onNew={() => {}}
        hideNew
        compact
        resizeKey="tables-list"
        query={query}
        onQuery={setQuery}
        placeholder={
          mode === 'name' ? t('按文件名找') : mode === 'content' ? t('在所有表格的格子里找') : t('按文件名、字段名筛')
        }
        extra={
          <>
            <IconButton icon={RefreshCw} label={t('重新读取表格目录')} onClick={() => reload(true)} />
            <IconButton
              icon={GitCompareArrows}
              label={others.length ? t('跨项目对比') : t('跨项目对比：还要另一个设了表格目录的项目')}
              disabled={!others.length}
              onClick={() => setComparing(true)}
            />
            <IconButton icon={Settings2} label={t('表格设置')} onClick={onSettings} />
          </>
        }
        tabs={
          <div className="flex flex-col gap-2">
            <Segmented
              label={t('搜索方式')}
              value={mode}
              onChange={setMode}
              fill
              size="sm"
              options={[
                { id: 'name', label: t('文件名') },
                { id: 'content', label: t('内容') },
                { id: 'check', label: t('检查') },
              ]}
            />
            {projects.length > 1 && (
              <Select
                size="sm"
                aria-label={t('项目')}
                value={projectId}
                onChange={(e) => onProject(e.target.value)}
                options={projects}
              />
            )}
          </div>
        }
        footer={
          index?.missing.length || index?.truncated ? (
            <p className="text-caption leading-relaxed text-warning">
              {index.missing.length > 0 && t('找不到目录：{dirs}', { dirs: index.missing.join('、') })}
              {index.truncated && t('表格太多，只列出了前一部分')}
            </p>
          ) : undefined
        }
      >
        {indexError ? (
          <p className="px-3 py-4 text-footnote text-danger">{indexError}</p>
        ) : !index ? (
          <div className="flex justify-center p-6 text-subtle">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : mode === 'name' ? (
          <>
            {!query.trim() && <TableQuick {...quick} active={active} onOpen={open} onUnfav={marks.toggleFav} />}
            <TableTree
              files={files}
              query={query}
              active={active}
              dirty={dirtyPaths}
              onOpen={open}
              exports={exports}
              onExport={runExport}
              isFav={marks.isFav}
              onFav={marks.toggleFav}
              onReveal={(p) => void tablesApi.reveal(projectId, p).catch(toastError)}
            />
          </>
        ) : mode === 'check' ? (
          <TableCheckList projectId={projectId} query={query} seq={checkSeq} onOpen={openHit} />
        ) : (
          <TableHits
            result={search.result}
            query={query}
            loading={search.loading}
            error={search.error}
            onOpen={openHit}
          />
        )}
      </ListPane>
      <main className="flex min-h-[60vh] min-w-0 flex-1 flex-col md:h-full md:min-h-0">
        {tabs.length > 0 && (
          <TableTabs paths={tabs} active={active} dirty={dirtyPaths} onPick={setActive} onClose={(p) => close(p)} />
        )}
        {!doc ? (
          active ? (
            <div className="flex flex-1 items-center justify-center text-subtle">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyPanel size="md" className="max-w-sm">
                {t('从左边选一张表打开；可以同时开几张，在上面的页签里切换。')}
              </EmptyPanel>
            </div>
          )
        ) : 'error' in doc ? (
          <p className="p-6 text-body text-danger">{doc.error}</p>
        ) : !schema ? (
          <div className="flex flex-1 items-center justify-center text-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <TableView
            projectId={projectId}
            key={doc.path}
            doc={doc}
            schema={schema}
            onSchema={saveSchema}
            jump={jump}
            sheetIndex={sheetOf[doc.path] ?? 0}
            onSheet={(i) => setSheetOf((m) => ({ ...m, [doc.path]: i }))}
            edits={edits[doc.path]}
            onEdits={(f) => setEdits((m) => ({ ...m, [doc.path]: f(m[doc.path] ?? noEdits()) }))}
            onSave={(pending, force) => saveDoc(doc, pending, force)}
            onCheckout={(rev) => checkoutDoc(doc, rev)}
            exports={exports}
            onExport={(i) => runExport(i, [doc.path])}
            onRefJump={jumpRef}
            stale={!!stale[doc.path]}
            onReload={(keep) => reloadDoc(doc.path, keep)}
            onKeepMine={() => setStale(({ [doc.path]: _, ...m }) => m)}
            onFilesChanged={(paths) => {
              // 打开着的：没改动的直接重新载入，有改动的提示；别的只清掉缓存
              for (const p of paths) {
                extDocs.current.delete(p)
                const d = docs[p]
                if (!d || !('sheets' in d)) continue
                if (pendingOf(edits[p], d.sheets).length) setStale((m) => ({ ...m, [p]: true }))
                else reloadDoc(p, false)
              }
              setCheckSeq((n) => n + 1)
            }}
            onOpenHit={openHit}
            loadDoc={loadDoc}
            files={files.map((f) => f.path)}
          />
        )}
      </main>
      {comparing && (
        <TablesCompareDialog
          open
          onClose={() => setComparing(false)}
          left={{ id: projectId, name: projects.find((p) => p.value === projectId)?.label ?? '' }}
          projects={others}
        />
      )}
      {exporting && exports[exporting.index] && (
        <TableExportDialog
          key={exporting.seq}
          projectId={projectId}
          index={exporting.index}
          script={exports[exporting.index]}
          paths={exporting.paths}
          dirty={exporting.paths.filter((p) => dirtyPaths.has(p)).length}
          onClose={() => setExporting(null)}
        />
      )}
      <ConfirmDialog
        open={!!closing}
        title={t('关掉 {name}？', { name: closing.slice(closing.lastIndexOf('/') + 1) })}
        description={t('还有没保存的改动，关掉就丢了。')}
        confirmText={t('不保存，关掉')}
        onConfirm={() => {
          close(closing, true)
          setClosing('')
        }}
        onOpenChange={(o) => !o && setClosing('')}
      />
    </>
  )
}

/** 内容搜索：停手 300ms 再搜，旧的结果先留着（不闪） */
function useContentSearch(projectId: string, query: string) {
  const [result, setResult] = useState<TableSearch | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResult(null)
      setError('')
      return
    }
    let live = true
    setLoading(true)
    // 又输了字：取消上一次请求，服务端也就不再接着搜
    const abort = new AbortController()
    const timer = setTimeout(() => {
      tablesApi
        .search(projectId, q, abort.signal)
        .then((r) => live && (setResult(r), setError('')))
        .catch((e) => live && setError((e as Error).message))
        .finally(() => live && setLoading(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
      abort.abort()
    }
  }, [projectId, query])
  return { result, loading, error }
}
