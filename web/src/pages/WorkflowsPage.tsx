import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Copy, Download, LayoutTemplate, Plus, Sparkles, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-react'
import type { Category, Workflow, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { newFlow, subAgentIds } from '@shared/flow'
import { isDefaultWorkflow } from '@shared/builtin/default'
import { api } from '@/lib/api'
import { exportWorkflow } from '@/lib/transfer'
import { useShareImport } from '@/lib/useShareImport'
import { ImportConflictDialog } from '@/components/share/ImportConflictDialog'
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

/** 「默认」分类的分组 id，和用户分类的 id 不会冲突 */
const DEFAULT_GROUP = '#default'

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
  // 自带的「默认」工作流单独放在最上面的「默认」分类，不跟着用户的分类走
  const groups = [
    { category: null as Category | null, id: DEFAULT_GROUP, items: list.filter((w) => isDefaultWorkflow(w.id)) },
    ...[...categories.map((c) => ({ category: c as Category | null, id: c.id })), { category: null, id: '' }].map(
      (g) => ({
        ...g,
        items: list.filter((w) => !isDefaultWorkflow(w.id) && (known.has(w.categoryId) ? w.categoryId : '') === g.id),
      }),
    ),
  ].filter((g) => g.items.length || (!q && !tag && g.category))
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
        expose: [],
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
  // 导入：格式和指纹在 importShare 里校验，同名时弹「覆盖 / 另存为副本」
  const share = useShareImport('workflow', (r) => {
    void api.workflows().then(setWorkflows)
    if (r.created.length) setAgents((as) => [...as, ...r.created])
    go({ page: 'workflows', id: r.id })
    toast.success(
      r.created.length
        ? t('已导入「{name}」，新建了 {n} 个角色：{list}', {
            name: r.name,
            n: r.created.length,
            list: r.created.map((a) => a.name).join(t('、')),
          })
        : t('已导入「{name}」', { name: r.name }),
    )
  })

  // 列表右键「删除」：先选中那个工作流，再让详情页弹出删除确认（被项目使用时不能删的检查在详情页里）
  const [delReq, setDelReq] = useState<{ id: string; at: number }>()

  const duplicate = (w: Workflow) => {
    // 复制出来的是自己的，不再算内置的
    const { id, createdAt, updatedAt, origin, ...rest } = w
    create({ ...rest, name: t('{name} 副本', { name: w.name }) })
  }

  return (
    <>
      <ListPane
        title={t('工作流')}
        count={workflows.length}
        onNew={() => create()}
        // 窄栏里按钮都收成图标，「工作流」标题才不被挤得截断
        compactNew
        extra={
          <>
            <Menu>
              <MenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="secondary"
                  aria-label={t('添加内置或导入的工作流')}
                  title={t('添加内置或导入的工作流')}
                >
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
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={share.onFile} />
            <Button
              size="icon-sm"
              variant="secondary"
              onClick={() => setAssist(true)}
              aria-label={t('AI 创建工作流')}
              title={t('描述需求，让本机 Agent 生成工作流')}
            >
              <Sparkles className="h-4 w-4 text-accent-text" />
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
                <GroupHeader label={g.id === DEFAULT_GROUP ? t('默认') : t('未分类')} count={g.items.length} />
              )
            }
          >
            {g.items.map((w) => (
              <ListItem
                key={w.id}
                selected={w.id === selected?.id}
                onClick={() => go({ page: 'workflows', id: w.id })}
                leading={
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent-text">
                    <WorkflowIcon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </span>
                }
                title={w.name}
                monoSubtitle={false}
                subtitle={`${nameOf(w.mainAgentId) ?? t('直接用 Agent')} · ${t('{n} 个子角色', { n: subAgentIds(w).length })}`}
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
                    {!isDefaultWorkflow(w.id) && (
                      <>
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
                    )}
                  </>
                }
              />
            ))}
            {g.items.length === 0 && <p className="px-2.5 pb-1 text-xs text-subtle">{t('这个分类还没有工作流')}</p>}
          </ListGroup>
        ))}
        {!loading && workflows.length > 0 && list.length === 0 && <ListEmpty>{t('没有匹配的工作流')}</ListEmpty>}
        {/* 只剩自带的「默认」工作流时（自带工作流都被删掉了）提示可以重新添加：推荐下一步时只会推荐已有的 */}
        {!loading && !query && !tag && workflows.every((w) => isDefaultWorkflow(w.id)) && (
          <ListEmpty>
            <p>{t('自带的工作流都被删掉了，可以从内置工作流里重新添加，「默认」工作流做完后会推荐用它们接着做')}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setBuiltin(true)}>
              <LayoutTemplate className="h-4 w-4" />
              {t('添加内置工作流')}
            </Button>
          </ListEmpty>
        )}
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
            <p>{t('工作流把角色组成团队：选一个主角色负责推进，再加几个子角色，然后在流程图里编排执行顺序。')}</p>
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
      <ImportConflictDialog conflict={share.conflict} onPick={share.pick} onClose={share.close} />
    </>
  )
}
