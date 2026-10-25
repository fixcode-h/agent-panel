import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Loader2, Package, Plus, Sparkles, Terminal } from 'lucide-react'
import type { LibraryCli, LibraryItem } from '@shared/library'
import { libraryName } from '@shared/library'
import { ALL_AGENTS } from '@shared/commands'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { useSkillUpdates } from '@/lib/skill-updates'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/menu'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { LibraryDetail } from '@/components/library/LibraryDetail'
import { BundledSkills } from '@/components/library/BundledSkills'
import { AssistDialog } from '@/components/assist/AssistDialog'

type Kind = 'skill' | 'command'
/** 页面上的分页：多一个「自带 Skill」 */
type Tab = Kind | 'bundled'

/** 新建时的模板：命令按 CLI 的格式（md / toml）写 */
function template(kind: Kind, name: string, format: 'md' | 'toml') {
  if (kind === 'skill')
    return `---\nname: ${name}\ndescription: ${t('一句话说明什么时候该用它')}\n---\n\n${t('在这里写步骤和注意事项。')}\n`
  return format === 'toml'
    ? `description = ${JSON.stringify(t('一句话说明它做什么'))}\nprompt = """\n${t('在这里写要做的事，{{args}} 是输入的参数。')}\n"""\n`
    : `---\ndescription: ${t('一句话说明它做什么')}\n---\n${t('在这里写要做的事，$ARGUMENTS 是输入的参数。')}\n`
}

/** 分页种类按本地存储记住：切走页面再回来还是原来那一页 */
const TAB_KEY = 'library.tab'
function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'command' || v === 'bundled' ? v : 'skill'
  } catch {
    return 'skill'
  }
}
function writeTab(tab: Tab) {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // 隐私模式禁用本地存储时只是不记住，不影响使用
  }
}

