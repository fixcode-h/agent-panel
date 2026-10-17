import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Bot, Copy, MoreHorizontal, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { DEFAULT_AGENT_ID, type Agent, type AgentInput, type Category } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cliColor, shortVersion } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ContextMenuItem, ContextMenuSeparator, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentDetail } from '@/components/agents/AgentDetail'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { useAgentView } from '@/lib/agent-view'
import { t } from '@shared/i18n'

/** 「默认」分类的分组 id，和用户分类的 id 不会冲突 */
const DEFAULT_GROUP = '#default'

function CategoryHeader({ category, count, onAdd }: { category: Category; count: number; onAdd: () => void }) {
  const { setCategories, setAgents } = useData()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(category.name)
  const [deleting, setDeleting] = useState(false)

  const rename = async () => {
    setEditing(false)
    const n = name.trim()
    if (!n || n === category.name) return setName(category.name)
    try {
      const c = await api.renameCategory(category.id, n)
      setCategories((cs) => cs.map((x) => (x.id === c.id ? c : x)))
    } catch (e) {
      toast.error((e as Error).message)
      setName(category.name)
    }
  }

  const remove = async () => {
    try {
      await api.deleteCategory(category.id)
      setCategories((cs) => cs.filter((x) => x.id !== category.id))
      setAgents((as) => as.map((a) => (a.categoryId === category.id ? { ...a, categoryId: '' } : a)))
      toast.success(t('已删除分类「{name}」', { name: category.name }))
    } catch (e) {
      toast.error((e as Error).message)
    }
    setDeleting(false)
  }

  if (editing)
    return (
      <div className="flex h-9 items-center px-2 pt-2">
        <input
          autoFocus
          aria-label={t('分类名称')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename()
            if (e.key === 'Escape') {
              setName(category.name)
              setEditing(false)
            }
          }}
          className="h-7 w-full rounded-md border border-accent bg-field px-2 text-xs text-fg outline-none"
        />
      </div>
    )

  return (
    <>
      <GroupHeader
        label={category.name}
        count={count}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('在此分类新建 Agent')}
              title={t('在此分类新建 Agent')}
              onClick={onAdd}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('分类操作')} title={t('分类操作')}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('重命名')}
                </MenuItem>
                <MenuItem danger onSelect={() => setDeleting(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('删除分类')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除分类「{name}」？', { name: category.name })}
        description={t('分类里的 Agent 不会被删除，会移到「未分类」。')}
        onConfirm={remove}
      />
    </>
  )
}

