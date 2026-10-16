import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, Crown, GitBranch, Settings2, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import type { Agent, Workflow, WorkflowInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { docTemplate } from '@/lib/workflow-doc'
import { StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input } from '@/components/ui/input'
import { Detail, DetailHeader, DetailTabs } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { TeamEditor } from './TeamEditor'
import { DocEditor } from './DocEditor'
import { FlowEditor } from '@/components/flow/FlowEditor'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Workflow): WorkflowInput => rest

export function WorkflowDetail({
  workflow,
  onDuplicate,
  onDeleted,
}: {
  workflow: Workflow
  onDuplicate: () => void
  onDeleted: () => void
}) {
  const { agents, clis, setWorkflows } = useData()
  const { go } = useNav()
  const [draft, setDraft] = useState<WorkflowInput>(() => toInput(workflow))
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<'flow' | 'settings'>(() => (workflow.mainAgentId ? 'flow' : 'settings'))
  const valid = !!draft.name.trim()
  const save = useAutosave(
    draft,
    async (v) => {
      const saved = await api.updateWorkflow(workflow.id, v)
      setWorkflows((ws) => ws.map((w) => (w.id === saved.id ? saved : w)))
    },
    valid,
  )
  const set = <K extends keyof WorkflowInput>(k: K, v: WorkflowInput[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(draft.mainAgentId)
  const team = draft.members
    .map((m) => ({ agent: byId.get(m.agentId), responsibility: m.responsibility }))
    .filter((m): m is { agent: Agent; responsibility: string } => !!m.agent)
  const checks = workflowChecks({ ...workflow, ...draft }, agents, clis)
  const nodeCount = draft.stages.reduce((n, s) => n + s.nodes.length, 0)

  const remove = async () => {
    try {
      await api.deleteWorkflow(workflow.id)
      setWorkflows((ws) => ws.filter((w) => w.id !== workflow.id))
      toast.success(`已删除「${workflow.name}」`)
      onDeleted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Detail
        header={
          <DetailHeader
            leading={
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent text-white">
                <WorkflowIcon className="h-6 w-6" strokeWidth={1.8} />
              </span>
            }
            title={draft.name || '未命名工作流'}
            meta={isReady(checks) ? <StatusDot tone="success" label="就绪" /> : <StatusDot tone="warning" label="未就绪" />}
            subtitle={draft.description || '还没有简介'}
            save={{ ...save, invalid: valid ? undefined : '名称为空，未保存' }}
            actions={
              <>
                <Button variant="secondary" size="icon" aria-label="复制" title="复制" onClick={onDuplicate}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button variant="danger-outline" size="icon" aria-label="删除" title="删除" onClick={() => setDeleting(true)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            }
          />
        }
        tabs={
          <DetailTabs
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'flow',
                label: '流程图',
                icon: GitBranch,
                extra: <span className="font-mono text-xs font-normal text-subtle">{nodeCount}</span>,
              },
              { id: 'settings', label: '团队与说明', icon: Settings2 },
            ]}
          />
        }
        body={
          tab === 'flow' ? (
            <div className="px-4 pt-5 pb-10 md:px-8">
              <FlowEditor
                stages={draft.stages}
                onChange={(s) => set('stages', s)}
                main={main}
                team={team}
                overview={<ReadinessCard checks={checks} />}
              />
            </div>
          ) : undefined
        }
        form={
          <>
            <FormSection title="基本信息">
              <div className="flex flex-wrap gap-4">
                <Field label="名称" className="flex-[1_1_200px]" error={valid ? undefined : '名称不能为空'}>
                  <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：Web 功能开发" />
                </Field>
                <Field label="简介" className="flex-[2_1_280px]">
                  <Input
                    value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder="适合什么样的任务"
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection title="团队">
              <TeamEditor
                mainAgentId={draft.mainAgentId}
                members={draft.members}
                onMainChange={(id) => set('mainAgentId', id)}
                onMembersChange={(m) => set('members', m)}
              />
            </FormSection>

            <FormSection title="工作流说明">
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                写清楚目标、规范和完成标准。执行每个节点时都会把这份说明发给 Agent；具体每一步做什么在「流程图」里编辑。
              </p>
              <DocEditor
                value={draft.document}
                onChange={(v) => set('document', v)}
                team={[...(main ? [main] : []), ...team.map((t) => t.agent)]}
                onTemplate={() => docTemplate(main, team)}
              />
            </FormSection>
          </>
        }
        aside={
          <>
            <section className="rounded-xl border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-semibold">团队结构</h3>
              {main ? (
                <button
                  onClick={() => go({ page: 'agents', id: main.id })}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg bg-accent-soft p-2 text-left"
                >
                  <AgentAvatar icon={main.icon} cli={main.cli} size="sm" dim={!main.enabled} />
                  <span className="flex-1 truncate text-[13px] font-medium">{main.name}</span>
                  <Crown className="h-3.5 w-3.5 text-accent" />
                </button>
              ) : (
                <p className="rounded-lg border border-dashed p-2 text-xs text-subtle">还没有主 Agent</p>
              )}
              <div className="mt-1 ml-5 flex flex-col gap-0.5 border-l border-line-strong pt-1 pl-3">
                {team.map(({ agent: a, responsibility }) => (
                  <button
                    key={a.id}
                    title={responsibility || undefined}
                    onClick={() => go({ page: 'agents', id: a.id })}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-sel hover:text-fg"
                  >
                    <AgentAvatar icon={a.icon} cli={a.cli} size="xs" dim={!a.enabled} />
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
                {team.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">还没有子 Agent</p>}
              </div>
            </section>

            <ReadinessCard checks={checks} />

          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${workflow.name}」？`}
        description="团队里的 Agent 不会被删除。此操作无法撤销。"
        onConfirm={remove}
      />
    </>
  )
}
