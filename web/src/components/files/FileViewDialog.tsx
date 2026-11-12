import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Code2, Copy, GitCompareArrows, Loader2, FileText, Search, TableProperties } from 'lucide-react'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import type { FileContent, FileDiff } from '@shared/files'
import { editorUrl } from '@/lib/editor-url'
import { fmtClock } from '@/lib/tasks'
import { useNav } from '@/lib/data'
import { sizeText, useHighlightedLines, useHljs } from '@/lib/file-highlight'
import { findHits, hitsByLine, lineOf, lineStarts } from '@/lib/file-search'
import { isJsonPath } from '@/lib/json-tree'
import { findCells, isCsvPath, parseCsv } from '@/lib/sheet'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { Lightbox } from '@/components/ui/lightbox'
import { DialogScroll, ProjectDiffDialog } from '@/components/tasks/DiffDialog'
import { Markdown } from '@/components/tasks/Markdown'
import { DocOutline } from '@/components/ui/doc-outline'
import { FileModeBar, isMarkdownPath, useFileEditing } from './file-edit'
import { CodeLines } from './CodeLines'
import { FileSearchBar, useFileSearch } from './FileSearch'
import { useDomSearch } from './dom-search'
import { JsonTree } from './JsonTree'
import { SheetTable, SheetTabs } from './SheetTable'
import { firstShownSheet, parseLoc } from './sheet-look'
import { SheetHeaderBar } from './SheetHeaderBar'
import { useClaimedSheetView } from './use-sheet-claim'
import './file-view.css'

// 编辑器（CodeMirror）只在切到编辑时才加载：只看文件的人不用下载它
const CodeEditor = lazy(() => import('./CodeEditor'))

/** Markdown 超过这么多字就分块排版（屏幕外的段落先不排），短文档没必要 */
const MD_LAZY = 40_000

/** 读回来的文件：dir 是「在编辑器中打开」用的目录；editable 为 false 时只读（附件、项目外的文件） */
export type FileView = FileContent & { dir?: string; editable?: boolean }

/**
 * 文件从哪里读、往哪里写：对话里点开的文件走任务目录（FileDialog），文件浏览页走项目目录（ProjectFileDialog），
 * 弹窗本身（阅读 / 编辑、高亮、行号、查看改动、保存冲突）是同一个。
 */
export interface FileSource {
  read: (path: string) => Promise<FileView>
  /** 保存；mtime 是打开时读到的修改时间，盘上的对不上时后端回 409。不传这项就只读 */
  write?: (path: string, content: string, mtime?: string) => Promise<unknown>
  /** 和 git 比的改动；不传就没有「查看改动」 */
  diff?: (path: string) => Promise<FileDiff>
  /** 图片：给看图浮层的原图地址；空串表示不是图片，按文字读 */
  image: (path: string) => string
  /** 「在编辑器中打开」的目录；不传时用读回来的 dir */
  dir?: string
  /** 找不到、二进制时的说明 */
  missingText: string
  binaryText: string
  /** 标题栏额外的按钮（附件的「用默认程序打开」这类） */
  actions?: (file: FileView) => React.ReactNode
  /** 能不能在编辑器里打开（本机二进制附件没必要） */
  editorOk?: (file: FileView) => boolean
  /** 保存成功后通知外面（文件树刷新大小、改动标记） */
  onSaved?: () => void
  /** 文件所在的面板项目：表格文件交给插件认领（在表格页打开、用项目的表头设置）；聊天对话、附件没有 */
  projectId?: string
}

/** 文件里渲染 Markdown 时没有 @角色 */
const NO_TEAM = new Set<string>()

/**
 * 点开一个文件：显示内容（带语法高亮和行号），跳到指定的行；能切到编辑直接改完保存，
 * Markdown 阅读时按对话里的样式渲染、编辑时改源码；CSV / TSV 阅读时是表格，xlsx 由后端解析成各张表、只读；
 * JSON 可以切到树形。能看这个文件相对 git 改了什么、在编辑器里打开。图片用看图的浮层看原图。
 */
