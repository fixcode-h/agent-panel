import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Plus, Trash2 } from 'lucide-react'
import type { Agent } from '@shared/schema'
import { t } from '@shared/i18n'
import { BUILTIN_AGENTS } from '@shared/builtin/agents'
import { api } from '@/lib/api'
import { addBuiltinAgents, addedBuiltin } from '@/lib/builtin'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/dialog'

/**
 * 内置 Agent：按分类列出，点「添加」才建出来（连同它引入的「通用约束」），不会自动装。
 * 已经添加的显示「删除」；添加内置工作流时用到的 Agent 也会自动建，这里能看到。
 */
export function BuiltinAgentsDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: (a: Agent) => void
}) {
  const { agents, categories, tags, workflows, setAgents, setCategories, setTags } = useData()
  const [busy, setBusy] = useState('')
  const [removing, setRemoving] = useState<Agent | null>(null)
  const groups = [...new Set(BUILTIN_AGENTS.map((b) => b.category))].map((c) => ({
    name: c,
    items: BUILTIN_AGENTS.filter((b) => b.category === c),
  }))
  const missing = BUILTIN_AGENTS.filter((b) => !addedBuiltin(agents, b.key))

  const add = async (keys: string[], key: string) => {
    setBusy(key)
    try {
      const r = await addBuiltinAgents(keys, { agents, categories, tags, workflows })
      if (r.created.length) setAgents((as) => [...as, ...r.created])
      if (r.newCategories.length) setCategories((cs) => [...cs, ...r.newCategories])
      if (r.newTags.length) setTags((ts) => [...ts, ...r.newTags])
      toast.success(t('已添加 {n} 个 Agent', { n: r.created.length }))
      const first = r.created.find((a) => keys.some((k) => a.origin === `builtin:${k}`))
      if (first) onAdded(first)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('内置 Agent')} wide>
      <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <p className="min-w-0 flex-[1_1_320px] text-[0.8125rem] leading-relaxed text-muted">
            {t(
              '按规划、开发、质量、文档与交付、UE 和美术整理好的 Agent，都引入「通用约束」。只在你点添加时才建出来，引用的自带 Skill 在执行时自动装进 CLI。',
            )}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy || !missing.length}
            onClick={() =>
              void add(
                missing.map((b) => b.key),
                'all',
              )
            }
          >
            {busy === 'all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('全部添加')}
          </Button>
        </div>
        {groups.map((g) => (
          <section key={g.name} className="flex flex-col gap-2">
            <h3 className="text-[0.75rem] font-medium text-subtle">{g.name}</h3>
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
              {g.items.map((b) => {
                const added = !!addedBuiltin(agents, b.key)
                return (
                  <li key={b.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_320px]">
                      <p className="flex items-center gap-2 text-[0.84375rem] font-medium">
                        {b.agent.name}
                        {added && (
                          <span className="inline-flex items-center gap-0.5 text-[0.71875rem] font-normal text-success">
                            <Check className="h-3 w-3" />
                            {t('已添加')}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[0.78125rem] leading-relaxed text-muted">{b.agent.description}</p>
                      {b.agent.skills.length > 0 && (
                        <p className="mt-1 font-mono text-[0.71875rem] text-subtle">{b.agent.skills.join(' · ')}</p>
                      )}
                    </div>
                    {added ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() => setRemoving(addedBuiltin(agents, b.key) ?? null)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('删除')}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={!!busy} onClick={() => void add([b.key], b.key)}>
                        {busy === b.key ? (
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
        title={t('删除 Agent「{name}」？', { name: removing?.name ?? '' })}
        description={t('工作流还在用它时不能删，先改掉或删除那些工作流。')}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api.deleteAgent(removing.id)
            // 和服务端一样：引入了它的 Agent 去掉这条引入
            setAgents((as) =>
              as
                .filter((a) => a.id !== removing.id)
                .map((a) =>
                  a.includes.includes(removing.id)
                    ? { ...a, includes: a.includes.filter((x) => x !== removing.id) }
                    : a,
                ),
            )
            setRemoving(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </Modal>
  )
}
