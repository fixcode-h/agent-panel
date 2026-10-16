import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Crown, Download, GitBranch, Settings2, Sparkles, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import { exportWorkflow } from '@/lib/transfer'
import type { Agent, Workflow, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { docTemplate } from '@/lib/workflow-doc'
import { StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AssistDialog } from '@/components/assist/AssistDialog'
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
  deleteSignal = 0,
  onOptimized,
  onFlowTab,
  list,
}: {
  workflow: Workflow
  onDuplicate: () => void
  onDeleted: () => void
  /** 列表右键「删除」时变化，打开删除确认 */
  deleteSignal?: number
  /** AI 优化写回后让页面重新加载草稿 */
  onOptimized: () => void
  /** 切到 / 离开流程图：页面据此收起工作流列表 */
  onFlowTab?: (flow: boolean) => void
  /** 工作流列表的收起状态，流程图工具栏上可以切换 */
  list?: { open: boolean; toggle: () => void }
}) {
  const { agents, clis, workflows, setWorkflows, projects, projectCategories } = useData()
  const usedBy = [
    ...projectCategories
      .filter((c) => c.workflowId === workflow.id)
      .map((c) => t('项目分类「{name}」', { name: c.name })),
    ...projects.filter((p) => p.workflowId === workflow.id).map((p) => t('项目「{name}」', { name: p.name })),
  ]
  const { go } = useNav()
  const [draft, setDraft] = useState<WorkflowInput>(() => toInput(workflow))
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (deleteSignal) setDeleting(true)
  }, [deleteSignal])
  const [assist, setAssist] = useState(false)
  const [tab, setTab] = useState<'flow' | 'settings'>(() => (workflow.mainAgentId ? 'flow' : 'settings'))
  useEffect(() => {
    onFlowTab?.(tab === 'flow')
    return () => onFlowTab?.(false)
    // 父组件每次渲染都传新的函数，只在切换标签时通知
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
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
  const checks = workflowChecks({ ...workflow, ...draft }, agents, clis, workflows)
  const nodeCount = draft.flows.reduce((n, f) => n + f.nodes.length, 0)

  const remove = async () => {
    try {
      await api.deleteWorkflow(workflow.id)
      setWorkflows((ws) => ws.filter((w) => w.id !== workflow.id))
      toast.success(t('已删除「{name}」', { name: workflow.name }))
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
            title={draft.name || t('未命名工作流')}
            meta={
              isReady(checks) ? (
                <StatusDot tone="success" label={t('就绪')} />
              ) : (
                <StatusDot tone="warning" label={t('未就绪')} />
              )
            }
            subtitle={draft.description || t('还没有简介')}
            save={{ ...save, invalid: valid ? undefined : t('名称为空，未保存') }}
            actions={
              <>
                <Button variant="secondary" onClick={() => setAssist(true)} title={t('让本机 CLI 按你的要求优化')}>
                  <Sparkles className="h-4 w-4 text-accent" />
                  {t('AI 优化')}
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t('复制一份')}
                  title={t('复制一份')}
                  onClick={onDuplicate}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t('导出')}
                  title={t('导出成文件（连同用到的 Agent），可以在别的电脑上导入')}
                  onClick={() => exportWorkflow({ ...workflow, ...draft }, agents)}
                >
                  <Download className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger-outline"
                  size="icon"
                  aria-label={t('删除')}
                  title={t('删除')}
                  onClick={() => setDeleting(true)}
                >
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
                label: t('流程图'),
                icon: GitBranch,
                extra: <span className="font-mono text-xs font-normal text-subtle">{nodeCount}</span>,
              },
              { id: 'settings', label: t('团队与说明'), icon: Settings2 },
            ]}
          />
        }
        body={
          tab === 'flow' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <FlowEditor
                w={{ ...draft, id: workflow.id }}
                onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
                main={main}
                team={team}
                checks={checks}
                list={list}
              />
            </div>
          ) : undefined
        }
        form={
          <>
            <FormSection title={t('基本信息')}>
              <div className="flex flex-wrap gap-4">
                <Field label={t('名称')} className="flex-[1_1_200px]" error={valid ? undefined : t('名称不能为空')}>
                  <Input
                    value={draft.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder={t('例如：Web 功能开发')}
                  />
                </Field>
                <Field label={t('简介')} className="flex-[2_1_280px]">
                  <Input
                    value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder={t('适合什么样的任务')}
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection title={t('团队')}>
              <TeamEditor
                mainAgentId={draft.mainAgentId}
                members={draft.members}
                onMainChange={(id) => set('mainAgentId', id)}
                onMembersChange={(m) => set('members', m)}
              />
            </FormSection>

            <FormSection title={t('预算上限')}>
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                {t(
                  '每次执行（新建任务、继续执行、追加要求）超过上限就暂停，免得验收来回循环一直花钱。点「继续执行」会再给一份同样的额度。留空表示不限。',
                )}
              </p>
              <div className="flex flex-wrap gap-4">
                <Field
                  label={t('花费（美元）')}
                  className="flex-[1_1_180px]"
                  hint={t('Codex 不报告花费，用 token 上限')}
                >
                  <BudgetInput value={draft.budgetUsd} decimals onChange={(v) => set('budgetUsd', v)} />
                </Field>
                <Field label={t('token（千）')} className="flex-[1_1_180px]" hint={t('输入和输出 token 合计')}>
                  <BudgetInput
                    value={draft.budgetTokens ? draft.budgetTokens / 1000 : 0}
                    onChange={(v) => set('budgetTokens', Math.round(v * 1000))}
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection title={t('工作流说明')}>
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                {t(
                  '写清楚目标、规范和完成标准。执行每个节点时都会把这份说明发给 Agent；具体每一步做什么在「流程图」里编辑。',
                )}
              </p>
              <DocEditor
                value={draft.document}
                onChange={(v) => set('document', v)}
                team={[...(main ? [main] : []), ...team.map((m) => m.agent)]}
                onTemplate={() => docTemplate(main, team)}
              />
            </FormSection>
          </>
        }
        aside={
          <>
            <section className="rounded-xl border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-semibold">{t('团队结构')}</h3>
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
                <p className="rounded-lg border border-dashed p-2 text-xs text-subtle">{t('还没有主 Agent')}</p>
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
                {team.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">{t('还没有子 Agent')}</p>}
              </div>
            </section>

            <ReadinessCard checks={checks} />
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除「{name}」？', { name: workflow.name })}
        description={t('团队里的 Agent 不会被删除。此操作无法撤销。')}
        blocked={
          usedBy.length ? t('正在被 {list} 使用，请先改用其他工作流。', { list: usedBy.join(t('、')) }) : undefined
        }
        onConfirm={remove}
      />
      <AssistDialog open={assist} onOpenChange={setAssist} kind="workflow" target={workflow} onApplied={onOptimized} />
    </>
  )
}

/** 预算的数字输入：空着表示不限（存 0） */
function BudgetInput({
  value,
  decimals,
  onChange,
}: {
  value: number | undefined
  decimals?: boolean
  onChange: (v: number) => void
}) {
  const [text, setText] = useState(value ? String(value) : '')
  return (
    <Input
      inputMode="decimal"
      value={text}
      placeholder={t('不限')}
      onChange={(e) => {
        const v = e.target.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, '')
        setText(v)
        const n = Number(v)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}
