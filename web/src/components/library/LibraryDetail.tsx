import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Copy, Loader2, Save, Sparkles, Terminal, Trash2, Undo2 } from 'lucide-react'
import type { LibraryCli, LibraryEntry, LibraryEntryContent, LibraryFile, LibraryItem } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/input'
import { SkillFiles, type FilesApi } from '@/components/library/SkillFiles'
import { AssistDialog } from '@/components/assist/AssistDialog'

/** 主文件编辑框的 id：文件树里的 SKILL.md 点一下滚到这里 */
const MAIN_EDITOR_ID = 'library-main-editor'

/**
 * 文件树的数据来源收在这里：后端给了 tree 就用它（已排好序），
 * 只有旧的扁平 files 时按文件造条目，老版本后端也能看到结构、不会一片空白。
 */
function entriesOf(f: LibraryFile): LibraryEntry[] {
  if (f.tree?.entries.length) return f.tree.entries
  return (f.files ?? []).map((path) => ({ path, type: 'file' as const }))
}

/**
 * 技能 / 命令的详情页：头部（装在哪几个 Agent、路径、操作）+ 正文编辑 + 文件结构（只有 Skill 有）。
 * 用户 2026-10-27 要求把原来的弹窗改成右详情页，能像 Superpowers 那样管理一个技能下的多个文件。
 */
