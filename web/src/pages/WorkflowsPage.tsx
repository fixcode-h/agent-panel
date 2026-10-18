import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Download, LayoutTemplate, Plus, Sparkles, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-react'
import type { Category, Workflow, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { newFlow } from '@shared/flow'
import { api } from '@/lib/api'
import { exportWorkflow, importWorkflow } from '@/lib/transfer'
import { useData, useNav } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/badge'
import { ContextMenuItem, ContextMenuSeparator, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { CategoryHeader } from '@/components/agents/CategoryHeader'
import { TagFilter, TagList } from '@/components/tags/Tags'
import { DetailEmpty } from '@/components/layout/Detail'
import { WorkflowDetail } from '@/components/workflows/WorkflowDetail'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { BuiltinDialog } from '@/components/workflows/BuiltinDialog'

export function WorkflowsPage() {
  const { loading, workflows, agents, clis, categories: allCategories, tags, setWorkflows, setAgents } = useData()
  const categories = allCategories.filter((c) => c.scope === 'workflow')
  const [tag, setTag] = useState('')
  const { route, go } = useNav()
  const [query, setQuery] = useState('')
  const [assist, setAssist] = useState(false)
  const [builtin, setBuiltin] = useState(false)
  const [rev, setRev] = useState(0)

  const selected = workflows.find((w) => w.id === route.id) ?? workflows[0]
  useEffect(() => {
    if (!loading && selected && route.id !== selected.id) go({ page: 'workflows', id: selected.id })
    // 地址里的 id 不存在（例如已删除）时也要换成第一个；go 每次渲染都是新的，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected?.id, route.id])

  const q = query.trim().toLowerCase()
  const tagNames = (ids: string[]) => ids.map((id) => tags.find((x) => x.id === id)?.name ?? '').join(' ')
  const list = workflows.filter(
    (w) =>
      (!tag || w.tags.includes(tag)) &&
      (!q || `${w.name}${w.description}${tagNames(w.tags)}`.toLowerCase().includes(q)),
  )
  // 按分类分组；分类删掉后残留的 id 归到「未分类」
  const known = new Set(categories.map((c) => c.id))
  const groups = [...categories.map((c) => ({ category: c as Category | null, id: c.id })), { category: null, id: '' }]
    .map((g) => ({
      ...g,
      items: list.filter((w) => (known.has(w.categoryId) ? w.categoryId : '') === g.id),
    }))
    .filter((g) => g.items.length || (!q && !tag && g.category))
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name

  const create = async (input: Partial<WorkflowInput> = {}) => {
    try {
      const w = await api.createWorkflow({
        name: t('新工作流'),
        description: '',
        mainAgentId: '',
        members: [],
        flows: [newFlow(t('主流程'), 'main')],
        entryFlowId: 'main',
        document: '',
        categoryId: selected?.categoryId ?? '',
        tags: [],
        ...input,
      })
      setWorkflows((ws) => [...ws, w])
      setQuery('')
      go({ page: 'workflows', id: w.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const file = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const { workflow, created } = await importWorkflow(await f.text(), agents, workflows)
      if (created.length) setAgents((as) => [...as, ...created])
      setWorkflows((ws) => [...ws, workflow])
      go({ page: 'workflows', id: workflow.id })
      toast.success(
        created.length
          ? t('已导入「{name}」，新建了 {n} 个 Agent：{list}', {
              name: workflow.name,
              n: created.length,
              list: created.map((a) => a.name).join(t('、')),
            })
          : t('已导入「{name}」', { name: workflow.name }),
      )
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // 列表右键「删除」：先选中那个工作流，再让详情页弹出删除确认（被项目使用时不能删的检查在详情页里）
  const [delReq, setDelReq] = useState<{ id: string; at: number }>()

  const duplicate = (w: Workflow) => {
    const { id, createdAt, updatedAt, ...rest } = w
    create({ ...rest, name: t('{name} 副本', { name: w.name }) })
  }

  return (
    <>
      <ListPane
        title={t('工作流')}
        count={workflows.length}
        onNew={() => create()}
        extra={
          <>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="secondary" aria-label={t('添加内置或导入的工作流')}>
                  <LayoutTemplate className="h-4 w-4" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setBuiltin(true)}>
                  <LayoutTemplate className="h-4 w-4" />
                  {t('从内置工作流添加')}
                </MenuItem>
                <MenuItem onSelect={() => file.current?.click()}>
                  <Upload className="h-4 w-4" />
                  {t('导入工作流文件')}
                </MenuItem>
              </MenuContent>
            </Menu>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={onImport} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAssist(true)}
              title={t('描述需求，让本机 CLI 生成工作流')}
            >
              <Sparkles className="h-4 w-4 text-accent" />
              {t('AI 创建')}
            </Button>
          </>
        }
        query={query}
        onQuery={setQuery}
        placeholder={t('搜索名称、简介或标签')}
      >
        <TagFilter value={tag} onChange={setTag} used={[...new Set(workflows.flatMap((w) => w.tags))]} />
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
                <GroupHeader label={t('未分类')} count={g.items.length} />
              )
            }
          >
            {g.items.map((w) => (
              <ListItem
                key={w.id}
                selected={w.id === selected?.id}
                onClick={() => go({ page: 'workflows', id: w.id })}
                leading={
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent">
                    <WorkflowIcon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </span>
                }
                title={w.name}
                monoSubtitle={false}
                subtitle={`${nameOf(w.mainAgentId) ?? t('未选主 Agent')} · ${t('{n} 个子 Agent', { n: w.members.length })}`}
                tags={w.tags.length ? <TagList ids={w.tags} /> : undefined}
                // 只有一个点时看不出是什么意思（像是「连上了没有」），带上文字
                trailing={
                  <span className="shrink-0">
                    {isReady(workflowChecks(w, agents, clis, workflows)) ? (
                      <StatusDot tone="success" label={t('就绪')} />
                    ) : (
                      <StatusDot tone="warning" label={t('未就绪')} />
                    )}
                  </span>
                }
                menu={
                  <>
                    <ContextMenuItem onSelect={() => duplicate(w)}>
                      <Copy className="h-4 w-4" />
                      {t('复制一份')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => exportWorkflow(w, agents)}>
                      <Download className="h-4 w-4" />
                      {t('导出')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      danger
                      onSelect={() => {
                        go({ page: 'workflows', id: w.id })
                        setDelReq({ id: w.id, at: Date.now() })
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('删除')}
                    </ContextMenuItem>
                  </>
                }
              />
            ))}
            {g.items.length === 0 && <p className="px-2.5 pb-1 text-xs text-subtle">{t('这个分类还没有工作流')}</p>}
          </ListGroup>
        ))}
        {!loading && workflows.length > 0 && list.length === 0 && <ListEmpty>{t('没有匹配的工作流')}</ListEmpty>}
        {!loading && workflows.length === 0 && <ListEmpty>{t('还没有工作流')}</ListEmpty>}
      </ListPane>

      {selected ? (
        <WorkflowDetail
          key={`${selected.id}:${rev}`}
          workflow={selected}
          onOptimized={() => setRev((r) => r + 1)}
          onDuplicate={() => duplicate(selected)}
          deleteSignal={delReq?.id === selected.id ? delReq.at : 0}
          onDeleted={() => go({ page: 'workflows' })}
        />
      ) : (
        !loading && (
          <DetailEmpty icon={<WorkflowIcon className="h-6 w-6" />} title={t('创建第一个工作流')}>
            <p>
              {t('工作流把 Agent 组成团队：选一个主 Agent 负责推进，再加几个子 Agent，然后在流程图里编排执行顺序。')}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button onClick={() => create()}>
                <Plus className="h-4 w-4" />
                {t('新建工作流')}
              </Button>
              <Button variant="secondary" onClick={() => setBuiltin(true)}>
                <LayoutTemplate className="h-4 w-4" />
                {t('从内置工作流添加')}
              </Button>
            </div>
          </DetailEmpty>
        )
      )}
      <BuiltinDialog
        open={builtin}
        onOpenChange={setBuiltin}
        onAdded={(w) => {
          setBuiltin(false)
          setQuery('')
          setTag('')
          go({ page: 'workflows', id: w.id })
        }}
      />
      <AssistDialog
        open={assist}
        onOpenChange={setAssist}
        kind="workflow"
        onApplied={({ workflow }) => {
          setQuery('')
          if (workflow) go({ page: 'workflows', id: workflow.id })
        }}
      />
    </>
  )
}
