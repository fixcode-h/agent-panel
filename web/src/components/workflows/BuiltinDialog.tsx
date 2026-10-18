import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Plus } from 'lucide-react'
import type { Workflow } from '@shared/schema'
import { t } from '@shared/i18n'
import { BUILTIN_AGENTS } from '@shared/builtin/agents'
import { BUILTIN_WORKFLOWS, builtinAgentKeys, type BuiltinWorkflow } from '@shared/builtin/workflows'
import { addBuiltinWorkflow, missingAgents } from '@/lib/builtin'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'

/**
 * 内置工作流：按分类列出，点「添加」连同缺的 Agent 一起建出来。
 * 同一个模板可以加多次（例如改成不同的版本），已经加过的标出来。
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
          ? t('已添加「{name}」，新建了 {n} 个 Agent', { name: r.workflow.name, n: r.created.length })
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
        <p className="text-[13px] leading-relaxed text-muted">
          {t(
            '按日常开发、UE / P4 和美术资产链整理好的工作流。添加时会一起建好用到的 Agent（已经有的直接复用），Agent 引用的自带 Skill 在执行时自动装进 CLI。',
          )}
        </p>
        {groups.map((g) => (
          <section key={g.name} className="flex flex-col gap-2">
            <h3 className="text-[12px] font-medium text-subtle">{g.name}</h3>
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
              {g.items.map((w) => {
                const added = workflows.some((x) => x.name === w.name)
                const lack = missingAgents(w, agents).length
                const steps = w.flows[0].nodes.length
                return (
                  <li key={w.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_320px]">
                      <p className="flex items-center gap-2 text-[13.5px] font-medium">
                        {w.name}
                        {added && (
                          <span className="inline-flex items-center gap-0.5 text-[11.5px] font-normal text-success">
                            <Check className="h-3 w-3" />
                            {t('已添加')}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{w.description}</p>
                      <p className="mt-1 text-[11.5px] text-subtle">
                        {t('{n} 步', { n: steps })} · {builtinAgentKeys(w).map(agentName).join(t('、'))}
                        {lack > 0 && ` · ${t('将新建 {n} 个 Agent', { n: lack })}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={added ? 'secondary' : 'primary'}
                      disabled={!!busy}
                      onClick={() => void add(w)}
                    >
                      {busy === w.key ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      {added ? t('再加一份') : t('添加')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}
