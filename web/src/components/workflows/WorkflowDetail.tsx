import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  Activity,
  Copy,
  Crown,
  Download,
  GitBranch,
  Settings2,
  Sparkles,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { exportWorkflow } from '@/lib/transfer'
import type { Agent, Workflow, WorkflowExpose, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { startAnalysis } from '@/lib/task-transfer'
import { isDefaultWorkflow } from '@shared/builtin/default'
import { nodeSteps } from '@shared/flow'
import { api } from '@/lib/api'
import { useData, useNav, useTasks } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { docTemplate } from '@/lib/workflow-doc'
import { StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AssistDialog } from '@/components/assist/LazyAssistDialog'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Detail, DetailHeader, DetailTabs } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { TeamEditor } from './TeamEditor'
import { CategoryPicker } from '@/components/agents/CategoryPicker'
import { TagPicker } from '@/components/tags/Tags'
import { DocEditor } from './DocEditor'
import { FlowEditor } from '@/components/flow/FlowEditor'
import { AnalyzeDialog } from '@/components/tasks/Evolution'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Workflow): WorkflowInput => rest

export function WorkflowDetail({
  workflow,
  onDuplicate,
  onDeleted,
  deleteSignal = 0,
  onOptimized,
}: {
  workflow: Workflow
  onDuplicate: () => void
  onDeleted: () => void
  /** 列表右键「删除」时变化，打开删除确认 */
  deleteSignal?: number
  /** AI 优化写回后让页面重新加载草稿 */
  onOptimized: () => void
}) {
  const { agents, clis, workflows, setWorkflows, projects, projectCategories } = useData()
  const { tasks } = useTasks()
  // 这个工作流最近几次跑完（含失败、停止）的执行，「分析执行」交给 AI 看
  const runs = tasks
    .filter((tk) => tk.mode === 'workflow' && tk.workflowId === workflow.id && tk.status !== 'running')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
  const [analyzing, setAnalyzing] = useState(false)
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
  // 主角色可以不选（直接用 CLI），所以按有没有节点判断：刚新建的空工作流先填基本信息
  const [tab, setTab] = useState<'flow' | 'settings'>(() =>
    workflow.mainAgentId || workflow.flows.some((f) => f.nodes.length) ? 'flow' : 'settings',
  )
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
  // 子 Agent 在节点上选：节点用到的 Agent 加上旧版团队里写过职责的
  const team = [
    ...new Set([
      ...draft.members.map((m) => m.agentId),
      ...draft.flows.flatMap((f) => f.nodes.flatMap((n) => nodeSteps(n).map((s) => s.agentId))).filter(Boolean),
    ]),
  ]
    .filter((id) => id !== draft.mainAgentId)
    .map((id) => ({
      agent: byId.get(id),
      responsibility: draft.members.find((m) => m.agentId === id)?.responsibility ?? '',
    }))
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
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent text-on-accent">
                <WorkflowIcon className="h-6 w-6" strokeWidth={2.2} />
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
                <Button
                  variant="secondary"
                  disabled={!runs.length}
                  onClick={() => setAnalyzing(true)}
                  title={
                    runs.length
                      ? t('让 AI 分析最近 {n} 次执行的结果，给出优化建议，看过差异再应用', { n: runs.length })
                      : t('还没有执行记录')
                  }
                >
                  <Activity className="h-4 w-4" />
                  {t('分析执行')}
                </Button>
                <Button variant="secondary" onClick={() => setAssist(true)} title={t('让本机 Agent 按你的要求优化')}>
                  <Sparkles className="h-4 w-4 text-accent-text" />
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
                  title={t('导出成文件（连同用到的角色），可以在别的电脑上导入')}
                  onClick={() => exportWorkflow({ ...workflow, ...draft }, agents)}
                >
                  <Download className="h-4 w-4" />
                </Button>
                {!isDefaultWorkflow(workflow.id) && (
                  <Button
                    variant="danger-outline"
                    size="icon"
                    aria-label={t('删除')}
                    title={t('删除')}
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
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
                save={{ ...save, invalid: valid ? undefined : t('名称为空，未保存') }}
                prepare={async () => {
                  // 自动保存有 400ms 的延迟：刚改完就运行时先存一次，任务用的是最新的流程图
                  if (!valid) throw new Error(t('名称为空，未保存'))
                  const saved = await api.updateWorkflow(workflow.id, draft)
                  setWorkflows((ws) => ws.map((w) => (w.id === saved.id ? saved : w)))
                }}
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
                <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                  <span className="text-xs text-muted">{t('分类')}</span>
                  <CategoryPicker scope="workflow" value={draft.categoryId} onChange={(id) => set('categoryId', id)} />
                </div>
              </div>
              <Field label={t('简介')}>
                <Input
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder={t('适合什么样的任务')}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">{t('标签')}</span>
                <TagPicker value={draft.tags} onChange={(v) => set('tags', v)} />
              </div>
            </FormSection>

            <FormSection title={t('角色分工')}>
              <TeamEditor
                mainAgentId={draft.mainAgentId}
                onMainChange={(id) => set('mainAgentId', id)}
                team={team}
                dispatch={draft.dispatch !== false}
                onDispatchChange={(v) => set('dispatch', v)}
                mainTier={draft.mainTier ?? ''}
                onMainTierChange={(v) => set('mainTier', v)}
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
                  '写清楚目标、规范和完成标准。执行每个节点时都会把这份说明发给角色；具体每一步做什么在「流程图」里编辑。',
                )}
              </p>
              <DocEditor
                value={draft.document}
                onChange={(v) => set('document', v)}
                team={[...(main ? [main] : []), ...team.map((m) => m.agent)]}
                onTemplate={() => docTemplate(main, team)}
              />
            </FormSection>

            <FormSection title={t('项目配置项')}>
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                {t(
                  '项目用这个工作流时，可以在项目设置里填这些值。新建对话时解析一次写进任务，之后改设置不影响已经开始的对话。',
                )}
              </p>
              <ExposeEditor value={draft.expose} agents={agents} onChange={(v) => set('expose', v)} />
            </FormSection>
          </>
        }
        aside={
          <>
            <Card as="section" padding="md">
              <h3 className="mb-3 text-body font-semibold">{t('团队结构')}</h3>
              {main ? (
                <button
                  onClick={() => go({ page: 'agents', id: main.id })}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg bg-accent-soft p-2 text-left"
                >
                  <AgentAvatar icon={main.icon} cli={main.cli} size="sm" dim={!main.enabled} />
                  <span className="flex-1 truncate text-body font-medium">{main.name}</span>
                  <Crown className="h-3.5 w-3.5 text-accent-text" />
                </button>
              ) : (
                <EmptyPanel className="rounded-lg p-2 text-xs">{t('还没有主角色')}</EmptyPanel>
              )}
              <div className="mt-1 ml-5 flex flex-col gap-0.5 border-l border-line-strong pt-1 pl-3">
                {team.map(({ agent: a, responsibility }) => (
                  <button
                    key={a.id}
                    title={responsibility || undefined}
                    onClick={() => go({ page: 'agents', id: a.id })}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body text-muted hover:bg-sel hover:text-fg"
                  >
                    <AgentAvatar icon={a.icon} cli={a.cli} size="xs" dim={!a.enabled} />
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
                {team.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">{t('还没有子角色')}</p>}
              </div>
            </Card>

            <ReadinessCard checks={checks} />
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除「{name}」？', { name: workflow.name })}
        description={t('团队里的角色不会被删除。此操作无法撤销。')}
        blocked={
          usedBy.length ? t('正在被 {list} 使用，请先改用其他工作流。', { list: usedBy.join(t('、')) }) : undefined
        }
        onConfirm={remove}
      />
      <AssistDialog open={assist} onOpenChange={setAssist} kind="workflow" target={workflow} onApplied={onOptimized} />
      <AnalyzeDialog
        open={analyzing}
        onOpenChange={setAnalyzing}
        subject={t('{name} 最近 {n} 次执行', { name: workflow.name, n: runs.length })}
        start={async (focus) => {
          const list = await Promise.all(runs.map((r) => api.task(r.id)))
          if (!list.length) throw new Error(t('还没有可以分析的执行记录'))
          return startAnalysis({ tasks: list, agents, projectId: list[0].projectId, focus })
        }}
      />
    </>
  )
}

/**
 * 工作流的「项目配置项」编辑器：项目设置里哪些字段可以填、填了作用到哪。
 * 目标按项目实际用得到的分三类：技能槽（Agent 的 skills 里写 {{槽名}}）、Agent 参数、工作流说明。
 */
function ExposeEditor({
  value,
  agents,
  onChange,
}: {
  value: WorkflowExpose[]
  agents: Agent[]
  onChange: (v: WorkflowExpose[]) => void
}) {
  const kinds: { id: WorkflowExpose['target']; label: string; hint: string }[] = [
    { id: 'skill', label: t('技能槽'), hint: t('角色的 Skill 名写 {{槽名}}，这里选实际用哪个技能') },
    { id: 'agent', label: t('角色参数'), hint: t('覆盖节点上同名参数的值') },
    { id: 'document', label: t('工作流说明'), hint: t('把填的内容追加到工作流说明后面') },
  ]
  const patch = (i: number, p: Partial<WorkflowExpose>) => onChange(value.map((e, j) => (j === i ? { ...e, ...p } : e)))
  return (
    <div className="flex flex-col gap-3">
      {value.map((e, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl bg-sel/40 p-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="h-9 flex-[1_1_120px]"
              value={e.key}
              placeholder={t('名字，例如 projectStructure')}
              onChange={(ev) => patch(i, { key: ev.target.value })}
            />
            <Input
              className="h-9 flex-[1_1_120px]"
              value={e.label}
              placeholder={t('显示的名字')}
              onChange={(ev) => patch(i, { label: ev.target.value })}
            />
            <Select
              className="h-9 w-auto min-w-[7rem]"
              value={e.target}
              onChange={(ev) => patch(i, { target: ev.target.value as WorkflowExpose['target'] })}
              options={kinds.map((k) => ({ value: k.id, label: k.label }))}
            />
            <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <span className="text-xs text-subtle">{kinds.find((k) => k.id === e.target)?.hint}</span>
          <div className="flex flex-wrap gap-2">
            <Select
              className="h-9 w-auto min-w-[7rem]"
              value={e.type}
              onChange={(ev) => patch(i, { type: ev.target.value as WorkflowExpose['type'] })}
              options={[
                { value: 'select', label: t('下拉单选') },
                { value: 'text', label: t('文本') },
                { value: 'bool', label: t('开关') },
                { value: 'multi', label: t('多选') },
              ]}
            />
            <Input
              className="h-9 flex-[2_1_180px]"
              value={Array.isArray(e.default) ? e.default.join(', ') : String(e.default ?? '')}
              placeholder={t('默认值')}
              onChange={(ev) =>
                patch(i, {
                  default: e.type === 'multi' ? ev.target.value.split(',').map((s) => s.trim()) : ev.target.value,
                })
              }
            />
            {e.type === 'select' || e.type === 'multi' ? (
              <Input
                className="h-9 flex-[2_1_180px]"
                value={e.options.join(', ')}
                placeholder={t('选项，用逗号分开')}
                onChange={(ev) =>
                  patch(i, {
                    options: ev.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="h-9 flex-[1_1_160px]"
              value={e.targetId}
              placeholder={e.target === 'skill' ? t('槽名，例如 projectStructure') : t('参数名')}
              onChange={(ev) => patch(i, { targetId: ev.target.value })}
            />
            <Input
              className="h-9 flex-[2_1_200px]"
              value={e.description}
              placeholder={t('说明（项目设置里会显示）')}
              onChange={(ev) => patch(i, { description: ev.target.value })}
            />
          </div>
          {e.target === 'agent' && e.targetId && (
            <span className="text-xs text-subtle">
              {t('角色没有这个参数时忽略，不会报错')}：
              {[...new Set(agents.filter((a) => a.params.some((p) => p.key === e.targetId)).map((a) => a.name))].join(
                '、',
              ) || t('没有角色用这个参数')}
            </span>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          onChange([
            ...value,
            { key: '', label: '', type: 'select', options: [], target: 'skill', targetId: '', description: '' },
          ])
        }
      >
        {t('加一项配置')}
      </Button>
    </div>
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