export function LibraryDetail({
  item,
  clis,
  same,
  revision,
  onChanged,
  onDeleted,
  onPickCli,
}: {
  item: LibraryItem
  clis: LibraryCli[]
  /** 别的 Agent 里同名的项：多装时头部可以切换看哪一份 */
  same: LibraryItem[]
  /** 外面换了一次数据（保存、复制后）就重读一遍 */
  revision: number
  onChanged: () => void
  onDeleted: () => void
  /** 切到别的 Agent 里那一份：路由由页面统一写 */
  onPickCli: (cli: string) => void
}) {
  const { kind, name } = item
  const [cli, setCli] = useState(item.cli)
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [tree, setTree] = useState<LibraryEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [to, setTo] = useState<string[]>([])
  const [ai, setAi] = useState(false)

  // 编辑器当前的内容：判断「有没有未保存的改动」要用最新值，不能靠闭包里的旧值
  const editor = useRef({ content: '', saved: '' })
  /**
   * 读一次主文件和文件树。
   * onlyTree：只刷新文件树、不动编辑器（外面刷新时用）；
   * 换技能 / 换 Agent 时传 false，必须把新内容写进编辑器。
   */
  const load = (onlyTree = false) =>
    api
      .libraryFile(cli, kind, name)
      .then((f: LibraryFile) => {
        // 有未保存的改动时只刷新文件树，不覆盖编辑器：刷新是保存 / 复制 / 加文件带出来的，
        // 用户在编辑器里没保存的内容不能因此丢掉
        const dirty = editor.current.content !== editor.current.saved
        if (!onlyTree || !dirty) {
          setContent(f.content)
          setSaved(f.content)
          editor.current = { content: f.content, saved: f.content }
        }
        setTree(entriesOf(f))
        setTruncated(!!f.tree?.truncated)
        setError('')
      })
      .catch((e) => setError((e as Error).message))

  useEffect(() => {
    setContent(null)
    setSaved('')
    setTree([])
    setTo([])
    editor.current = { content: '', saved: '' }
    void load()
    // load 每次渲染都是新的函数，只在换项、换 Agent 或外面刷新时重读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, kind, name])

  // 外面刷新（保存 / 复制 / 改了附加文件）时重读：只刷文件树，编辑器和未保存的改动都不动
  useEffect(() => {
    if (!revision) return
    void load(true)
    // 只跟着 revision 走；load 每次渲染都是新的函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  // 每次渲染都记下最新的编辑器内容，供上面的「有没有未保存改动」判断。
  // 不能放进 effect：effect 是按声明顺序跑完的，切技能后它会用上一项的旧值把 ref 盖回去，
  // 于是新技能的读取被当成「有未保存改动」而拒绐写入，编辑器一直停在读取中
  editor.current = { content: content ?? '', saved }

  const here = same.filter((i) => i.name === name)
  const path = here.find((i) => i.cli === cli)?.path ?? item.path
  const label = (id: string) => clis.find((c) => c.id === id)?.name ?? id
  const dirty = content !== null && content !== saved
  // AI 优化要改的是 md 文件：toml 格式的命令（Gemini CLI）不用 AI 改，免得格式被换掉
  const canAi = kind === 'skill' || clis.find((c) => c.id === cli)?.commandFormat === 'md'
  const targets = clis.filter((c) => c.id !== cli && (kind === 'skill' ? c.skillDir : c.commandDir))

  const save = async () => {
    setBusy(true)
    try {
      await api.saveLibraryFile({ cli, kind, name, content: content ?? '' })
      setSaved(content ?? '')
      toast.success(t('已保存'))
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (overwrite = false, ids = to) => {
    setBusy(true)
    try {
      const r = await api.copyLibraryItem({ cli, kind, name, to: ids, overwrite })
      if (r.done.length) toast.success(t('已复制到 {cli}', { cli: r.done.map(label).join(t('、')) }))
      if (r.skipped.length)
        toast.warning(t('{cli} 里已经有同名的，没有覆盖', { cli: r.skipped.map(label).join(t('、')) }), {
          action: { label: t('覆盖'), onClick: () => void copy(true, r.skipped) },
        })
      setTo([])
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 附加文件的读写都走这三个接口；后端没落地时报错直接显示给用户
  const filesApi: FilesApi = {
    read: (p) => api.libraryEntry({ cli, kind, name, path: p }) as Promise<LibraryEntryContent>,
    save: async (p, text) => {
      await api.saveLibraryEntry({ cli, kind, name, path: p, content: text })
    },
    remove: async (p) => {
      await api.deleteLibraryEntry({ cli, kind, name, path: p })
    },
    rename: async (from, to_) => {
      await api.renameLibraryEntry({ cli, kind, name, from, to: to_ })
    },
    reload: load,
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <header className="flex flex-wrap items-start gap-3 border-b bg-bg px-4 py-5 md:px-8">
        {kind === 'skill' ? (
          <Sparkles className="mt-1 h-5 w-5 shrink-0 text-accent" />
        ) : (
          <Terminal className="mt-1 h-5 w-5 shrink-0 text-accent" />
        )}
        <div className="min-w-0 flex-[1_1_260px]">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-mono text-lg font-semibold">
              {kind === 'command' ? '/' : ''}
              {name}
            </h2>
            <span className="rounded-full border bg-card px-2 py-px text-[0.71875rem] text-muted">
              {kind === 'skill' ? 'Skill' : t('命令')}
            </span>
          </div>
          <p className="mt-1 truncate text-[0.8125rem] text-muted">{here[0]?.description || t('没有说明')}</p>
          <p className="mt-0.5 truncate font-mono text-[0.71875rem] text-subtle">{path}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canAi && (
            <Button variant="secondary" onClick={() => setAi(true)} disabled={busy || content === null}>
              <Sparkles className="h-4 w-4 text-accent" />
              {t('AI 优化')}
            </Button>
          )}
          <Button variant="danger-outline" onClick={() => setDel(true)} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            {t('删除')}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-4 pt-6 pb-12 md:px-8">
        {here.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.75rem] text-subtle">{t('装在')}</span>
            {here.map((i) => (
              <button
                key={i.cli}
                type="button"
                onClick={() => {
                  setCli(i.cli)
                  onPickCli(i.cli)
                }}
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-0.5 text-[0.75rem]',
                  i.cli === cli ? 'border-accent bg-accent-soft text-accent' : 'text-muted hover:bg-sel',
                )}
              >
                {label(i.cli)}
              </button>
            ))}
          </div>
        )}

        {error ? (
          <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
        ) : content === null ? (
          <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
        ) : (
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[0.8125rem] font-medium">{kind === 'skill' ? 'SKILL.md' : t('命令文件')}</h3>
              {dirty && <span className="text-[0.75rem] text-warning">{t('未保存')}</span>}
              <div className="ml-auto flex items-center gap-1.5">
                {dirty && (
                  <Button size="sm" variant="secondary" onClick={() => setContent(saved)}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('重置')}
                  </Button>
                )}
                <Button size="sm" onClick={save} disabled={!dirty || busy}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {t('保存')}
                </Button>
              </div>
            </div>
            <Textarea
              id={MAIN_EDITOR_ID}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              className="h-[min(46vh,420px)] resize-none font-mono text-[0.78125rem] leading-relaxed"
              aria-label={t('内容')}
            />
          </section>
        )}

        {/* 命令没有附加文件（只有一个命令文件），文件树只给 Skill */}
        {kind === 'skill' && content !== null && !error && (
          <SkillFiles
            entries={tree}
            truncated={truncated}
            api={filesApi}
            mainPath="SKILL.md"
            mainDirty={dirty}
            mainEditorId={MAIN_EDITOR_ID}
          />
        )}

        {!!targets.length && (
          <section className="flex flex-col gap-2 border-t pt-4">
            <span className="text-[0.8125rem] font-medium">{t('复制给别的 Agent')}</span>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {targets.map((c) => (
                <Checkbox
                  key={c.id}
                  checked={to.includes(c.id)}
                  onChange={(v) => setTo((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                  label={c.name}
                />
              ))}
              <Button size="sm" variant="secondary" disabled={!to.length || busy || dirty} onClick={() => void copy()}>
                <Copy className="h-3.5 w-3.5" />
                {t('复制')}
              </Button>
            </div>
            {dirty && <p className="text-[0.75rem] text-subtle">{t('先保存修改再复制')}</p>}
          </section>
        )}
      </div>

      {canAi && (
        <AssistDialog
          open={ai}
          onOpenChange={setAi}
          kind={kind}
          title={kind === 'command' ? `/${name}` : name}
          subject={{ cli, name, content: content ?? '' }}
          onApply={async (p) => {
            if (p.kind !== 'skill' && p.kind !== 'command') return
            await api.saveLibraryFile({ cli, kind, name, content: p.content })
            // AI 已经把新内容写进文件：这里必须把它读进编辑器（load() 而不是 load(true)），
            // 否则编辑器里还停着应用前的旧内容，看起来像没生效
            editor.current = { content: '', saved: '' }
            await load()
            toast.success(t('已更新「{name}」', { name }))
            onChanged()
          }}
        />
      )}

      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={t('删除「{name}」？', { name })}
        description={t('只删 {cli} 里的这一份，文件会从磁盘上删掉，不能撤销。', { cli: label(cli) })}
        onConfirm={async () => {
          try {
            await api.deleteLibraryFile(cli, kind, name)
            setDel(false)
            // 别的 Agent 里还有同名的：换个 Agent 继续看这一项，否则回空态
            const next = here.find((i) => i.cli !== cli)
            if (next) {
              setCli(next.cli)
              onPickCli(next.cli)
              onChanged()
            } else {
              onChanged()
              onDeleted()
            }
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </main>
  )
}