export function AgentsPage() {
  const { cliName, cliOf, modelOf } = useAgentView()
  const { loading, agents, categories, clis, setAgents, refreshClis } = useData()
  const { route, go } = useNav()
  const [query, setQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const [assist, setAssist] = useState(false)
  const [rev, setRev] = useState(0)
  // 列表右键「删除」：先选中那个 Agent，再让详情页弹出删除确认（确认框和被引用的检查都在详情页里）
  const [delReq, setDelReq] = useState<{ id: string; at: number }>()

  const selected = agents.find((a) => a.id === route.id) ?? agents[0]
  useEffect(() => {
    if (!loading && selected && route.id !== selected.id) go({ page: 'agents', id: selected.id })
    // 地址里的 id 不存在（例如已删除）时也要换成第一个；go 每次渲染都是新的，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected?.id, route.id])

  const q = query.trim().toLowerCase()
  const match = (a: Agent) => !q || `${a.name}${a.description}${modelOf(a)}`.toLowerCase().includes(q)
  // 自带的默认 Agent 单独放在最上面的「默认」分类，不跟着用户的分类走
  const groups = [
    {
      category: null as Category | null,
      id: DEFAULT_GROUP,
      items: agents.filter((a) => a.id === DEFAULT_AGENT_ID && match(a)),
    },
    ...[...categories.map((c) => ({ category: c as Category | null, id: c.id })), { category: null, id: '' }].map(
      (g) => ({ ...g, items: agents.filter((a) => a.id !== DEFAULT_AGENT_ID && a.categoryId === g.id && match(a)) }),
    ),
  ]
    // 搜索时隐藏空分类；「默认」「未分类」为空时也不显示
    .filter((g) => g.items.length || (!q && g.category))

  const create = async (input: Partial<AgentInput> = {}) => {
    try {
      const a = await api.createAgent({
        name: t('新 Agent'),
        description: '',
        cli: '',
        model: '@medium',
        effort: '',
        categoryId: selected?.id === DEFAULT_AGENT_ID ? '' : (selected?.categoryId ?? ''),
        icon: 'bot',
        instructions: '',
        permission: '',
        extraArgs: [],
        enabled: true,
        ...input,
      })
      setAgents((as) => [...as, a])
      setQuery('')
      go({ page: 'agents', id: a.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const duplicate = (a: Agent) => {
    const { id, createdAt, updatedAt, ...rest } = a
    create({ ...rest, name: t('{name} 副本', { name: a.name }) })
  }

  const recheck = async () => {
    setChecking(true)
    await refreshClis()
      .catch((e) => toast.error(t('检测失败：{error}', { error: (e as Error).message })))
      .finally(() => setChecking(false))
  }

  const status = (a: Agent) => {
    const installed = clis.find((c) => c.id === cliOf(a))?.installed
    return !a.enabled ? 'bg-line-strong' : installed ? 'bg-success' : 'bg-warning'
  }

  return (
    <>
      <ListPane
        title="Agent"
        count={agents.length}
        onNew={() => create()}
        extra={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAssist(true)}
            title={t('描述需求，让本机 CLI 生成 Agent')}
          >
            <Sparkles className="h-4 w-4 text-accent" />
            {t('AI 创建')}
          </Button>
        }
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索名称、简介或模型')}
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex items-center text-xs text-subtle">
              {t('本机 CLI')}
              <button
                onClick={recheck}
                disabled={checking}
                className="ml-auto flex cursor-pointer items-center gap-1 text-accent"
              >
                <RefreshCw className={cn('h-3 w-3', checking && 'animate-spin')} />
                {t('重新检测')}
              </button>
            </div>
            {clis.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[13px]" title={c.version}>
                <span className="h-2 w-2 rounded-[2px]" style={{ background: cliColor(c.id) }} />
                {c.name}
                <span className={cn('ml-auto text-xs', c.installed && c.enabled ? 'text-success' : 'text-subtle')}>
                  {!c.installed
                    ? t('未安装')
                    : c.enabled
                      ? t('可用 · {version}', { version: shortVersion(c.version) })
                      : t('已停用')}
                </span>
              </div>
            ))}
          </div>
        }
      >
        {groups.map((g) => (
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
                <GroupHeader label={g.id === DEFAULT_GROUP ? t('默认') : t('未分类')} count={g.items.length} />
              )
            }
          >
            {g.items.map((a) => (
              <ListItem
                key={a.id}
                selected={a.id === selected?.id}
                onClick={() => go({ page: 'agents', id: a.id })}
                leading={<AgentAvatar icon={a.icon} cli={a.cli} dim={!a.enabled} />}
                title={a.name}
                subtitle={`${cliName(a)} · ${modelOf(a)}`}
                trailing={<span className={cn('h-2 w-2 shrink-0 rounded-full', status(a))} />}
                menu={
                  <>
                    <ContextMenuItem onSelect={() => duplicate(a)}>
                      <Copy className="h-4 w-4" />
                      {t('复制一份')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      danger
                      disabled={a.id === DEFAULT_AGENT_ID}
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
            ))}
            {g.items.length === 0 && <p className="px-2.5 pb-1 text-xs text-subtle">{t('这个分类还没有 Agent')}</p>}
          </ListGroup>
        ))}
        {!loading && agents.length > 0 && groups.length === 0 && <ListEmpty>{t('没有匹配的 Agent')}</ListEmpty>}
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
          <DetailEmpty icon={<Bot className="h-6 w-6" />} title={t('创建第一个 Agent')}>
            <p>{t('Agent 是「CLI + 模型 + 角色设定」的组合，可以按分类整理，之后在工作流里组队使用。')}</p>
            <Button className="mt-5" onClick={() => create()}>
              <Plus className="h-4 w-4" />
              {t('新建 Agent')}
            </Button>
          </DetailEmpty>
        )
      )}
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
