import { useMemo } from 'react'
import { Info, Library, Plug, Sparkles } from 'lucide-react'
import type { ProjectInput } from '@shared/schema'
import type { CapabilityPluginRow } from '@shared/projects/capability-probe'
import { toggleCapability, type ProjectCapabilities } from '@shared/projects/capabilities'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useNav } from '@/lib/data'
import { dialogScrollClass } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { CapabilityCard } from '@/components/ui/capability-card'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import { pluginIcon } from '@/plugins/icon'
import { usePluginProjectSections } from '@/plugins/registry'
import { PageIntro } from '../settings/parts'
import type { SetDraft } from '../settings/project-draft'
import { itemOn, type CapItem } from './caps-items'
import { panelMcpItem, useCapsLists } from './use-caps-data'
import { CapsLoadSummary } from './CapsLoadSummary'

/**
 * 项目设置 / 新建项目 →「能力」（设计稿：Agent侧栏与项目管理重设计 6.3，效果图 D1、D2）：
 * 插件（只列按项目生效的，带推荐理由和还缺的设置）、MCP 工具、技能三块，右边是「交给 Agent 的」小结。
 * 开关只改草稿里的 capabilities，跟别的设置一起点「保存」落盘。
 * 全局生效的条目只列出来、标「全局」，不给开关（用户定）；项目目录里的跟着仓库走，也不能在这里关。
 */
export function CapabilitiesPage({
  isNew,
  projectId,
  draft,
  setDraft,
  probe,
  recommended,
  onSection,
}: {
  isNew: boolean
  projectId?: string
  draft: ProjectInput
  setDraft: SetDraft
  /** 按项目生效的插件和探查结果（弹窗外层问一次，左栏的黄点、计数也用它） */
  probe: { rows: CapabilityPluginRow[] | null; error: string }
  /** 新建项目时按目录自动打开了的插件（顶上的推荐提示用） */
  recommended: string[]
  /** 跳到插件自己的项目设置页（「去设置」） */
  onSection: (s: string) => void
}) {
  const { openSettings } = useNav()
  const caps = draft.capabilities
  const setCaps = (next: ProjectCapabilities) => setDraft((d) => ({ ...d, capabilities: next }))
  const toggle = (kind: keyof ProjectCapabilities, name: string, on: boolean) =>
    setCaps(toggleCapability(caps, kind, name, on))
  const lists = useCapsLists(projectId)
  const sections = usePluginProjectSections()
  const rows = probe.rows ?? []
  const onPlugins = rows.filter((r) => caps?.plugins?.includes(r.id))
  const recNames = rows.filter((r) => recommended.includes(r.id)).map((r) => r.name)

  // MCP 和技能：项目自己的排前面（跟着仓库走），然后是全局库里的；面板自带的 MCP 放最后
  const mcp = useMemo(
    () => [
      ...(lists.own ?? []).filter((x) => x.kind === 'mcp'),
      ...(lists.global ?? []).filter((x) => x.kind === 'mcp'),
      panelMcpItem(),
    ],
    [lists.own, lists.global],
  )
  const skills = useMemo(
    () => [
      ...(lists.own ?? []).filter((x) => x.kind === 'skill'),
      ...(lists.global ?? []).filter((x) => x.kind === 'skill'),
    ],
    [lists.own, lists.global],
  )
  const loading = !lists.own || !lists.global

  return (
    <div className={cn(dialogScrollClass, 'gap-7 md:flex-row')}>
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <PageIntro
          title={t('项目能力')}
          desc={t(
            '只有打开的能力会交给这个项目里的 Agent：工具清单短，省上下文，也不会在网页项目里误用 UE 的工具。以后在项目设置里随时增删。',
          )}
        />
        {isNew && recNames.length > 0 ? (
          <Notice
            action={
              <Button
                variant="link"
                onClick={() => setCaps({ ...(caps ?? { mcp: [], skills: [] }), plugins: [] } as ProjectCapabilities)}
              >
                {t('全部关掉')}
              </Button>
            }
          >
            {t('按目录里的内容推荐了 {names}，已经替你打开；其余默认不加载。', { names: recNames.join(t('、')) })}
          </Notice>
        ) : (
          !isNew && <Notice>{t('关掉的能力从下一轮对话起不再交给 Agent；插件的设置会留着，再打开时接着用。')}</Notice>
        )}

        <section className="flex flex-col gap-3">
          <CapabilityBlockHeader
            title={t('插件')}
            meta={t('{on} / {n} 已打开', { on: onPlugins.length, n: rows.length })}
            action={<span className="text-footnote text-subtle">{t('插件页装了新插件会出现在这里')}</span>}
          />
          {probe.error && <p className="text-footnote break-all text-danger">{probe.error}</p>}
          {probe.rows && !rows.length && (
            <p className="text-footnote text-subtle">
              {t('还没有按项目生效的插件。全局生效的插件（例如视频截帧）装好就对所有项目生效，这里没有开关。')}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map((r) => {
              const on = !!caps?.plugins?.includes(r.id)
              return (
                <CapabilityCard
                  key={r.id}
                  icon={pluginIcon(r.icon)}
                  name={t(r.name)}
                  description={r.description}
                  on={on}
                  disabled={!r.enabled}
                  onChange={(v) => toggle('plugins', r.id, v)}
                  badge={r.reason ? t('推荐') : undefined}
                  note={!r.enabled ? t('插件页里全局关着，先去插件页打开') : r.reason || undefined}
                  missing={r.missing}
                  error={r.error}
                  fixLabel={t('去设置')}
                  onFix={() => {
                    // 插件的项目设置页按插件 id 找；没有设置页的插件，「去设置」去插件页
                    const sec = sections.find((x) => x.plugin === r.id)
                    if (sec) onSection(sec.key)
                    else openSettings('plugins')
                  }}
                />
              )
            })}
          </div>
        </section>

        <ItemBlock
          title={t('MCP 工具')}
          items={mcp}
          loading={loading}
          caps={caps}
          onToggle={(name, on) => toggle('mcp', name, on)}
          icon={Plug}
        />
        <ItemBlock
          title={t('技能')}
          items={skills}
          loading={loading}
          caps={caps}
          onToggle={(name, on) => toggle('skills', name, on)}
          icon={Sparkles}
          empty={isNew ? t('保存项目后，这里会列出项目目录里的技能。') : undefined}
        />
        {lists.error && <p className="text-footnote break-all text-danger">{lists.error}</p>}
      </div>
      <aside className="flex shrink-0 flex-col gap-4 md:w-[280px]">
        <CapsLoadSummary rows={rows} caps={caps} mcp={mcp} skills={skills} />
      </aside>
    </div>
  )
}

function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-sel/50 px-3.5 py-2.5 text-body">
      <Info className="h-4 w-4 shrink-0 text-subtle" strokeWidth={2.2} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}

