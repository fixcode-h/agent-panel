import { useMemo, useState } from 'react'
import { ArrowUpRight, FolderInput, Plug, Plus, Search, Settings2, Sparkles, Terminal } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { usePlugins } from '@/plugins/registry'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import { PageFrame } from '@/components/library/parts'
import { OwnBlock } from './OwnBlock'
import { useOwnMcp, type OwnMcp } from './use-own-mcp'
import { useOwnSkills, type OwnSkills } from './use-own-skills'
import { itemOn, pluginMcpItems, type CapItem } from './caps-items'
import { panelMcpItem, useCapsLists, usePluginAttach } from './use-caps-data'
import { ScopeTrailing } from './CapabilitiesPage'
import { CustomToolsBlock } from './tools/CustomToolsBlock'
import { useCustomTools } from './tools/use-custom-tools'

type View = 'all' | 'skill' | 'mcp' | 'tool'

/**
 * 项目工具里的「技能与 MCP」（设计稿 B3）：这个项目里的 Agent 实际能用到的技能和 MCP。
 * 只有一排「全部 / 技能 / MCP」筛选（用户 2026-11-17 定：原来上面还有「总览 / 项目技能 / 项目 MCP」一排，两排重复显得乱），
 * 下面分两块：项目自己的（项目目录里，跟着仓库走；新建、编辑、导入、AI 修复都在这块的行上，见 OwnBlock），
 * 从全局继承的（面板自带、插件、全局库）。开关按项目的能力在右上角「管理能力」（项目设置 →「能力」）
 */
export function ProjectCapsPage({ project }: { project: Project }) {
  return <CapsBody key={project.id} project={project} />
}

/** 换项目时整页重建（key），项目自己的技能、MCP 和弹窗状态不串到别的项目 */
function CapsBody({ project }: { project: Project }) {
  const { openProject, go } = useNav()
  const lists = useCapsLists(project.id)
  const s = useOwnSkills(project.id, lists.reload)
  const m = useOwnMcp(project, lists.reload)
  return (
    <PageFrame
      align="left"
      title={t('技能与 MCP · {name}', { name: project.name })}
      intro={t(
        '这个项目里的 Agent 实际能用到的能力。项目自己的写在项目目录里、跟着仓库走；全局的对所有项目生效，在图标栏的 Skills、MCP 里管。',
      )}
      actions={
        <>
          <Button variant="secondary" onClick={s.create} disabled={!s.canCreate}>
            <Plus className="h-4 w-4" />
            {t('新建技能')}
          </Button>
          <Button variant="secondary" onClick={m.add} disabled={!m.data}>
            <FolderInput className="h-4 w-4" />
            {t('添加 MCP')}
          </Button>
          <Button onClick={() => openProject(project.id, 'caps')}>
            <Settings2 className="h-4 w-4" />
            {t('管理能力')}
          </Button>
        </>
      }
    >
      {!project.path ? (
        <EmptyPanel size="md">{t('项目还没设本地目录，先在项目设置里选目录。')}</EmptyPanel>
      ) : (
        <Overview project={project} lists={lists} s={s} m={m} onGlobal={(page) => go({ page })} />
      )}
      {s.dialogs}
      {m.dialogs}
    </PageFrame>
  )
}