export function FileViewDialog({
  source,
  target,
  onOpenChange,
}: {
  source: FileSource
  target: { path: string; line?: number } | null
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = useState<FileView | null>(null)
  const [error, setError] = useState('')
  const [askClose, setAskClose] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffData, setDiffData] = useState<FileDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const hl = useHljs()
  const box = useRef<HTMLDivElement>(null)
  const path = target?.path ?? ''
  const raw = target ? source.image(target.path) : ''
  const isMd = isMarkdownPath(path)
  const isCsv = isCsvPath(path)
  const isJson = isJsonPath(path)
  /** xlsx 当前看的是第几张表；-1 是刚打开，停在第一张没隐藏的表 */
  const [pickedSheet, setSheetIndex] = useState(-1)
  const load = (p: string) =>
    source
      .read(p)
      .then(setFile)
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    if (!target) return
    setFile(null)
    setError('')
    setSheetIndex(-1)
    if (raw) return
    void load(target.path)
    // source 每次渲染都是新对象，换了文件（target）才重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [target, raw])

  const write = source.write
  // 截断的文件不提供编辑：存回去会把后面没读到的部分删掉；附件、项目外的文件只读
  const canEdit = !!write && !!file?.exists && !file.binary && !file.truncated && file.editable !== false
  const ed = useFileEditing({
    content: file?.exists && !file.binary ? file.content : undefined,
    write: async (text, force) => {
      await write!(file!.path, text, force ? undefined : file!.mtime)
      // 保存后重新读一遍：后端可能调整了换行，界面上显示的应该是盘上的真实内容（修改时间也更新，下次保存才不会误报冲突）
      setFile(await source.read(file!.path))
      source.onSaved?.()
    },
    reload: () => target && void load(target.path),
    resetKey: target,
    // Markdown 阅读是渲染后的文档，对不上行号：带行号打开（从引用跳过来）时直接进编辑看那一行
    // 表格也一样：行号指的是源码的行
    startEdit: (isMd || isCsv) && !!target?.line,
  })
  const editing = canEdit && ed.mode === 'edit'
  const isText = !!file?.exists && !file.binary
  /** xlsx 解析出来的各张表（是二进制文件，但有东西可看） */
  const sheets = file?.exists && file.sheets?.length ? file.sheets : undefined
  const sheetIndex = sheets ? Math.min(pickedSheet < 0 ? firstShownSheet(sheets) : pickedSheet, sheets.length - 1) : 0
  const sheet = sheets?.[sheetIndex]
  /** 有内容可看、可搜：文字文件和解析出表格的 xlsx */
  const viewable = isText || !!sheets
  // 去掉结尾的换行再分列，最后一行不会是个空行；高亮用同一份内容，行数才对得上。
  // 阅读时看的是草稿：改了 Markdown 切回阅读就能看渲染效果
  const shown = canEdit ? ed.text : (file?.content ?? '')
  const body = shown ? shown.replace(/\n$/, '') : ''
  const mdPreview = isMd && isText
  const treeShown = isJson && isText && ed.mode === 'tree'
  // 表格：CSV 阅读时现拆，xlsx 用后端解析好的那张表
  const csvShown = isCsv && isText && !editing
  const csvRows = useMemo(
    () => (csvShown ? parseCsv(body, /\.tsv$/i.test(path) ? '\t' : undefined) : null),
    [csvShown, body, path],
  )
  const tableRows = sheet ? sheet.rows : csvRows
  const sheetName = sheet?.name ?? ''
  const { go } = useNav()
  // 表格的表头、筛选和排序；表格插件认领的文件（项目表格目录里的）表头按项目的表格设置，标题栏多「在表格页打开」
  const {
    claim,
    view: sheetView,
    colHead,
  } = useClaimedSheetView({
    file: file?.exists && (sheets || (isCsv && isText)) ? file : null,
    projectId: source.projectId,
    root: source.dir || file?.dir || '',
    key: `${path}#${sheetName}`,
    sheet: sheetName,
    rows: tableRows,
  })
  // 只有阅读代码时才拆行、高亮：编辑时每敲一个字 body 都会变，在这里整份重新高亮，大文件打一个字就卡一下
  const codeShown = isText && !editing && !mdPreview && !treeShown && !csvShown
  const lines = useMemo(() => (codeShown && body ? body.split('\n') : []), [codeShown, body])
  // 整份高亮在后台线程算，算好之前先按纯文本显示；截断的文件、二进制都不用高亮：不是完整内容，或者根本不是代码
  const highlighted = useHighlightedLines(body, path, codeShown && !file?.truncated)

  // 弹窗自己的搜索：阅读代码和编辑在文字里找，Markdown 阅读和 JSON 树形在画出来的字里找，表格按格子找
  const search = useFileSearch()
  const textSearch = search.open && !!search.query && (codeShown || editing)
  const hits = useMemo(
    () => (textSearch ? findHits(editing ? ed.text : body, search.query, search.caseSensitive) : []),
    [textSearch, editing, ed.text, body, search.query, search.caseSensitive],
  )
  const starts = useMemo(() => (textSearch && codeShown ? lineStarts(body) : []), [textSearch, codeShown, body])
  const hitIndex = Math.min(search.index, Math.max(0, hits.length - 1))
  const marks = useMemo(
    () => (textSearch && codeShown ? hitsByLine(hits, starts, hitIndex) : undefined),
    [textSearch, codeShown, hits, starts, hitIndex],
  )
  const currentHit = useMemo(
    () => (marks && hits[hitIndex] ? { line: lineOf(starts, hits[hitIndex].from), seq: search.seq } : null),
    // 只在换了当前那一处、按了上一个 / 下一个时滚动，打字改了命中不跳
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [hitIndex, search.seq, !!marks],
  )
  const domShown = (mdPreview && !editing) || treeShown
  const domTotal = useDomSearch(
    box,
    search.query,
    search.caseSensitive,
    search.index,
    search.seq,
    search.open && domShown,
  )
  const viewFrom = sheetView?.from ?? 0
  const viewShown = sheetView?.shown
  const cellHits = useMemo(() => {
    if (!search.open || !tableRows) return []
    const all = findCells(tableRows, search.query, search.caseSensitive)
    // 筛掉的行不显示，命中也不算；表头一直显示
    return viewShown ? all.filter((h) => h.row < viewFrom || viewShown.has(h.row)) : all
  }, [search.open, tableRows, search.query, search.caseSensitive, viewFrom, viewShown])
  const total = tableRows ? cellHits.length : domShown ? domTotal : hits.length
  const size = typeof file?.size === 'number' ? sizeText(file.size) : ''
  const mtime = file?.mtime ? fmtClock(file.mtime) : ''
  const canDiff = !!source.diff && !!file?.exists && !file.binary && file.editable !== false
  const editorDir = source.dir || file?.dir || ''
  const textOpen = !!target && !raw

  // Ctrl/Cmd+F 打开弹窗自己的搜索（代码是虚拟渲染的，浏览器自带的查找搜不到屏幕外的行）；F3 / Shift+F3 上一个下一个
  useEffect(() => {
    if (!textOpen || !viewable) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.show(getSelection()?.toString())
      } else if (e.key === 'F3' && search.open) {
        e.preventDefault()
        if (e.shiftKey) search.prev(total)
        else search.next(total)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // 草稿不用在这里清：下次打开换了 target，编辑状态整个重置
  const close = () => {
    setDiffOpen(false)
    search.close()
    onOpenChange(false)
  }
  // 有没保存的修改时先问一句，别手滑关掉就丢了
  const change = (open: boolean) => {
    if (open) return
    if (ed.dirty) return setAskClose(true)
    close()
  }
  const openDiff = () => {
    if (!target || !source.diff) return
    setDiffOpen(true)
    setDiffData(null)
    setDiffError('')
    source
      .diff(file?.path || target.path)
      .then(setDiffData)
      .catch((e) => setDiffError((e as Error).message))
  }

  return (
    <>
      <Lightbox
        images={raw ? [{ src: raw, name: target!.path.split(/[\\/]/).pop()! }] : []}
        index={raw ? 0 : undefined}
        onClose={() => onOpenChange(false)}
      />
      <Modal
        open={textOpen}
        onOpenChange={change}
        title={null}
        bare
        closeOnOutside
        // 搜索框开着时 Esc 先关搜索框，再按一次才关弹窗
        onEscapeKeyDown={(e) => {
          if (!search.open) return
          e.preventDefault()
          search.close()
        }}
        className={cn(
          // 只有一句说明（找不到、二进制、出错）时弹窗按内容高度，不撑满
          editing || !file || body || sheets ? 'h-[min(760px,calc(100dvh-3.75rem))] max-w-[1000px]' : 'max-w-[560px]',
        )}
      >
        <ModalHeader
          icon={FileText}
          title={
            <>
              {file?.path || target?.path}
              {target?.line ? <span className="text-subtle">:{target.line}</span> : null}
            </>
          }
          titleClass="font-mono"
          titleAttr={target?.path}
          meta={ed.dirty ? <span className="text-warning">{t('未保存')}</span> : undefined}
          aside={
            <>
              {(size || mtime) && (
                <span className="hidden shrink-0 items-center gap-1.5 font-mono text-caption text-subtle sm:flex">
                  {size && <span title={t('文件大小')}>{size}</span>}
                  {size && mtime && <span aria-hidden>·</span>}
                  {mtime && <span title={t('最后修改')}>{mtime}</span>}
                </span>
              )}
              {isText && (
                <FileModeBar ed={ed} canEdit={canEdit} tree={isJson} readLabel={isCsv ? t('表格') : undefined} />
              )}
            </>
          }
          actions={
            <>
              {viewable && <ModalButton icon={Search} label={t('在文件中查找')} onClick={() => search.show()} />}
              {claim?.open && !editing && (
                <ModalButton
                  icon={TableProperties}
                  label={claim.open.label}
                  onClick={() => {
                    // 改了 CSV 还没存：先问要不要放弃，不直接跳走
                    if (ed.dirty) return setAskClose(true)
                    close()
                    go({ page: 'plugin', id: claim.plugin, sub: claim.open!.page, msg: claim.open!.path(sheetName) })
                  }}
                />
              )}
              <ModalButton
                icon={Copy}
                label={t('复制路径')}
                onClick={() => void copyText(file?.path || target?.path || '', { done: t('已复制'), fail: false })}
              />
              {canDiff && <ModalButton icon={GitCompareArrows} label={t('查看改动')} onClick={openDiff} />}
              {file && source.actions?.(file)}
              {file?.exists && editorDir && (source.editorOk?.(file) ?? true) && (
                <ModalButton
                  icon={Code2}
                  label={t('在编辑器中打开')}
                  onClick={() => window.open(editorUrl(editorDir, file.path, target?.line))}
                />
              )}
            </>
          }
        />
        {ed.saveError && (
          <p className="shrink-0 border-b bg-danger/10 px-4 py-2 text-body text-danger">{ed.saveError}</p>
        )}
        {viewable && <FileSearchBar search={search} total={total} onClose={search.close} />}
        {sheets && sheets.length > 1 && <SheetTabs sheets={sheets} index={sheetIndex} onChange={setSheetIndex} />}
        {sheetView && tableRows && (sheet || csvRows) && <SheetHeaderBar view={sheetView} rows={tableRows} />}
        {/* Markdown 阅读时右边是标题目录，编辑源码时不要 */}
        <DialogScroll box={box} aside={mdPreview && !editing && <DocOutline scrollEl={box} className="bottom-7" />}>
          {error ? (
            <p className="p-6 text-body text-danger">{error}</p>
          ) : !file ? (
            <div className="flex h-full items-center justify-center text-subtle">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !file.exists ? (
            <p className="p-6 text-body text-subtle">{source.missingText}</p>
          ) : sheet ? (
            <SheetTable
              rows={sheet.rows}
              look={sheet.look}
              // 表内链接（Sheet2!A1）：切到那张表
              onLocate={(loc) => {
                const at = parseLoc(loc)
                const i = at?.sheet ? sheets!.findIndex((x) => x.name === at.sheet) : -1
                if (i >= 0) setSheetIndex(i)
              }}
              scrollEl={box}
              hits={cellHits}
              current={search.index}
              seq={search.seq}
              header={sheetView?.header}
              order={sheetView?.order}
              filters={sheetView?.filters}
              sort={sheetView?.sort}
              onFilter={sheetView?.setFilter}
              onSort={sheetView?.setSort}
              colHead={colHead}
            />
          ) : file.binary ? (
            <p className="p-6 text-body text-subtle">{source.binaryText}</p>
          ) : editing ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-subtle">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              }
            >
              <CodeEditor
                ed={ed}
                line={target?.line}
                path={file.path}
                hl={hl}
                hits={hits}
                current={hitIndex}
                seq={search.seq}
              />
            </Suspense>
          ) : mdPreview ? (
            // 长文档分块排版（file-view.css）：屏幕外的段落先不排，打开不卡
            <div className={cn('mx-auto max-w-[860px] px-8 py-6', shown.length > MD_LAZY && 'file-md-lazy')}>
              <Markdown text={shown} teamNames={NO_TEAM} />
            </div>
          ) : csvRows ? (
            <SheetTable
              rows={csvRows}
              scrollEl={box}
              hits={cellHits}
              current={search.index}
              seq={search.seq}
              header={sheetView?.header}
              order={sheetView?.order}
              filters={sheetView?.filters}
              sort={sheetView?.sort}
              onFilter={sheetView?.setFilter}
              onSort={sheetView?.setSort}
              colHead={colHead}
            />
          ) : treeShown ? (
            <JsonTree
              text={shown}
              path={path}
              truncated={file.truncated}
              query={search.open ? search.query : ''}
              caseSensitive={search.caseSensitive}
            />
          ) : (
            <CodeLines
              lines={lines}
              highlighted={highlighted}
              target={target?.line}
              scrollEl={box}
              marks={marks}
              current={currentHit}
            />
          )}
        </DialogScroll>
        {sheet?.truncated && (
          <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">
            {t('表格太大，只显示了前面一部分。完整内容请用表格软件打开。')}
          </p>
        )}
        {file?.truncated && (
          <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">
            {t('文件太大，只显示了前面一部分。完整内容请在编辑器里查看。')}
          </p>
        )}
      </Modal>
      <ProjectDiffDialog
        path={diffOpen ? (file?.path ?? target?.path ?? null) : null}
        data={diffData}
        error={diffError}
        onOpenChange={(o) => !o && setDiffOpen(false)}
      />
      <ConfirmDialog
        open={askClose}
        onOpenChange={setAskClose}
        title={t('还有没保存的修改，确定放弃？')}
        description={t('「{path}」这次改的内容不会保存。', { path: target?.path ?? '' })}
        confirmText={t('放弃')}
        onConfirm={() => {
          setAskClose(false)
          close()
        }}
      />
      <ConfirmDialog
        open={ed.conflict}
        onOpenChange={ed.setConflict}
        title={t('文件在你打开之后被改过了')}
        description={t(
          '可能是 Agent 刚改过「{path}」。覆盖保存会丢掉那些改动；也可以先放弃修改，看看现在的内容再改。',
          { path: file?.path ?? '' },
        )}
        confirmText={t('覆盖保存')}
        onConfirm={async () => {
          ed.setConflict(false)
          await ed.save(true)
        }}
      />
    </>
  )
}
