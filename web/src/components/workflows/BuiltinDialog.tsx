import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Check, Loader2, Plus, Trash2 } from 'lucide-react'
import type { Workflow } from '@shared/schema'
import { t } from '@shared/i18n'
import { BUILTIN_AGENTS } from '@shared/builtin/agents'
import { BUILTIN_WORKFLOWS, builtinAgentKeys, type BuiltinWorkflow } from '@shared/builtin/workflows'
import { api } from '@/lib/api'
import { addBuiltinWorkflow, addedBuiltinWorkflow, missingAgents } from '@/lib/builtin'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/dialog'

/**
 * 内置工作流：按分类列出。自带工作流启动时已经全部加入（见 shared/builtin/install.ts 的 seedProjectWorkflows），
 * 这里主要用来看哪些还在、把删掉的重新添加（连同缺的 Agent 一起建出来）；已经添加的显示「删除」。
 * 删除只删工作流，用到的 Agent 留着（可能被别的工作流用，或者你改过），要删去 Agent 页的「内置 Agent」。
 */
export function BuiltinDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: (w: Workflow) => void
}) {
  const { agents, categories, tags, workflows, setAgents, setCategories, setTags, setWorkflows } = useData()
  const [busy, setBusy] = useState('')
  const [removing, setRemoving] = useState<Workflow | null>(null)
  const groups = [...new Set(BUILTIN_WORKFLOWS.map((w) => w.category))].map((c) => ({
    name: c,
    items: BUILTIN_WORKFLOWS.filter((w) => w.category === c),
  }))
  const agentName = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)?.agent.name ?? key

  const add = async (w: BuiltinWorkflow) => {
    setBusy(w.key)
    try {
      const r = await addBuiltinWorkflow(w, { agents, categories, tags, workflows })
      if (r.created.length) setAgents((as) => [...as, ...r.created])
      if (r.newCategories.length) setCategories((cs) => [...cs, ...r.newCategories])
      if (r.newTags.length) setTags((ts) => [...ts, ...r.newTags])
      setWorkflows((ws) => [...ws, r.workflow])
      toast.success(
        r.created.length
          ? t('已添加「{name}」，新建了 {n} 个角色', { name: r.workflow.name, n: r.created.length })
          : t('已添加「{name}」', { name: r.workflow.name }),
      )
      onAdded(r.workflow)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('内置工作流')} wide>
      <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          {t(
            '自带的工作流启动时已经全部加入，用到的角色也随之建好；删掉的可以在这里重新添加。角色引用的自带 Skill 在执行时自动装进 Agent。',
          )}
        </p>
        {groups.map((g) => (
          <section key={g.name} className="flex flex-col gap-2">
            <h3 className="text-[0.75rem] font-medium text-subtle">{g.name}</h3>
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
              {g.items.map((w) => {
                const added = addedBuiltinWorkflow(workflows, w)
                const lack = missingAgents(w, agents).length
                const steps = w.flows[0].nodes.length
                return (
                  <li key={w.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_320px]">
                      <p className="flex items-center gap-2 text-[0.84375rem] font-medium">
                        {w.name}
                        {added && (
                          <span className="inline-flex items-center gap-0.5 text-[0.71875rem] font-normal text-success">
                            <Check className="h-3 w-3" />
                            {t('已添加')}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[0.78125rem] leading-relaxed text-muted">{w.description}</p>
                      <p className="mt-1 text-[0.71875rem] text-subtle">
                        {t('{n} 步', { n: steps })} · {builtinAgentKeys(w).map(agentName).join(t('、'))}
                        {lack > 0 && ` · ${t('将新建 {n} 个角色', { n: lack })}`}
                      </p>
                    </div>
                    {added ? (
                      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setRemoving(added)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('删除')}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={!!busy} onClick={() => void add(w)}>
                        {busy === w.key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        {t('添加')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('删除工作流「{name}」？', { name: removing?.name ?? '' })}
        description={t('只删除工作流，用到的角色会留着。')}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api.deleteWorkflow(removing.id)
            setWorkflows((ws) => ws.filter((x) => x.id !== removing.id))
            setRemoving(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </Modal>
  )
}