function Overview({
  project,
  lists,
  s,
  m,
  onGlobal,
}: {
  project: Project
  lists: ReturnType<typeof useCapsLists>
  s: OwnSkills
  m: OwnMcp
  onGlobal: (page: 'library' | 'mcp') => void
}) {
  const { rows } = usePlugins()
  const attachOf = usePluginAttach()
  const [view, setView] = useState<View>('all')
  const [q, setQ] = useState('')
  // 自建工具（ADR 0082）：项目的和全局的
  const ct = useCustomTools(project.id)
  const toolCount = (ct.data?.entries ?? []).filter((e) => !e.shadowed).length
  const detected = m.data?.detected
  // 项目里识别到、已经导入面板的 MCP 在「项目自己的」里列（带本项目开没开），全局那块不再列一遍
  const ownMcpNames = useMemo(() => new Set((detected ?? []).map((d) => d.name)), [detected])
  // 从全局继承的：面板自带的 MCP、开着的插件（按项目的只算这个项目打开了的）、全局库里生效的
  const inherited = useMemo(() => {
    const plugins = pluginMcpItems(rows, project, attachOf)
    const lib = (lists.global ?? []).filter(
      (x) => itemOn(x, project.capabilities) && !(x.kind === 'mcp' && ownMcpNames.has(x.name)),
    )
    return [panelMcpItem(), ...plugins, ...lib]
  }, [rows, project, lists.global, ownMcpNames, attachOf])
  const hit = (text: string) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase())
  const ownSkills = s.view?.skills ?? []
  const ownMcp = detected ?? []
  const shownSkills =
    view === 'mcp' || view === 'tool' ? [] : ownSkills.filter((x) => hit(`${x.name} ${x.description}`))
  const shownMcp =
    view === 'skill' || view === 'tool' ? [] : ownMcp.filter((d) => hit(`${d.name} ${d.file} ${m.summary(d.server)}`))
  const inh = inherited.filter((x) => (view === 'all' || x.kind === view) && hit(`${x.name} ${x.description}`))
  const ownReady = !!s.view && !!m.data
  const count = (k: View) =>
    k === 'tool'
      ? toolCount
      : (k === 'mcp' ? 0 : ownSkills.length) +
        (k === 'skill' ? 0 : ownMcp.length) +
        inherited.filter((x) => k === 'all' || x.kind === k).length +
        (k === 'all' ? toolCount : 0)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<View>
          value={view}
          onChange={setView}
          label={t('按类型筛选')}
          options={[
            { id: 'all', label: t('全部 {n}', { n: count('all') }) },
            { id: 'skill', label: t('技能 {n}', { n: count('skill') }) },
            { id: 'mcp', label: t('MCP {n}', { n: count('mcp') }) },
            { id: 'tool', label: t('工具 {n}', { n: count('tool') }) },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜索能力')} className="pl-8" />
        </div>
      </div>
      {view === 'tool' && <CustomToolsBlock ct={ct} q={q} inProject />}
      {view !== 'tool' && (
        <OwnBlock
          s={s}
          m={m}
          skills={shownSkills}
          mcp={shownMcp}
          total={ownReady ? ownSkills.length + ownMcp.length : undefined}
        />
      )}
      {view !== 'tool' && (
        <section className="flex flex-col gap-3">
          <CapabilityBlockHeader
            title={t('从全局继承')}
            meta={t('{n} 项', { n: inherited.length })}
            action={
              <>
                <Button variant="link" tone="muted" onClick={() => onGlobal('library')}>
                  {t('全局 Skills')}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
                <Button variant="link" tone="muted" onClick={() => onGlobal('mcp')}>
                  {t('全局 MCP')}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              </>
            }
          />
          {lists.error && <p className="text-footnote break-all text-danger">{lists.error}</p>}
          {inh.length > 0 ? (
            <List items={inh} caps={project.capabilities} />
          ) : (
            <EmptyPanel size="md">{t('没有符合筛选的条目。')}</EmptyPanel>
          )}
        </section>
      )}
      {view === 'all' && <CustomToolsBlock ct={ct} q={q} inProject />}
    </div>
  )
}

/** 列表：技能用星光图标，MCP 用插头（项目里的 MCP 配置用终端） */
function List({ items, caps }: { items: CapItem[]; caps: Project['capabilities'] }) {
  return (
    <CapabilityItemList>
      {items.map((x) => (
        <CapabilityItem
          key={x.key}
          icon={x.kind === 'skill' ? Sparkles : x.scope === 'own' ? Terminal : Plug}
          name={x.name}
          kind={x.kind === 'skill' ? t('技能') : 'MCP'}
          description={x.description}
          where={x.where}
          whereNote={x.whereNote}
          trailing={<ScopeTrailing item={x} on={itemOn(x, caps)} />}
        />
      ))}
    </CapabilityItemList>
  )
}