/** MCP、技能一块：按项目的给开关，全局的标「全局」，面板自带的标「始终启用」，项目里的标「项目里」 */
function ItemBlock({
  title,
  items,
  loading,
  caps,
  onToggle,
  icon,
  action,
  empty,
}: {
  title: string
  items: CapItem[]
  loading: boolean
  caps: ProjectInput['capabilities']
  onToggle: (name: string, on: boolean) => void
  icon: typeof Library
  action?: React.ReactNode
  empty?: string
}) {
  const on = items.filter((x) => itemOn(x, caps)).length
  return (
    <section className="flex flex-col gap-3">
      <CapabilityBlockHeader
        title={title}
        meta={loading ? t('正在读取…') : t('{on} / {n} 生效', { on, n: items.length })}
        action={action}
      />
      {!loading && (
        <CapabilityItemList footer={empty && <span className="text-footnote text-subtle">{empty}</span>}>
          {items.map((x) => (
            <CapabilityItem
              key={x.key}
              icon={icon}
              name={x.name}
              description={x.description}
              where={x.where}
              whereNote={x.whereNote}
              muted={!itemOn(x, caps)}
              trailing={<ScopeTrailing item={x} on={itemOn(x, caps)} onToggle={onToggle} />}
            />
          ))}
        </CapabilityItemList>
      )}
    </section>
  )
}

export function ScopeTrailing({
  item,
  on,
  onToggle,
}: {
  item: CapItem
  on: boolean
  onToggle?: (name: string, on: boolean) => void
}) {
  if (item.scope === 'project' && onToggle)
    return <Switch checked={on} onCheckedChange={(v) => onToggle(item.name, v)} aria-label={item.name} />
  // 只读的地方（技能与 MCP 页）写明是「本项目」开没开，和标「全局」的对所有项目都生效的分开
  if (item.scope === 'project')
    return <Badge tone={on ? 'accent' : 'neutral'}>{on ? t('本项目已打开') : t('本项目没打开')}</Badge>
  if (item.scope === 'always') return <Badge tone="success">{t('始终启用')}</Badge>
  // 全局插件但只在某些对话里挂（UI 设计页、Blender 页……）：写「按场景」，那一句在来源下面
  if (item.scope === 'global' && item.when)
    return (
      <Badge tone="accent" title={item.when}>
        {t('按场景')}
      </Badge>
    )
  if (item.scope === 'own')
    return item.importable ? <Badge tone="warning">{t('未导入')}</Badge> : <Badge>{t('项目里')}</Badge>
  return <Badge>{t('全局')}</Badge>
}
