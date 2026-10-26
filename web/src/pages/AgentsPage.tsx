import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Bot, Copy, LayoutTemplate, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { isCoreAgent } from '@shared/builtin/core'
import { type Agent, type AgentInput, type Category } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cliColor, shortVersion } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/badge'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/menu'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentDetail } from '@/components/agents/AgentDetail'
import { CategoryHeader } from '@/components/agents/CategoryHeader'
import { TagCountChip, TagFilter, TagList } from '@/components/tags/Tags'
import { Segmented } from '@/components/ui/segmented'
import { groupAgentsByTag } from '@/lib/agent-groups'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { BuiltinAgentsDialog } from '@/components/agents/BuiltinAgentsDialog'
import { useAgentView } from '@/lib/agent-view'
import { defaultCli } from '@shared/settings'
import { cliToEnable } from '@/components/layout/NoCliBanner'
import { t } from '@shared/i18n'

/** 「必备」分组的 id，和用户分类的 id 不会冲突 */
const CORE_GROUP = '#core'

/** 列表的分组方式：默认按标签（整理角色靠它），分类视图保留分类的增删改和「在这个分类里新建」 */
type GroupBy = 'tag' | 'category'
const GROUP_BY_DEFAULT: GroupBy = 'tag'

export function AgentsPage() {
  const { cliName, cliOf, modelOf } = useAgentView()
  const { loading, agents, categories: allCategories, tags, clis, settings, setAgents, refreshClis } = useData()
  const categories = allCategories.filter((c) => c.scope !== 'workflow')
  const [tag, setTag] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>(GROUP_BY_DEFAULT)
  const { route, go, openSettings } = useNav()
  const [query, setQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const [assist, setAssist] = useState(false)
  const [builtin, setBuiltin] = useState(false)
  const [rev, setRev] = useState(0)
  // 列表右键「删除」：先选中那个 Agent，再让详情页弹出删除确认（确认框和被引用的检查都在详情页里）
  const [delReq, setDelReq] = useState<{ id: string; at: number }>()

  const defId = settings ? defaultCli(settings) : clis.find((c) => c.isDefault)?.id
  const defStatus = clis.find((c) => c.id === defId && c.enabled)

  const selected = agents.find((a) => a.id === route.id) ?? agents[0]
  useEffect(() => {
    if (!loading && selected && route.id !== selected.id) go({ page: 'agents', id: selected.id })
    // 地址里的 id 不存在（例如已删除）时也要换成第一个；go 每次渲染都是新的，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected?.id, route.id])

  const q = query.trim().toLowerCase()
  const tagNames = (ids: string[]) => ids.map((id) => tags.find((x) => x.id === id)?.name ?? '').join(' ')
  const match = (a: Agent) =>
    (!tag || a.tags.includes(tag)) &&
    (!q || `${a.name}${a.description}${modelOf(a)}${tagNames(a.tags)}`.toLowerCase().includes(q))
  const coreCats = new Set(agents.filter(isCoreAgent).map((a) => a.categoryId))
  // 按标签分组：没有标签的角色进「默认」组，组按角色数排、零组不出现（规则和单测在 lib/agent-groups.ts）
  const tagGroups = groupAgentsByTag(agents.filter(match), tags)
  const categoryGroups = [
    // 必备角色也单独成组：它们的分类由面板维护，放在用户的分类里反而像是能挪走
    { category: null as Category | null, id: CORE_GROUP, items: agents.filter((a) => isCoreAgent(a) && match(a)) },
    ...[
      ...categories
        .filter((c) => !coreCats.has(c.id) || agents.some((a) => a.categoryId === c.id && !isCoreAgent(a)))
        .map((c) => ({ category: c as Category | null, id: c.id })),
      { category: null, id: '' },
    ].map((g) => ({
      ...g,
      items: agents.filter((a) => !isCoreAgent(a) && a.categoryId === g.id && match(a)),
    })),
  ]
    // 没有角色的分类不显示，空着只占位置
    .filter((g) => g.items.length)
  // 当前视图下的分组只有长度有用（空状态），两种分组的结构不同，不混成一个变量
  const shownGroups = groupBy === 'tag' ? tagGroups : categoryGroups

  const create = async (input: Partial<AgentInput> = {}) => {
    try {
      const a = await api.createAgent({
        name: t('新角色'),
        description: '',
        cli: '',
        model: '@medium',
        effort: '',
        categoryId: selected?.categoryId ?? '',
        icon: 'bot',
        instructions: '',
        permission: '',
        extraArgs: [],
        enabled: true,
        common: false,
        canDelegate: false,
        canPlan: false,
        capsSet: true,
        includes: [],
        params: [],
        skills: [],
        starters: [],
        tags: [],
        ...input,
        // 副本不再算内置的，免得添加内置工作流时被当成那个内置 Agent
        origin: '',
      })
      setAgents((as) => [...as, a])
      setQuery('')
      go({ page: 'agents', id: a.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const duplicate = (a: Agent) => {
    // 复制出来的是自己的，不再算内置的（不然再加内置工作流时会被当成已有的复用）
    const { id, createdAt, updatedAt, origin, ...rest } = a
    create({ ...rest, name: t('{name} 副本', { name: a.name }) })
  }

  const recheck = async () => {
    setChecking(true)
    await refreshClis()
      .catch((e) => toast.error(t('检测失败：{error}', { error: (e as Error).message })))
      .finally(() => setChecking(false))
  }

  // 列表右边的状态带文字：只有一个点时看不出是什么意思
  const status = (a: Agent) => {
    const installed = clis.find((c) => c.id === cliOf(a))?.installed
    return !a.enabled ? (
      <StatusDot tone="muted" label={t('已停用')} />
    ) : installed ? (
      <StatusDot tone="success" label={t('就绪')} />
    ) : (
      <StatusDot tone="warning" label={t('Agent 未安装')} />
    )
  }

  // 两种分组共用的一行：分组只决定它在哪几节里出现
  const row = (a: Agent) => (
    <ListItem
      key={a.id}
      selected={a.id === selected?.id}
      onClick={() => go({ page: 'agents', id: a.id })}
      leading={<AgentAvatar icon={a.icon} cli={a.cli} dim={!a.enabled} />}
      title={a.name}
      subtitle={`${cliName(a)} · ${modelOf(a)}`}
      tags={a.tags.length ? <TagList ids={a.tags} /> : undefined}
      trailing={<span className="shrink-0">{status(a)}</span>}
      menu={
        <>
          <ContextMenuItem onSelect={() => duplicate(a)}>
            <Copy className="h-4 w-4" />
            {t('复制一份')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            danger
            disabled={isCoreAgent(a)}
            onSelect={() => {
              go({ page: 'agents', id: a.id })
              setDelReq({ id: a.id, at: Date.now() })
            }}
          >
            <Trash2 className="h-4 w-4" />
            {t('删除')}
          </ContextMenuItem>
        </>
      }
    />
  )

  return (
    <>
      <ListPane
        title={t('角色')}
        count={agents.length}
        onNew={() => create()}
        extra={
          <>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={t('添加内置角色')}
              title={t('添加内置角色')}
              onClick={() => setBuiltin(true)}
            >
              <LayoutTemplate className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAssist(true)}
              title={t('描述需求，让本机 Agent 生成角色')}
            >
              <Sparkles className="h-4 w-4 text-accent" />
              {t('AI 创建')}
            </Button>
          </>
        }
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索名称、简介、模型或标签')}
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex items-center text-xs text-subtle">
              {t('默认 Agent')}
              <button
                onClick={recheck}
                disabled={checking}
                className="ml-auto flex cursor-pointer items-center gap-1 text-accent"
              >
                <RefreshCw className={cn('h-3 w-3', checking && 'animate-spin')} />
                {t('重新检测')}
              </button>
            </div>
            {/* 只列默认 CLI：Agent 不指定 CLI 时用它，工作流节点也固定用它；完整列表和切换默认在设置里 */}
            {defStatus ? (
              <div className="flex items-center gap-2 text-[0.8125rem]" title={defStatus.version}>
                <span className="h-2 w-2 rounded-[2px]" style={{ background: cliColor(defStatus.id) }} />
                {defStatus.name}
                <span className={cn('ml-auto text-xs', defStatus.installed ? 'text-success' : 'text-subtle')}>
                  {defStatus.installed
                    ? t('可用 · {version}', { version: shortVersion(defStatus.version) })
                    : t('未安装')}
                </span>
              </div>
            ) : (
              clis.length > 0 && (
                <button
                  onClick={() => openSettings(`cli:${cliToEnable(clis, settings).id}`)}
                  className="cursor-pointer text-left text-[0.8125rem] text-accent hover:underline"
                >
                  {t('还没有启用 Agent，去设置里启用')}
                </button>
              )
            )}
          </div>
        }
      >
        <div className="px-1 pb-2">
          <Segmented
            label={t('按什么分组')}
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { id: 'tag', label: t('按标签') },
              { id: 'category', label: t('按分类') },
            ]}
          />
        </div>
        <TagFilter value={tag} onChange={setTag} used={[...new Set(agents.flatMap((a) => a.tags))]} />
        {groupBy === 'tag'
          ? tagGroups.map((g) => {
              // 标签名是用户起的，不过翻译（碰上和界面文案同名的标签会被译掉）。
              // 内置的「无标签」组固定加一句说明：用户也能建一个名叫「默认」的标签，
              // 两组都叫「默认」就分不清哪一组是没打标签的角色。
              const name = g.tag ? g.label : t('默认（没有标签）')
              return (
                <ListGroup
                  key={g.id}
                  groupId={g.id}
                  label={name}
                  header={
                    <GroupHeader label={<TagCountChip name={name} count={g.agents.length} color={g.tag?.color} />} />
                  }
                >
                  {g.agents.map((a) => row(a))}
                </ListGroup>
              )
            })
          : categoryGroups.map((g) => (
              <ListGroup
                key={g.id || 'none'}
                header={
                  g.category ? (
                    <CategoryHeader
                      category={g.category}
                      count={g.items.length}
                      onAdd={() => create({ categoryId: g.id })}
                    />
                  ) : (
                    <GroupHeader label={g.id === CORE_GROUP ? t('必备') : t('未分类')} count={g.items.length} />
                  )
                }
              >
                {g.items.map((a) => row(a))}
              </ListGroup>
            ))}
        {!loading && agents.length > 0 && shownGroups.length === 0 && <ListEmpty>{t('没有匹配的角色')}</ListEmpty>}
        {/* 只有必备角色时（自带工作流和它们的角色都被删掉了）提示可以添加内置的 */}
        {!loading && !query && !tag && agents.every(isCoreAgent) && (
          <ListEmpty>
            <p>{t('还可以添加整理好的内置角色')}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setBuiltin(true)}>
              <LayoutTemplate className="h-4 w-4" />
              {t('添加内置角色')}
            </Button>
          </ListEmpty>
        )}
      </ListPane>

      {selected ? (
        <AgentDetail
          key={`${selected.id}:${rev}`}
          agent={selected}
          onOptimized={() => setRev((r) => r + 1)}
          onDuplicate={() => duplicate(selected)}
          deleteSignal={delReq?.id === selected.id ? delReq.at : 0}
          onDeleted={() => go({ page: 'agents' })}
        />
      ) : (
        !loading && (
          <DetailEmpty icon={<Bot className="h-6 w-6" />} title={t('创建第一个角色')}>
            <p>{t('角色是「Agent + 模型 + 角色设定」的组合，可以按分类整理，之后在工作流里组队使用。')}</p>
            <Button className="mt-5" onClick={() => create()}>
              <Plus className="h-4 w-4" />
              {t('新建角色')}
            </Button>
          </DetailEmpty>
        )
      )}
      <BuiltinAgentsDialog open={builtin} onOpenChange={setBuiltin} onAdded={(a) => go({ page: 'agents', id: a.id })} />
      <AssistDialog
        open={assist}
        onOpenChange={setAssist}
        kind="agent"
        onApplied={({ agent }) => {
          setQuery('')
          if (agent) go({ page: 'agents', id: agent.id })
        }}
      />
    </>
  )
}
