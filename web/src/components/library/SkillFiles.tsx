import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Loader2,
  PencilLine,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react'
import { LIBRARY_FILE_MAX_BYTES, type LibraryEntry, type LibraryEntryContent } from '@shared/library'
import { t } from '@shared/i18n'
import { fileIcon } from '@/lib/file-icon'
import { countFiles, entryName, toTree, visibleRows } from '@/lib/library-tree'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'

/** 文件树要用的读写操作：Skill 库和项目技能各给一份实现，组件本身不认识接口 */
export interface FilesApi {
  read: (path: string) => Promise<LibraryEntryContent>
  save: (path: string, content: string) => Promise<void>
  remove: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  /** 文件树变动后让外面重新读一次树 */
  reload: () => Promise<void>
}

/** 一次操作的弹窗形态：新建文件、新建目录、重命名 */
type Ask = { kind: 'file' | 'dir' | 'rename'; path: string } | null

const sizeText = (bytes: number) =>
  bytes >= 1024 ? t('{n} KB', { n: (bytes / 1024).toFixed(1) }) : t('{n} 字节', { n: bytes })

/**
 * 技能文件夹的文件结构：主文件置顶，其余文件按后端的树（扁平条目 + 完整 path）还原层级。
 * 点文件读内容，能编辑、保存、重命名、删除；二进制和超大文件只提示不能编辑。
 */
