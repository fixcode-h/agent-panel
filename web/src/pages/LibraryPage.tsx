import { useEffect, useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { Loader2, Plus, Sparkles } from 'lucide-react'
import type { LibraryCli, LibraryItem } from '@shared/library'
import { libraryName } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { sharedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { useBundledSkills } from '@/lib/use-bundled-skills'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { cliColor } from '@/lib/cli-style'
import { Modal } from '@/components/ui/modal'
import { ContextMenuItem } from '@/components/ui/menu'
import { ListEmpty, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { LibraryDetail } from '@/components/library/LibraryDetail'
import { BundledBulkBar, BundledSkills } from '@/components/library/BundledSkills'
import { BundledDetail, BundledEmpty } from '@/components/library/BundledDetail'
import { AssistDialog } from '@/components/assist/AssistDialog'

/**
 * 页面上的分页：Skill 和「自带 Skill」。
 * 命令分页按用户要求去掉了（这一页只管 Skill），命令仍可在对话里用 / 调出
 */
type Tab = 'skill' | 'bundled'

/** 新建 Skill 时的模板 */
function template(name: string) {
  return `---\nname: ${name}\ndescription: ${t('一句话说明什么时候该用它')}\n---\n\n${t('在这里写步骤和注意事项。')}\n`
}

/** 分页种类按本地存储记住：切走页面再回来还是原来那一页 */
const TAB_KEY = 'library.tab'
function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    // 以前记下的「命令」分页已经没有了，回到 Skill
    return v === 'bundled' ? v : 'skill'
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
  const [data, setData] = useState<{ clis: LibraryCli[]; items: LibraryItem[] } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [ai, setAi] = useState(false)
  const [rev, setRev] = useState(0)
  // 自带技能有新内容：「自带 Skill」分页亮点，进去能看到在哪里更新
  const upd = useSkillUpdates()
  const updHint = sharedUpdateHint(upd)
  // 自带技能：列表和安装动作两边都用（左栏列表、右详情、底部的批量按钮）
  const bundled = useBundledSkills()
  // 地址里只有名字（自带技能不分 Agent）。这里用未过滤的全量找：搜索只过滤左栏，
  // 搜到别的名字时右边开着的那份不能跟着消失（和 Skill 分页同一个口径）
  const bundledPicked = tab === 'bundled' ? bundled.items?.find((i) => i.name === route.id) : undefined

  const load = () =>
    api
      .library('skill')
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  /**
   * 换分页：清掉地址里的选中项，再换种类。
   * 清地址放在这个动作上（不放 effect 里）：挂载时不能清，否则刷新或从链接打开会丢掉地址里的那一项；
   * 也不好用「effect 首次执行」判断——StrictMode 下开发模式的 effect 会跑两遍，第二遍就当成「换分页」把地址清了。
   */
  const pickTab = (next: Tab) => {
    if (next === tab) return
    // 上一页选中的名字在新一页没有意义（自带 Skill 和已装的 Skill 是两份列表），清掉让新列表自己选第一项
    if (route.id) go({ page: 'library' })
    setTab(next)
  }
  useEffect(() => {
    setData(null)
    setQuery('')
    writeTab(tab)
    void load()
    // load 每次渲染都是新的函数，只在切换分页时重新读（自带 Skill 装完后回到 Skill 页要看到新装的）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 过滤后的项，按 Agent 分组：从左栏就能看出哪些装在哪个 CLI 里
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.items ?? []).filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q))
  }, [data, query])
  // 同名的合成一条：装在几个 Agent 里由行尾的色点标出来，进详情再用开关管装在哪些 Agent。
  // 原来按 Agent 分组，同一个 Skill 装了两份就在列表里出现两次
  const merged = useMemo(() => {
    const byName = new Map<string, LibraryItem[]>()
    for (const i of hits) byName.set(i.name, [...(byName.get(i.name) ?? []), i])
    return [...byName.values()]
  }, [hits])
  const cliName = (id: string) => data?.clis.find((c) => c.id === id)?.name ?? id

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

  // 自带技能也一样：进这一页、或者选中的那份没了，就打开第一项（搜索时不改，和上面同一个口径）
  useEffect(() => {
    if (tab !== 'bundled' || query || !bundled.items?.length || bundledPicked) return
    go({ page: 'library', id: bundled.items[0].name })
    // 只在地址和列表对不上时纠正一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bundled.items, bundledPicked, tab, query])

  return (
    <>
      <ListPane
        title={t('Skills')}
        // 自带技能的点数来自它自己的列表（Skill 分页里没有读那份数据）
        count={tab === 'bundled' ? (bundled.items?.length ?? 0) : (data?.items.length ?? 0)}
        onNew={() => setCreating(true)}
        hideNew={tab === 'bundled'}
        compact
        // 新建、AI 创建收进一个「＋」菜单，头部只留一个按钮
        newMenu={[
          { label: t('新建 Skill'), icon: Plus, onSelect: () => setCreating(true) },
          {
            label: t('AI 创建 Skill'),
            icon: Sparkles,
            hint: t('描述需求，让本机 Agent 写 Skill'),
            onSelect: () => setAi(true),
            disabled: !data,
          },
        ]}
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索名字和说明')}
        tabs={
          // 两页并排摆出来：原来是下拉框，看不出还有「自带 Skill」这一页；有可更新的自带技能时挂一个点
          <Segmented
            fill
            size="sm"
            label={t('种类')}
            value={tab}
            onChange={pickTab}
            options={[
              { id: 'skill', label: t('我的 Skill') },
              { id: 'bundled', label: t('自带 Skill'), dot: updHint || undefined },
            ]}
          />
        }
        footer={
          tab === 'bundled' ? (
            <BundledBulkBar items={bundled.items} busy={bundled.busy} onInstall={bundled.install} />
          ) : (
            <p className="text-footnote leading-relaxed text-subtle">{t('放在各个 Agent 的用户目录里。')}</p>
          )
        }
      >
        {tab === 'bundled' ? (
          <BundledSkills
            query={query}
            items={bundled.items}
            error={bundled.error}
            picked={route.id}
            onPick={(name) => go({ page: 'library', id: name })}
          />
        ) : error ? (
          <p className="px-2 py-6 text-body text-warning">{t('读取失败：{error}', { error })}</p>
        ) : !data ? (
          <p className="px-2 py-6 text-body text-subtle">{t('读取中…')}</p>
        ) : !hits.length ? (
          <ListEmpty>
            {query ? t('没有符合的{kind}。', { kind: 'Skill' }) : t('还没有，点右上角的 ＋ 新建。')}
          </ListEmpty>
        ) : (
          merged.map((copies) => {
            const i = copies[0]
            return (
              <ListItem
                key={i.name}
                compact
                selected={shown?.name === i.name}
                onClick={() => go({ page: 'library', id: i.name, sub: i.cli })}
                leading={<Sparkles className="h-4 w-4 shrink-0 text-accent-text" />}
                title={i.name}
                subtitle={i.description || t('没有说明')}
                monoSubtitle={false}
                trailing={
                  <span
                    className="flex shrink-0 items-center gap-1"
                    title={t('装在 {cli}', { cli: copies.map((c) => cliName(c.cli)).join(t('、')) })}
                  >
                    {copies.map((c) => (
                      <span key={c.cli} className="h-1.5 w-1.5 rounded-full" style={{ background: cliColor(c.cli) }} />
                    ))}
                  </span>
                }
                menu={
                  <ContextMenuItem onSelect={() => setCreating(true)}>
                    <Plus className="h-4 w-4" />
                    {t('新建')}
                  </ContextMenuItem>
                }
              />
            )
          })
        )}
      </ListPane>

      {tab === 'bundled' ? (
        bundledPicked ? (
          <BundledDetail
            key={bundledPicked.name}
            item={bundledPicked}
            busy={bundled.busy}
            onInstall={bundled.install}
          />
        ) : (
          <BundledEmpty />
        )
      ) : shown ? (
        <LibraryDetail
          key={`${shown.name}:${shown.cli}`}
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
          <DetailEmpty icon={<Sparkles className="h-6 w-6" />} title={t('还没有{kind}', { kind: 'Skill' })}>
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
      {data && (
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
  clis,
  taken,
  onClose,
  onDone,
}: {
  clis: LibraryCli[]
  taken: LibraryItem[]
  onClose: () => void
  /** 创建成功后把新建的那一项交给页面去选中 */
  onDone: (created?: { name: string; cli: string }) => void
}) {
  const ok = clis.filter((c) => c.skillDir)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>(ok.slice(0, 1).map((c) => c.id))
  const [busy, setBusy] = useState(false)
  const valid = libraryName('skill', name)
  const dup = taken.filter((i) => i.name === name && picked.includes(i.cli))
  const create = async () => {
    setBusy(true)
    try {
      for (const id of picked)
        await api.saveLibraryFile({
          cli: id,
          kind: 'skill',
          name,
          create: true,
          content: template(name),
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
      title={t('新建 Skill')}
      footer={
        <>
          <span className="flex-1 text-footnote text-warning">
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
        <span className="text-body font-medium">{t('名字')}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="commit-message"
          className="font-mono"
        />
        <span className="text-footnote text-subtle">
          {name && !valid ? t('只能用字母、数字、. _ -，以字母或数字开头') : t('用来调用它的名字，创建后不能改')}
        </span>
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-body font-medium">{t('放进哪些 Agent')}</span>
        {ok.map((c) => (
          <Checkbox
            key={c.id}
            checked={picked.includes(c.id)}
            onChange={(v) => setPicked((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
            label={c.name}
            hint={c.skillDir}
          />
        ))}
      </div>
    </Modal>
  )
}