export function LibraryPage() {
  const { route, go } = useNav()
  const [tab, setTab] = useState<Tab>(readTab)
  const kind: Kind = tab === 'command' ? 'command' : 'skill'
  const [data, setData] = useState<{ clis: LibraryCli[]; items: LibraryItem[] } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [ai, setAi] = useState(false)
  const [rev, setRev] = useState(0)
  // 自带技能有新内容：「自带 Skill」分页亮点，进去能看到在哪里更新
  const upd = useSkillUpdates()
  const updN = new Set([...upd.shared, ...upd.deployed]).size

  // 切换分页前发出的读取（例如保存后刷新）晚回来时不能盖掉新分页的列表
  const current = useRef(kind)
  current.current = kind
  const load = () => {
    const k = kind
    return api
      .library(k)
      .then((d) => {
        if (current.current !== k) return
        setData(d)
        setError('')
      })
      .catch((e) => current.current === k && setError((e as Error).message))
  }
  useEffect(() => {
    setData(null)
    setQuery('')
    writeTab(tab)
    // 换分页时地址里留着上一页的技能名没有意义（命令页里不会有 Skill），清掉让新列表自己选第一项
    if (route.id) go({ page: 'library' })
    void load()
    // load 每次渲染都是新的函数，只在切换分页时重新读（自带 Skill 装完后回到 Skill 页要看到新装的）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 过滤后的项，按 Agent 分组：从左栏就能看出哪些装在哪个 CLI 里
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.items ?? []).filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q))
  }, [data, query])
  const cliName = (id: string) => data?.clis.find((c) => c.id === id)?.name ?? id
  const groups = useMemo(() => {
    // 「所有 Agent」排第一（只有命令会放在那里），其余跟 CLI 列表的顺序
    const ids = [...new Set(hits.map((i) => i.cli))].sort((a, b) => Number(b === ALL_AGENTS) - Number(a === ALL_AGENTS))
    return ids
      .map((cli) => ({ cli, label: cliName(cli), items: hits.filter((i) => i.cli === cli) }))
      .filter((g) => g.items.length)
    // cliName 只依赖 data.clis，跟着 hits 一起算
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, data])

  // 地址里的名字（和可选的 Agent）决定选中项；不在列表里（例如刚删掉）就回第一项。
  // 这里用未过滤的全量算：搜索只过滤左栏，搜到别的名字时右边开的那个技能不能跟着消失
  const same = (data?.items ?? []).filter((i) => i.name === route.id)
  const shown = same.find((i) => i.cli === route.sub) ?? same[0] ?? null
  useEffect(() => {
    // 搜索只是过滤：搜完清空还要回到原来那一项，不能在这期间改地址
    if (tab === 'bundled' || query || !data || !hits.length || shown) return
    go({ page: 'library', id: hits[0].name, sub: hits[0].cli })
    // 只在地址和列表对不上时纠正一次；go、hits 每次渲染都是新的，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hits.length, shown, route.id, tab, query])

  return (
    <>
      <ListPane
        title={t('Skills 与命令')}
        count={data?.items.length ?? 0}
        onNew={() => setCreating(true)}
        hideNew={tab === 'bundled'}
        extra={
          tab !== 'bundled' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAi(true)}
              disabled={!data}
              title={
                kind === 'command'
                  ? t('描述需求，让本机 Agent 写命令，所有 Agent 都能用')
                  : t('描述需求，让本机 Agent 写 Skill')
              }
            >
              <Sparkles className="h-4 w-4 text-accent" />
              {t('AI 创建')}
            </Button>
          )
        }
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索名字和说明')}
        tabs={
          <Segmented
            label={t('种类')}
            value={tab}
            onChange={setTab}
            options={[
              { id: 'skill', label: 'Skill' },
              { id: 'command', label: t('命令') },
              {
                id: 'bundled',
                label: t('自带 Skill'),
                dot: updN ? t('{n} 个自带技能可以更新', { n: updN }) : undefined,
              },
            ]}
          />
        }
        footer={
          <p className="text-[0.75rem] leading-relaxed text-subtle">
            {t('放在各个 Agent 的用户目录里；放进「所有 Agent」的由面板展开，选哪个 Agent 都能用。')}
          </p>
        }
      >
        {tab === 'bundled' ? (
          <BundledSkills query={query} />
        ) : error ? (
          <p className="px-2 py-6 text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
        ) : !data ? (
          <p className="px-2 py-6 text-[0.8125rem] text-subtle">{t('读取中…')}</p>
        ) : !hits.length ? (
          <ListEmpty>
            {query
              ? t('没有符合的{kind}。', { kind: kind === 'skill' ? 'Skill' : t('命令') })
              : t('还没有，点右上角「新建」。')}
          </ListEmpty>
        ) : (
          // 按 Agent 分组：一眼看出哪些装在哪个 CLI 里（同名会同时出现在几组）
          groups.map((g) => (
            <ListGroup key={g.cli || 'all'} header={<GroupHeader label={g.label} count={g.items.length} />}>
              {g.items.map((i) => (
                <ListItem
                  key={`${i.cli}:${i.name}`}
                  selected={shown?.name === i.name && shown.cli === i.cli}
                  onClick={() => go({ page: 'library', id: i.name, sub: i.cli })}
                  leading={
                    kind === 'skill' ? (
                      <Sparkles className="h-4 w-4 shrink-0 text-accent" />
                    ) : (
                      <Terminal className="h-4 w-4 shrink-0 text-accent" />
                    )
                  }
                  title={kind === 'command' ? `/${i.name}` : i.name}
                  subtitle={i.description || t('没有说明')}
                  monoSubtitle={false}
                  menu={
                    <>
                      <ContextMenuItem onSelect={() => go({ page: 'library', id: i.name, sub: i.cli })}>
                        <Sparkles className="h-4 w-4" />
                        {t('打开这一份')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => setCreating(true)}>
                        <Plus className="h-4 w-4" />
                        {t('新建')}
                      </ContextMenuItem>
                    </>
                  }
                />
              ))}
            </ListGroup>
          ))
        )}
      </ListPane>

      {tab === 'bundled' ? (
        <DetailEmpty icon={<Package className="h-6 w-6" />} title={t('自带 Skill')}>
          <p>
            {t(
              '这些是面板自带的技能，统一装在 ~/.agents/skills，所有 Agent 共用。在左边的列表里安装、更新，或换回自带版本。',
            )}
          </p>
        </DetailEmpty>
      ) : shown ? (
        <LibraryDetail
          key={`${kind}:${shown.name}:${shown.cli}`}
          item={shown}
          clis={data?.clis ?? []}
          same={same}
          revision={rev}
          onChanged={() => {
            setRev((n) => n + 1)
            void load()
          }}
          onDeleted={() => go({ page: 'library' })}
          onPickCli={(cli) => go({ page: 'library', id: shown.name, sub: cli })}
        />
      ) : (
        !data || (
          <DetailEmpty
            icon={kind === 'skill' ? <Sparkles className="h-6 w-6" /> : <Terminal className="h-6 w-6" />}
            title={t('还没有{kind}', { kind: kind === 'skill' ? 'Skill' : t('命令') })}
          >
            <p>{t('在左边选一项，或新建一个：装好之后所有 Agent 都能用。')}</p>
            <Button className="mt-5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t('新建')}
            </Button>
          </DetailEmpty>
        )
      )}

      {data && creating && tab !== 'bundled' && (
        <CreateDialog
          kind={kind}
          clis={data.clis}
          taken={data.items}
          onClose={() => setCreating(false)}
          onDone={(created) => {
            setCreating(false)
            void load()
            if (created) go({ page: 'library', id: created.name, sub: created.cli })
          }}
        />
      )}
      {data && kind === 'command' && (
        <AssistDialog
          open={ai}
          onOpenChange={setAi}
          kind="command"
          subject={{ taken: [...new Set(data.items.map((i) => i.name))].join(',') }}
          onApply={async (p) => {
            if (p.kind !== 'command') return
            // AI 写的命令放进「所有 Agent」：由面板展开，哪个 CLI 都能用
            await api.saveLibraryFile({
              cli: ALL_AGENTS,
              kind: 'command',
              name: p.name,
              content: p.content,
              create: true,
            })
            toast.success(t('已创建「/{name}」，所有 Agent 都能用', { name: p.name }))
            void load()
            go({ page: 'library', id: p.name, sub: ALL_AGENTS })
          }}
        />
      )}
      {data && kind === 'skill' && (
        <AssistDialog
          open={ai}
          onOpenChange={setAi}
          kind="skill"
          onApply={async (p) => {
            if (p.kind !== 'skill') return
            // 先放进第一个有 Skill 目录的 CLI，要给别的 CLI 用，打开它再复制
            const cli = data.clis.find((c) => c.skillDir)
            if (!cli) throw new Error(t('没有可以放 Skill 的 Agent'))
            await api.saveLibraryFile({ cli: cli.id, kind: 'skill', name: p.name, content: p.content, create: true })
            toast.success(
              t('已创建「{name}」，放在 {cli}；要给别的 Agent 用，打开它再复制', { name: p.name, cli: cli.name }),
            )
            void load()
            go({ page: 'library', id: p.name, sub: cli.id })
          }}
        />
      )}
    </>
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
  /** 创建成功后把新建的那一项交给页面去选中 */
  onDone: (created?: { name: string; cli: string }) => void
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
      onDone({ name, cli: picked[0] })
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
          <span className="flex-1 text-[0.75rem] text-warning">
            {dup.length ? t('{cli} 里已经有同名的了', { cli: dup.map((i) => i.cli).join(t('、')) }) : ''}
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
        <span className="text-[0.8125rem] font-medium">{t('名字')}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder={kind === 'skill' ? 'commit-message' : 'review'}
          className="font-mono"
        />
        <span className="text-[0.75rem] text-subtle">
          {name && !valid ? t('只能用字母、数字、. _ -，以字母或数字开头') : t('用来调用它的名字，创建后不能改')}
        </span>
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-[0.8125rem] font-medium">{t('放进哪些 Agent')}</span>
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
