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
import { ProjectSkillsSection } from '../ProjectSkillsSection'
import { ProjectMcpSection } from '../ProjectMcpSection'
import { itemOn, pluginMcpItems, type CapItem } from './caps-items'
import { panelMcpItem, useCapsLists } from './use-caps-data'
import { ScopeTrailing } from './CapabilitiesPage'

type View = 'all' | 'skill' | 'mcp'
type Tab = 'overview' | 'skills' | 'mcp'

/**
 * 项目工具里的「技能与 MCP」（设计稿 B3）：这个项目里的 Agent 实际能用到的技能和 MCP。
 * 上面是项目自己的（项目目录里，跟着仓库走），下面是从全局继承的（面板自带、插件、全局库）。
 * 原来项目设置里的「Skill」「MCP」两页挪到这里的「项目技能」「项目 MCP」页签（新建、编辑、导入都在那里）；
 * 开关按项目的能力在右上角「管理能力」（项目设置 →「能力」）
 */
export function ProjectCapsPage({ project }: { project: Project }) {
  const { openProject, go } = useNav()
  const [tab, setTab] = useState<Tab>('overview')
  return (
    <PageFrame
      align="left"
      title={t('技能与 MCP · {name}', { name: project.name })}
      intro={t(
        '这个项目里的 Agent 实际能用到的能力。项目自己的写在项目目录里、跟着仓库走；全局的对所有项目生效，在图标栏的 Skills、MCP 里管。',
      )}
      actions={
        <>
          <Button variant="secondary" onClick={() => setTab('skills')}>
            <Plus className="h-4 w-4" />
            {t('新建技能')}
          </Button>
          <Button variant="secondary" onClick={() => setTab('mcp')}>
            <FolderInput className="h-4 w-4" />
            {t('导入 MCP 配置')}
          </Button>
          <Button onClick={() => openProject(project.id, 'caps')}>
            <Settings2 className="h-4 w-4" />
            {t('管理能力')}
          </Button>
        </>
      }
    >
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        label={t('技能与 MCP 的页签')}
        options={[
          { id: 'overview', label: t('总览') },
          { id: 'skills', label: t('项目技能') },
          { id: 'mcp', label: t('项目 MCP') },
        ]}
      />
      {!project.path ? (
        <EmptyPanel size="md">{t('项目还没设本地目录，先在项目设置里选目录。')}</EmptyPanel>
      ) : tab === 'skills' ? (
        <ProjectSkillsSection key={project.id} projectId={project.id} />
      ) : tab === 'mcp' ? (
        <ProjectMcpSection key={project.id} project={project} />
      ) : (
        <Overview project={project} onGlobal={(page) => go({ page })} />
      )}
    </PageFrame>
  )
}

function Overview({ project, onGlobal }: { project: Project; onGlobal: (page: 'library' | 'mcp') => void }) {
  const lists = useCapsLists(project.id)
  const { rows } = usePlugins()
  const [view, setView] = useState<View>('all')
  const [q, setQ] = useState('')
  // 从全局继承的：面板自带的 MCP、开着的插件（按项目的只算这个项目打开了的）、全局库里生效的
  const inherited = useMemo(() => {
    const plugins = pluginMcpItems(rows, project)
    return [panelMcpItem(), ...plugins, ...(lists.global ?? []).filter((x) => itemOn(x, project.capabilities))]
  }, [rows, project, lists.global])
  const match = (x: CapItem) =>
    (view === 'all' || x.kind === view) &&
    (!q.trim() || `${x.name} ${x.description}`.toLowerCase().includes(q.trim().toLowerCase()))
  const own = (lists.own ?? []).filter(match)
  const inh = inherited.filter(match)
  const all = [...(lists.own ?? []), ...inherited]
  const count = (k: View) => all.filter((x) => k === 'all' || x.kind === k).length
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
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜索能力')} className="pl-8" />
        </div>
      </div>
      {lists.error && <p className="text-footnote break-all text-danger">{lists.error}</p>}
      <section className="flex flex-col gap-3">
        <CapabilityBlockHeader
          title={t('项目自己的')}
          meta={lists.own ? t('{n} 项 · 在项目目录里', { n: lists.own.length }) : t('正在读取…')}
        />
        {lists.own &&
          (own.length ? (
            <List items={own} caps={project.capabilities} />
          ) : (
            <EmptyPanel size="md">{t('项目目录里还没有技能和 MCP 配置。')}</EmptyPanel>
          ))}
      </section>
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
        {inh.length > 0 && <List items={inh} caps={project.capabilities} />}
      </section>
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