export function SkillFiles({
  entries,
  truncated,
  api,
  mainPath,
  mainDirty,
  mainEditorId,
  readOnly,
}: {
  entries: LibraryEntry[]
  truncated?: boolean
  api: FilesApi
  /** 主文件（SKILL.md）的路径，置顶显示 */
  mainPath: string
  /** 主文件有未保存的改动时在文件树里标出来 */
  mainDirty?: boolean
  /** 主文件编辑框的 id：点文件树里的 SKILL.md 滚到那里（主文件只在详情页顶部编辑） */
  mainEditorId: string
  /** 项目技能：附加文件只读（写在项目仓库里，由项目自己管） */
  readOnly?: boolean
}) {
  const rows = useMemo(() => toTree(entries), [entries])
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  // 默认不选中附加文件：主文件在上方详情页编辑，这里只管附加文件
  const [picked, setPicked] = useState('')
  const [file, setFile] = useState<LibraryEntryContent | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /** 打开文件的请求序号：连点时只认最后一次 */
  const opened = useRef(0)
  const [ask, setAsk] = useState<Ask>(null)
  const [askText, setAskText] = useState('')
  const [del, setDel] = useState<LibraryEntryContent | string | null>(null)

  // 附加文件大小按字符串字节数算：保存前先拦一道，不用等服务端报错
  const tooBig = useMemo(() => new TextEncoder().encode(text).length > LIBRARY_FILE_MAX_BYTES, [text])
  const dirty = file !== null && text !== file.content
  // 二进制、链接都不能在这里改内容：链接写进去会顺着链到别处，后端也会拒绝
  const editable = !!file && !file.binary && !file.link && file.exists !== false

  const open = (path: string) => {
    setPicked(path)
    // 打开前先清掉上一个文件：不然读取期间编辑框里还挂着上一个文件的内容，看着像已经切换了
    setFile(null)
    setText('')
    // 连着点两个文件时，先发的请求可能后回来：只认最后一次点的那个
    const seq = ++opened.current
    api
      .read(path)
      .then((c) => {
        if (seq !== opened.current) return
        setFile(c)
        setText(c.content)
      })
      .catch((e) => {
        if (seq !== opened.current) return
        // 读不出来就把选中退回去，不要留着「选中了但没内容」的状态
        setPicked('')
        setFile(null)
        toast.error((e as Error).message)
      })
  }

  // 换了技能（树整体变了）就清空选中，不带着上一个技能的文件
  useEffect(() => {
    opened.current++
    setPicked('')
    setFile(null)
    setText('')
    setFolded(new Set())
  }, [mainPath])

  const save = async () => {
    setBusy(true)
    try {
      await api.save(picked, text)
      setFile((f) => (f ? { ...f, content: text, size: new TextEncoder().encode(text).length } : f))
      toast.success(t('已保存'))
      await api.reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitAsk = async () => {
    if (!ask) return
    const value = askText.trim()
    if (!value) return
    setBusy(true)
    try {
      if (ask.kind === 'rename') {
        // 只改了名字本身：放在同一层，目录前缀跟着走
        const dir = ask.path.includes('/') ? ask.path.slice(0, ask.path.lastIndexOf('/') + 1) : ''
        await api.rename(ask.path, dir + value)
        if (picked === ask.path) setPicked(dir + value)
      } else {
        const dir = ask.path ? `${ask.path}/` : ''
        // 后端没有单独的建目录接口：写一个占位文件，目录就建出来了（父目录由后端递归创建）
        if (ask.kind === 'dir') await api.save(`${dir}${value}/.gitkeep`, '')
        else await api.save(dir + value, '')
      }
      setAsk(null)
      setAskText('')
      await api.reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const startAsk = (a: Ask, preset = '') => {
    setAsk(a)
    setAskText(preset)
  }

  const remove = async () => {
    if (del === null) return
    const path = typeof del === 'string' ? del : del.path
    setBusy(true)
    try {
      await api.remove(path)
      setDel(null)
      if (picked === path) {
        setPicked('')
        setFile(null)
        setText('')
      }
      toast.success(t('已删除'))
      await api.reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rowMenu = (path: string) => (
    <>
      <ContextMenuItem onSelect={() => startAsk({ kind: 'file', path })}>
        <FilePlus2 className="h-4 w-4" />
        {t('在这里新建文件')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => startAsk({ kind: 'dir', path })}>
        <FolderPlus className="h-4 w-4" />
        {t('在这里新建目录')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => startAsk({ kind: 'rename', path }, entryName(path))}>
        <PencilLine className="h-4 w-4" />
        {t('重命名')}
      </ContextMenuItem>
      <ContextMenuItem danger onSelect={() => setDel(path)}>
        <Trash2 className="h-4 w-4" />
        {t('删除')}
      </ContextMenuItem>
    </>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[0.8125rem] font-medium">{t('文件结构')}</h3>
        {rows.length > 0 && (
          <span className="text-[0.75rem] text-subtle">{t('另有 {n} 个文件', { n: countFiles(rows) })}</span>
        )}
        {!readOnly && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={t('新建文件')}
              title={t('新建文件')}
              onClick={() => startAsk({ kind: 'file', path: '' })}
            >
              <FilePlus2 className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={t('新建目录')}
              title={t('新建目录')}
              onClick={() => startAsk({ kind: 'dir', path: '' })}
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row">
        {/* 文件树 */}
        <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-1.5 lg:w-[260px] lg:shrink-0">
          {/* 主文件在上方详情页编辑：这里只提示它在哪，点一下滚上去 */}
          <button
            type="button"
            onClick={() =>
              document.getElementById(mainEditorId)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
            title={mainPath}
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-muted hover:bg-sel/60"
          >
            <span className="h-3.5 w-3.5 shrink-0" />
            <FileTextMain />
            <span className="truncate font-mono">SKILL.md</span>
            {mainDirty && <span className="ml-auto text-[0.6875rem] text-warning">{t('未保存')}</span>}
          </button>
          {visibleRows(rows, folded).map((r) => {
            const Icon = r.type === 'dir' ? (folded.has(r.path) ? ChevronRight : ChevronDown) : fileIcon(r.path)
            const row = (
              <button
                type="button"
                onClick={() => (r.type === 'dir' ? setFolded((s) => toggle(s, r.path)) : open(r.path))}
                aria-current={picked === r.path || undefined}
                title={r.path}
                style={{ paddingLeft: 8 + r.depth * 14 }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[0.8125rem]',
                  picked === r.path ? 'bg-sel text-fg' : 'hover:bg-sel/60',
                )}
              >
                {r.type === 'dir' ? (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                ) : (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
                )}
                <span className="truncate font-mono">{entryName(r.path)}</span>
              </button>
            )
            return readOnly ? (
              <span key={r.path}>{row}</span>
            ) : (
              <ContextMenu key={r.path}>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                <ContextMenuContent>
                  {rowMenu(r.type === 'dir' ? r.path : r.path.slice(0, r.path.lastIndexOf('/')))}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
          {truncated && <p className="px-2 py-2 text-[0.75rem] text-subtle">{t('文件太多，只显示了前面一部分。')}</p>}
        </div>

        {/* 附加文件的内容：没选中时给引导，选中了才显示编辑框 */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {file === null ? (
            <EmptyPanel>
              {!countFiles(rows)
                ? t('这个技能只有 SKILL.md，还没有附加文件。')
                : t('在左边的文件树里点一个文件，就能看内容和改它。')}
            </EmptyPanel>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-[0.75rem] text-subtle">{file.path}</span>
                <span className="text-[0.75rem] text-subtle">{sizeText(file.size)}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {dirty && (
                    <Button size="sm" variant="secondary" onClick={() => setText(file.content)}>
                      <Undo2 className="h-3.5 w-3.5" />
                      {t('重置')}
                    </Button>
                  )}
                  {!readOnly && editable && (
                    <Button size="sm" onClick={save} disabled={!dirty || busy || tooBig}>
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      <Save className="h-3.5 w-3.5" />
                      {t('保存')}
                    </Button>
                  )}
                  {!readOnly && (
                    <Button
                      size="icon-sm"
                      variant="danger-outline"
                      aria-label={t('删除这个文件')}
                      title={t('删除这个文件')}
                      onClick={() => setDel(file)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              {!editable ? (
                <EmptyPanel>
                  {file.link
                    ? t('这是个链接，不能在这里改内容。')
                    : t('二进制文件（{size}），不能编辑。', { size: sizeText(file.size) })}
                </EmptyPanel>
              ) : (
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  readOnly={readOnly}
                  spellCheck={false}
                  className="h-[min(40vh,360px)] resize-none font-mono text-[0.78125rem] leading-relaxed"
                  aria-label={t('文件内容')}
                />
              )}
              {tooBig && <p className="text-[0.75rem] text-warning">{t('文件超过 1 MB，保存不了，请精简后再试。')}</p>}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={ask?.kind === 'rename' ? t('重命名') : ask?.kind === 'dir' ? t('新建目录') : t('新建文件')}
        description={
          <span className="flex flex-col gap-2">
            <span>{ask?.path ? t('在 {path} 里新建。', { path: ask.path }) : t('放在技能文件夹的根目录下。')}</span>
            <Input
              autoFocus
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitAsk()}
              placeholder={ask?.kind === 'dir' ? 'references' : 'notes.md'}
              className="font-mono"
              aria-label={ask?.kind === 'dir' ? t('目录名') : t('文件名')}
            />
          </span>
        }
        onConfirm={submitAsk}
        confirmText={t('确定')}
      />

      <ConfirmDialog
        open={del !== null}
        onOpenChange={(o) => !o && setDel(null)}
        title={t('删除「{name}」？', {
          name: del === null ? '' : typeof del === 'string' ? entryName(del) : entryName(del.path),
        })}
        description={t('会从磁盘上删掉，不能撤销。')}
        onConfirm={remove}
      />
    </div>
  )
}

const toggle = (s: ReadonlySet<string>, path: string) => {
  const next = new Set(s)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** 主文件用固定的文档图标，和附加文件区分开 */
function FileTextMain() {
  const Icon = fileIcon('SKILL.md')
  return <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
}
