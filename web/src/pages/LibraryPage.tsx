import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Loader2, Plus, Search, Sparkles, Terminal, Trash2 } from 'lucide-react'
import type { LibraryCli, LibraryItem } from '@shared/library'
import { libraryName } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { CliTag, PageFrame } from '@/components/library/parts'
import { AssistDialog } from '@/components/assist/AssistDialog'

type Kind = 'skill' | 'command'

/** 新建时的模板：命令按 CLI 的格式（md / toml）写 */
function template(kind: Kind, name: string, format: 'md' | 'toml') {
  if (kind === 'skill')
    return `---\nname: ${name}\ndescription: ${t('一句话说明什么时候该用它')}\n---\n\n${t('在这里写步骤和注意事项。')}\n`
  return format === 'toml'
    ? `description = ${JSON.stringify(t('一句话说明它做什么'))}\nprompt = """\n${t('在这里写要做的事，{{args}} 是输入的参数。')}\n"""\n`
    : `---\ndescription: ${t('一句话说明它做什么')}\n---\n${t('在这里写要做的事，$ARGUMENTS 是输入的参数。')}\n`
}

export function LibraryPage() {
  const [kind, setKind] = useState<Kind>('skill')
  const [data, setData] = useState<{ clis: LibraryCli[]; items: LibraryItem[] } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [edit, setEdit] = useState<LibraryItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [ai, setAi] = useState(false)

  const load = () =>
    api
      .library(kind)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    setData(null)
    void load()
    // load 每次渲染都是新的函数，只在种类变化时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  // 同名的并成一行，右边列出装在哪些 CLI 里
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const m = new Map<string, LibraryItem[]>()
    for (const i of data?.items ?? [])
      if (!q || `${i.name} ${i.description}`.toLowerCase().includes(q)) m.set(i.name, [...(m.get(i.name) ?? []), i])
    return [...m]
  }, [data, query])
  const cliName = (id: string) => data?.clis.find((c) => c.id === id)?.name ?? id

  return (
    <PageFrame
      title={t('Skills 与命令')}
      intro={t(
        '各个 CLI 用户目录下的 Skill 和自定义命令都在这里：新建、修改、删除，也能一键复制给别的 CLI（命令会自动换成对方的格式）。项目里的 Skill 在项目设置里管。',
      )}
      actions={
        <>
          {kind === 'skill' && (
            <Button
              variant="secondary"
              onClick={() => setAi(true)}
              disabled={!data}
              title={t('描述需求，让本机 CLI 写 Skill')}
            >
              <Sparkles className="h-4 w-4 text-accent" />
              {t('AI 创建')}
            </Button>
          )}
          <Button onClick={() => setCreating(true)} disabled={!data}>
            <Plus className="h-4 w-4" />
            {t('新建')}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t('种类')}
          value={kind}
          onChange={setKind}
          options={[
            { id: 'skill', label: 'Skill' },
            { id: 'command', label: t('命令') },
          ]}
        />
        <label className="relative block min-w-[200px] flex-1">
          <span className="sr-only">{t('搜索')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜索名字和说明')}
            className="h-[38px] pl-9"
          />
        </label>
      </div>

      {error ? (
        <p className="text-[13px] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !data ? (
        <p className="text-[13px] text-subtle">{t('读取中…')}</p>
      ) : !rows.length ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[13px] text-subtle">
          {query
            ? t('没有符合的{kind}。', { kind: kind === 'skill' ? 'Skill' : t('命令') })
            : t('还没有，点右上角「新建」。')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {rows.map(([name, list]) => (
            <li key={name}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                {kind === 'skill' ? (
                  <Sparkles className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <Terminal className="h-4 w-4 shrink-0 text-accent" />
                )}
                <button
                  type="button"
                  onClick={() => setEdit(list[0])}
                  className="min-w-0 flex-[1_1_260px] cursor-pointer text-left"
                >
                  <p className="truncate font-mono text-[13.5px]">{kind === 'command' ? `/${name}` : name}</p>
                  {list[0].description && (
                    <p className="line-clamp-2 text-[12.5px] text-muted">{list[0].description}</p>
                  )}
                </button>
                <span className="flex flex-wrap gap-1.5">
                  {list.map((i) => (
                    <CliTag key={i.cli} id={i.cli} name={cliName(i.cli)} onClick={() => setEdit(i)} />
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && creating && (
        <CreateDialog
          kind={kind}
          clis={data.clis}
          taken={data.items}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void load()
          }}
        />
      )}
      {data && (
        <AssistDialog
          open={ai}
          onOpenChange={setAi}
          kind="skill"
          onApply={async (p) => {
            if (p.kind !== 'skill') return
            // 先放进第一个有 Skill 目录的 CLI，要给别的 CLI 用，打开它再复制
            const cli = data.clis.find((c) => c.skillDir)
            if (!cli) throw new Error(t('没有可以放 Skill 的 CLI'))
            await api.saveLibraryFile({ cli: cli.id, kind: 'skill', name: p.name, content: p.content, create: true })
            toast.success(
              t('已创建「{name}」，放在 {cli}；要给别的 CLI 用，打开它再复制', { name: p.name, cli: cli.name }),
            )
            void load()
          }}
        />
      )}
      {data && edit && (
        <EditDialog
          item={edit}
          clis={data.clis}
          same={data.items.filter((i) => i.name === edit.name)}
          onClose={() => setEdit(null)}
          onChanged={() => void load()}
        />
      )}
    </PageFrame>
  )
}

function CreateDialog({
  kind,
  clis,
  taken,
  onClose,
  onDone,
}: {
  kind: Kind
  clis: LibraryCli[]
  taken: LibraryItem[]
  onClose: () => void
  onDone: () => void
}) {
  const ok = clis.filter((c) => (kind === 'skill' ? c.skillDir : c.commandDir))
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>(ok.slice(0, 1).map((c) => c.id))
  const [busy, setBusy] = useState(false)
  const valid = libraryName(kind, name)
  const dup = taken.filter((i) => i.name === name && picked.includes(i.cli))
  const create = async () => {
    setBusy(true)
    try {
      for (const id of picked)
        await api.saveLibraryFile({
          cli: id,
          kind,
          name,
          create: true,
          content: template(kind, name, ok.find((c) => c.id === id)!.commandFormat),
        })
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind === 'skill' ? t('新建 Skill') : t('新建命令')}
      footer={
        <>
          <span className="flex-1 text-[12px] text-warning">
            {dup.length ? t('{cli} 里已经有同名的了', { cli: dup.map((i) => i.cli).join('、') }) : ''}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={create} disabled={!valid || !picked.length || !!dup.length || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('创建')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{t('名字')}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder={kind === 'skill' ? 'commit-message' : 'review'}
          className="font-mono"
        />
        <span className="text-[12px] text-subtle">
          {name && !valid ? t('只能用字母、数字、. _ -，以字母或数字开头') : t('用来调用它的名字，创建后不能改')}
        </span>
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">{t('放进哪些 CLI')}</span>
        {ok.map((c) => (
          <Checkbox
            key={c.id}
            checked={picked.includes(c.id)}
            onChange={(v) => setPicked((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
            label={c.name}
            hint={kind === 'skill' ? c.skillDir : c.commandDir}
          />
        ))}
      </div>
    </Modal>
  )
}

function EditDialog({
  item,
  clis,
  same,
  onClose,
  onChanged,
}: {
  item: LibraryItem
  clis: LibraryCli[]
  /** 别的 CLI 里同名的项 */
  same: LibraryItem[]
  onClose: () => void
  onChanged: () => void
}) {
  const [cli, setCli] = useState(item.cli)
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [to, setTo] = useState<string[]>([])
  const [ai, setAi] = useState(false)
  const [rev, setRev] = useState(0)
  const { kind, name } = item
  const here = same.filter((i) => i.name === name)

  useEffect(() => {
    setText(null)
    setTo([])
    api
      .libraryFile(cli, kind, name)
      .then((f) => {
        setText(f.content)
        setSaved(f.content)
        setFiles(f.files)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  }, [cli, kind, name, rev])

  const save = async () => {
    setBusy(true)
    try {
      await api.saveLibraryFile({ cli, kind, name, content: text ?? '' })
      setSaved(text ?? '')
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
      if (r.done.length) toast.success(t('已复制到 {cli}', { cli: r.done.map(label).join('、') }))
      if (r.skipped.length)
        toast.warning(t('{cli} 里已经有同名的，没有覆盖', { cli: r.skipped.map(label).join('、') }), {
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
  const label = (id: string) => clis.find((c) => c.id === id)?.name ?? id
  const targets = clis.filter((c) => c.id !== cli && (kind === 'skill' ? c.skillDir : c.commandDir))
  const dirty = text !== null && text !== saved

  return (
    <>
      <Modal
        open
        wide
        onOpenChange={(o) => !o && onClose()}
        title={
          <span className="font-mono">
            {kind === 'command' ? '/' : ''}
            {name}
          </span>
        }
        footer={
          <>
            <Button variant="danger-outline" onClick={() => setDel(true)} disabled={busy}>
              <Trash2 className="h-4 w-4" />
              {t('删除')}
            </Button>
            <span className="flex-1" />
            {kind === 'skill' && (
              <Button variant="secondary" onClick={() => setAi(true)} disabled={busy || text === null}>
                <Sparkles className="h-4 w-4 text-accent" />
                {t('AI 优化')}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              {t('关闭')}
            </Button>
            <Button onClick={save} disabled={!dirty || busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('保存')}
            </Button>
          </>
        }
      >
        {here.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-subtle">{t('装在')}</span>
            {here.map((i) => (
              <button
                key={i.cli}
                type="button"
                onClick={() => setCli(i.cli)}
                className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[12px] ${i.cli === cli ? 'border-accent bg-accent-soft text-accent' : 'text-muted hover:bg-sel'}`}
              >
                {label(i.cli)}
              </button>
            ))}
          </div>
        )}
        <p className="-mt-2 truncate font-mono text-[11.5px] text-subtle">
          {same.find((i) => i.cli === cli)?.path ?? item.path}
        </p>
        {error ? (
          <p className="text-[13px] text-warning">{error}</p>
        ) : text === null ? (
          <p className="text-[13px] text-subtle">{t('读取中…')}</p>
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-[min(46vh,420px)] resize-none font-mono text-[12.5px] leading-relaxed"
            aria-label={t('内容')}
          />
        )}
        {!!files.length && (
          <p className="text-[12px] leading-relaxed text-muted">
            {t('文件夹里还有：')}
            <span className="font-mono">{files.join('  ')}</span>
            {t('（复制时一起带走，这里不能编辑）')}
          </p>
        )}
        {!!targets.length && (
          <div className="flex flex-col gap-2 border-t pt-4">
            <span className="text-[13px] font-medium">{t('复制给别的 CLI')}</span>
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
            {dirty && <p className="text-[12px] text-subtle">{t('先保存修改再复制')}</p>}
          </div>
        )}
      </Modal>
      {kind === 'skill' && (
        <AssistDialog
          open={ai}
          onOpenChange={setAi}
          kind="skill"
          title={name}
          subject={{ cli, name, content: text ?? '' }}
          onApply={async (p) => {
            if (p.kind !== 'skill') return
            await api.saveLibraryFile({ cli, kind, name, content: p.content })
            toast.success(t('已更新「{name}」', { name }))
            setRev((n) => n + 1)
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
            onChanged()
            if (here.length > 1) setCli(here.find((i) => i.cli !== cli)!.cli)
            else onClose()
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </>
  )
}
