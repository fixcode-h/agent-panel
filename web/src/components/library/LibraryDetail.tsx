import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Loader2, Save, Sparkles, Terminal, Trash2, Undo2 } from 'lucide-react'
import type { LibraryCli, LibraryEntry, LibraryEntryContent, LibraryFile, LibraryItem } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ToggleChip } from '@/components/ui/toggle-chip'
import { MenuItem } from '@/components/ui/menu'
import { DetailHeader } from '@/components/layout/Detail'
import { cliColor } from '@/lib/cli-style'
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
  // 要删的是哪个 Agent 里的那一份（关掉「装在」的开关、或者「⋯」里删当前这一份）
  const [del, setDel] = useState<string | null>(null)
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
  // AI 优化要改的是 md 文件：toml 格式的命令不用 AI 改，免得格式被换掉
  const canAi = kind === 'skill' || clis.find((c) => c.id === cli)?.commandFormat === 'md'

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

  const copy = async (overwrite = false, ids: string[]) => {
    setBusy(true)
    try {
      const r = await api.copyLibraryItem({ cli, kind, name, to: ids, overwrite })
      if (r.done.length) toast.success(t('已复制到 {cli}', { cli: r.done.map(label).join(t('、')) }))
      if (r.skipped.length)
        toast.warning(t('{cli} 里已经有同名的，没有覆盖', { cli: r.skipped.map(label).join(t('、')) }), {
          action: { label: t('覆盖'), onClick: () => void copy(true, r.skipped) },
        })
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
    // 只刷新文件树：附加文件保存、改名、删除后重读，编辑器里主文件没保存的改动不能被冲掉
    // （主文件和附加文件共用一个编辑区后，先写主文件、再去改附加文件是常见操作）
    reload: () => load(true),
  }

  // 能放 Skill 的 Agent 都列出来：开着的是装了的，开关就是装 / 卸（复制过去 / 删掉那一份）
  const slots = clis.filter((c) => (kind === 'skill' ? c.skillDir : c.commandDir))
  const toggle = (id: string, on: boolean) => {
    if (!on) return setDel(id)
    // 复制的是磁盘上的内容：编辑器里没保存的改动不会带过去，先说清楚
    if (dirty) return toast.warning(t('先保存修改再装到别的 Agent'))
    void copy(false, [id])
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <DetailHeader
        compact
        quietSave
        leading={
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            {kind === 'skill' ? <Sparkles className="h-5 w-5" /> : <Terminal className="h-5 w-5" />}
          </span>
        }
        title={(kind === 'command' ? '/' : '') + name}
        meta={<Badge className="text-caption">{kind === 'skill' ? 'Skill' : t('命令')}</Badge>}
        subtitle={here.find((i) => i.cli === cli)?.description || here[0]?.description || t('没有说明')}
        save={{ status: 'idle', error: '' }}
        actions={
          canAi && (
            <Button size="sm" variant="secondary" onClick={() => setAi(true)} disabled={busy || content === null}>
              <Sparkles className="h-4 w-4 text-accent-text" />
              {t('AI 优化')}
            </Button>
          )
        }
        more={
          <MenuItem danger onSelect={() => setDel(cli)} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            {t('删除 {cli} 里的这一份', { cli: label(cli) })}
          </MenuItem>
        }
      />

      <div className="flex w-full max-w-[1100px] flex-col gap-4 px-4 pt-5 pb-12 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-footnote text-subtle">{t('装在')}</span>
          {slots.map((c) => (
            <ToggleChip
              key={c.id}
              label={c.name}
              dot={cliColor(c.id)}
              checked={here.some((i) => i.cli === c.id)}
              active={c.id === cli}
              disabled={busy}
              title={
                here.some((i) => i.cli === c.id)
                  ? t('关掉会删除 {cli} 里的这一份', { cli: c.name })
                  : t('打开会复制一份到 {cli}', { cli: c.name })
              }
              onCheckedChange={(v) => toggle(c.id, v)}
              onPick={() => {
                setCli(c.id)
                onPickCli(c.id)
              }}
            />
          ))}
          <span className="ml-auto min-w-0 truncate font-mono text-caption text-subtle" title={path}>
            {path}
          </span>
        </div>

        {error ? (
          <p className="text-body text-warning">{t('读取失败：{error}', { error })}</p>
        ) : content === null ? (
          <p className="text-body text-subtle">{t('读取中…')}</p>
        ) : kind === 'skill' ? (
          // 主文件和附加文件在同一个编辑区：左边文件树（SKILL.md 置顶、默认选中），右边一个编辑器
          <SkillFiles
            entries={tree}
            truncated={truncated}
            api={filesApi}
            mainPath="SKILL.md"
            mainDirty={dirty}
            mainEditorId={MAIN_EDITOR_ID}
            main={{
              content,
              onChange: setContent,
              dirty,
              busy,
              onSave: () => void save(),
              onReset: () => setContent(saved),
            }}
          />
        ) : (
          <section className="flex flex-col gap-2">
            <div className="flex min-h-8 flex-wrap items-center gap-2">
              <h3 className="text-body font-medium">{t('命令文件')}</h3>
              {dirty && <span className="text-footnote text-warning">{t('未保存')}</span>}
              {dirty && (
                <div className="ml-auto flex items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setContent(saved)}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('重置')}
                  </Button>
                  <Button size="sm" onClick={save} disabled={busy}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {t('保存')}
                  </Button>
                </div>
              )}
            </div>
            <Textarea
              id={MAIN_EDITOR_ID}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              className="h-[min(62vh,640px)] resize-none font-mono text-footnote leading-relaxed"
              aria-label={t('内容')}
            />
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
        open={del !== null}
        onOpenChange={(o) => !o && setDel(null)}
        title={t('删除 {cli} 里的「{name}」？', { cli: label(del ?? cli), name })}
        description={
          here.length > 1
            ? t('只删 {cli} 里的这一份，文件会从磁盘上删掉，不能撤销。', { cli: label(del ?? cli) })
            : t('这是最后一份，删掉后所有 Agent 都用不了它，文件会从磁盘上删掉，不能撤销。')
        }
        onConfirm={async () => {
          const target = del ?? cli
          try {
            await api.deleteLibraryFile(target, kind, name)
            setDel(null)
            // 删的不是正在看的那一份：留在原地，刷新一下装在哪些 Agent
            if (target !== cli) return onChanged()
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
