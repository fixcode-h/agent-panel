import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableDoc, TableHit, TableSchema, TableSearch, TablesIndex } from '@shared/tables'
import { useNav } from '@/lib/data'
import { tablesApi } from '@/lib/tables-api'
import { rememberTablesProject, useTablesEntry, useTablesProjects } from '@/lib/tables-nav'
import { toast } from '@/lib/toast'
import { ListPane } from '@/components/layout/ListPane'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { TableTree } from '@/components/tables/TableTree'
import { TableHits } from '@/components/tables/TableHits'
import { TableTabs } from '@/components/tables/TableTabs'
import { TableView, type TableJump } from '@/components/tables/TableView'

type Mode = 'name' | 'content'

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
}: {
  projectId: string
  projects: { value: string; label: string }[]
  onProject: (id: string) => void
  onSettings: () => void
}) {
  const [index, setIndex] = useState<TablesIndex | null>(null)
  const [indexError, setIndexError] = useState('')
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [mode, setMode] = useState<Mode>('name')
  const [query, setQuery] = useState('')
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [docs, setDocs] = useState<Record<string, TableDoc | { error: string }>>({})
  const [sheetOf, setSheetOf] = useState<Record<string, number>>({})
  const [jump, setJump] = useState<TableJump>()
  // 搜索跳转时文件还没读到：记下要切的表，读到后再切
  const pendingSheet = useRef<{ path: string; sheet: string } | null>(null)

  const reload = useCallback(() => {
    setIndexError('')
    tablesApi
      .list(projectId)
      .then(setIndex)
      .catch((e) => setIndexError((e as Error).message))
  }, [projectId])
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
  const open = (path: string) => {
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    setActive(path)
    load(path)
  }
  const close = (path: string) => {
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
  const saveSchema = useCallback(
    (s: TableSchema) => {
      setSchema(s)
      tablesApi.saveSchema(projectId, s).catch((e) => toast.error((e as Error).message))
    },
    [projectId],
  )

  const doc = active ? docs[active] : undefined
  const files = index?.files ?? []
  return (
    <>
      <ListPane
        title={t('表格')}
        count={files.length}
        onNew={() => {}}
        hideNew
        compact
        query={query}
        onQuery={setQuery}
        placeholder={mode === 'name' ? t('按文件名找') : t('在所有表格的格子里找')}
        extra={
          <>
            <IconButton icon={RefreshCw} label={t('重新读取表格目录')} onClick={reload} />
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
          <TableTree files={files} query={query} active={active} onOpen={open} />
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
        {tabs.length > 0 && <TableTabs paths={tabs} active={active} onPick={setActive} onClose={close} />}
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
            key={doc.path}
            doc={doc}
            schema={schema}
            onSchema={saveSchema}
            jump={jump}
            sheetIndex={sheetOf[doc.path] ?? 0}
            onSheet={(i) => setSheetOf((m) => ({ ...m, [doc.path]: i }))}
          />
        )}
      </main>
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
    const timer = setTimeout(() => {
      tablesApi
        .search(projectId, q)
        .then((r) => live && (setResult(r), setError('')))
        .catch((e) => live && setError((e as Error).message))
        .finally(() => live && setLoading(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [projectId, query])
  return { result, loading, error }
}
