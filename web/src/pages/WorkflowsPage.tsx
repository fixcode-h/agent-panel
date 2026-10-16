import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Sparkles, Workflow as WorkflowIcon } from 'lucide-react'
import type { Workflow, WorkflowInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { WorkflowDetail } from '@/components/workflows/WorkflowDetail'
import { AssistDialog } from '@/components/assist/AssistDialog'

export function WorkflowsPage() {
  const { loading, workflows, agents, clis, setWorkflows } = useData()
  const { route, go } = useNav()
  const [query, setQuery] = useState('')
  const [assist, setAssist] = useState(false)
  const [rev, setRev] = useState(0)

  const selected = workflows.find((w) => w.id === route.id) ?? workflows[0]
  useEffect(() => {
    if (!loading && selected && route.id !== selected.id) go({ page: 'workflows', id: selected.id })
  }, [loading, selected?.id])

  const q = query.trim().toLowerCase()
  const list = workflows.filter((w) => !q || `${w.name}${w.description}`.toLowerCase().includes(q))
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name

  const create = async (input: Partial<WorkflowInput> = {}) => {
    try {
      const w = await api.createWorkflow({
        name: '新工作流',
        description: '',
        mainAgentId: '',
        members: [],
        stages: [],
        document: '',
        ...input,
      })
      setWorkflows((ws) => [...ws, w])
      setQuery('')
      go({ page: 'workflows', id: w.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const duplicate = (w: Workflow) => {
    const { id, createdAt, updatedAt, ...rest } = w
    create({ ...rest, name: `${w.name} 副本` })
  }

  return (
    <>
      <ListPane
        title="工作流"
        count={workflows.length}
        onNew={() => create()}
        extra={
          <Button size="sm" variant="secondary" onClick={() => setAssist(true)} title="描述需求，让本机 CLI 生成工作流">
            <Sparkles className="h-4 w-4 text-accent" />
            AI 创建
          </Button>
        }
        query={query}
        onQuery={setQuery}
        placeholder="搜索工作流"
      >
        {list.map((w) => (
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
            subtitle={`${nameOf(w.mainAgentId) ?? '未选主 Agent'} · ${w.members.length} 个子 Agent`}
            trailing={
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  isReady(workflowChecks(w, agents, clis)) ? 'bg-success' : 'bg-warning',
                )}
              />
            }
          />
        ))}
        {!loading && workflows.length > 0 && list.length === 0 && <ListEmpty>没有匹配的工作流</ListEmpty>}
        {!loading && workflows.length === 0 && <ListEmpty>还没有工作流</ListEmpty>}
      </ListPane>

      {selected ? (
        <WorkflowDetail
          key={`${selected.id}:${rev}`}
          workflow={selected}
          onOptimized={() => setRev((r) => r + 1)}
          onDuplicate={() => duplicate(selected)}
          onDeleted={() => go({ page: 'workflows' })}
        />
      ) : (
        !loading && (
          <DetailEmpty icon={<WorkflowIcon className="h-6 w-6" />} title="创建第一个工作流">
            <p>工作流把 Agent 组成团队：选一个主 Agent 负责推进，再加几个子 Agent，然后在流程图里编排执行顺序。</p>
            <Button className="mt-5" onClick={() => create()}>
              <Plus className="h-4 w-4" />
              新建工作流
            </Button>
          </DetailEmpty>
        )
      )}
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
