import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Activity, Boxes, Crown, Plus, RefreshCw, Trash2, type LucideIcon } from 'lucide-react'
import type { Agent, AgentInput, CliStatus } from '@shared/schema'
import { api } from '@/lib/api'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { MainAgentCard } from '@/components/agents/MainAgentCard'
import { SubAgentRow } from '@/components/agents/SubAgentRow'
import { AgentEditor, emptyAgent } from '@/components/agents/AgentEditor'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Agent): AgentInput => rest

function Stat({ icon: Icon, label, children, className }: { icon: LucideIcon; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-[14px] border bg-surface/70 px-4 py-3 shadow-card backdrop-blur", className)}>
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-subtle">{label}</div>
        <div className="truncate text-[14px] font-semibold tabular-nums">{children}</div>
      </div>
    </div>
  )
}

/** 主 Agent 与子 Agent 之间的连线：一个圆角拐角 + 向下延续的竖线 */
function Branch({ last, active }: { last?: boolean; active?: boolean }) {
  return (
    <>
      {!last && <span className="absolute left-[50px] top-0 bottom-0 w-px bg-border-strong" />}
      <span
        className={cn(
          'absolute left-[50px] top-0 h-[calc(50%+6px)] w-[26px] rounded-bl-[14px] border-b border-l border-border-strong',
        )}
      />
      <span
        className={cn(
          'absolute left-[72px] top-[calc(50%+2.5px)] h-[7px] w-[7px] rounded-full ring-[3px] ring-bg',
          active ? 'bg-accent' : 'bg-border-strong',
        )}
      />
    </>
  )
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [clis, setClis] = useState<CliStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [editor, setEditor] = useState<{ open: boolean; id?: string; initial: AgentInput }>({
    open: false,
    initial: emptyAgent(),
  })
  const [deleting, setDeleting] = useState<Agent | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api.agents(), api.clis()])
      setAgents(a)
      setClis(c)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const refreshClis = async () => {
    setChecking(true)
    try {
      setClis(await api.clis(true))
      toast.success('已重新检测本机 CLI')
    } finally {
      setChecking(false)
    }
  }

  const main = agents.find((a) => a.role === 'main')
  const subs = agents.filter((a) => a.role !== 'main')
  const cliById = (id: string) => clis.find((c) => c.id === id)
  const defaultCli = clis.find((c) => c.installed)?.id ?? clis[0]?.id ?? 'claude'

  const openCreate = () =>
    setEditor({ open: true, initial: { ...emptyAgent(defaultCli), role: agents.length ? 'sub' : 'main' } })
  const openEdit = (a: Agent) => setEditor({ open: true, id: a.id, initial: toInput(a) })
  const openDuplicate = (a: Agent) =>
    setEditor({ open: true, initial: { ...toInput(a), name: `${a.name} 副本`, role: 'sub' } })

  const save = async (input: AgentInput) => {
    try {
      if (editor.id) await api.updateAgent(editor.id, input)
      else await api.createAgent(input)
      toast.success(editor.id ? `已保存「${input.name}」` : `已创建「${input.name}」`)
      setEditor((s) => ({ ...s, open: false }))
      setAgents(await api.agents())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const setMain = async (a: Agent) => {
    try {
      setAgents(await api.setMain(a.id))
      toast.success(`「${a.name}」现在是主 Agent`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await api.deleteAgent(deleting.id)
      toast.success(`已删除「${deleting.name}」`)
      setAgents(await api.agents())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(null)
    }
  }

  const actions = (a: Agent) => ({
    agent: a,
    cli: cliById(a.cli),
    onEdit: () => openEdit(a),
    onDuplicate: () => openDuplicate(a),
    onDelete: () => setDeleting(a),
    onSetMain: () => setMain(a),
  })

  return (
    <div className="relative min-h-full">
      <div className="page-backdrop pointer-events-none absolute inset-x-0 top-0 h-[420px]" />
      <div className="relative mx-auto max-w-[1080px] px-5 py-8 md:px-10 md:py-12">
        <header className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border bg-surface/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-accent to-accent-2" />
              配置
            </div>
            <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Agent</h1>
            <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-muted">
              每个 Agent 绑定一个本机 CLI 和模型。主 Agent 负责理解需求、拆分任务，再分派给子 Agent 执行。
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建 Agent
          </Button>
        </header>

        <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={Boxes} label="全部 Agent">
            {agents.length}
          </Stat>
          <Stat icon={Activity} label="已启用">
            {agents.filter((a) => a.enabled).length}
            <span className="text-subtle font-normal"> / {agents.length}</span>
          </Stat>
          <Stat icon={Crown} label="主 Agent" className="col-span-2 lg:col-span-1">
            {main?.name ?? '未指定'}
          </Stat>
          <div className="col-span-2 flex min-w-0 items-center gap-3 rounded-[14px] border bg-surface/70 px-4 py-3 shadow-card backdrop-blur lg:col-span-1">
            <div className="min-w-0 flex-1 space-y-1">
              {clis.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px]" title={c.version}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', cliStyle(c.id).dot)} />
                  <span className="truncate">{c.name}</span>
                  <span className={cn('ml-auto shrink-0', c.installed ? 'text-success' : 'text-warning')}>
                    {c.installed ? '可用' : '未安装'}
                  </span>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="icon" title="重新检测本机 CLI" onClick={refreshClis} disabled={checking}>
              <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            </Button>
          </div>
        </section>

        {loading ? (
          <div className="mt-10 space-y-3">
            <div className="h-48 animate-pulse rounded-[18px] border bg-surface" />
            <div className="ml-[76px] h-16 animate-pulse rounded-[14px] border bg-surface" />
            <div className="ml-[76px] h-16 animate-pulse rounded-[14px] border bg-surface" />
          </div>
        ) : agents.length === 0 ? (
          <EmptyState onCreate={openCreate} />
        ) : (
          <section className="mt-10">
            <h2 className="mb-3 text-[12px] font-medium text-subtle">编排结构</h2>
            {main ? (
              <MainAgentCard {...actions(main)} />
            ) : (
              <div className="rounded-[18px] border border-dashed p-6 text-sm text-muted">还没有主 Agent</div>
            )}
            <div>
              {subs.map((a, i) => (
                <div key={a.id} className="animate-rise relative pt-3 pl-[76px]" style={{ animationDelay: `${60 + i * 40}ms` }}>
                  <Branch active={a.enabled} />
                  <SubAgentRow {...actions(a)} />
                </div>
              ))}
              <div className="relative pt-3 pl-[76px]">
                <Branch last />
                <button
                  onClick={openCreate}
                  className="flex w-full items-center gap-3 rounded-[14px] border border-dashed border-border-strong px-4 py-3 text-[13px] text-muted transition-colors hover:border-accent/60 hover:bg-accent-soft hover:text-accent"
                >
                  <span className="grid h-7 w-7 place-items-center rounded-lg border border-dashed border-current">
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  添加子 Agent
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <AgentEditor
        open={editor.open}
        mode={editor.id ? 'edit' : 'create'}
        initial={editor.initial}
        clis={clis}
        onOpenChange={(open) => setEditor((s) => ({ ...s, open }))}
        onSubmit={save}
      />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent
          icon={
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-danger/10 text-danger">
              <Trash2 className="h-5 w-5" />
            </div>
          }
          title={`删除「${deleting?.name ?? ''}」？`}
          description={
            deleting?.role === 'main'
              ? '这是当前的主 Agent，删除后第一个子 Agent 会自动成为主 Agent。此操作无法撤销。'
              : '删除后无法恢复。'
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="danger" onClick={confirmDelete}>
                删除
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="relative mt-10 overflow-hidden rounded-[20px] border bg-surface/70 px-6 py-16 text-center shadow-card">
      <div className="pointer-events-none absolute left-1/2 top-0 h-48 w-96 -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" />
      <svg viewBox="0 0 160 90" className="relative mx-auto h-24 w-44 text-border-strong">
        <path d="M80 26v16M80 42 32 62M80 42v20M80 42l48 20" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <rect x="64" y="4" width="32" height="24" rx="7" className="fill-accent" />
        <rect x="18" y="62" width="28" height="20" rx="6" fill="currentColor" />
        <rect x="66" y="62" width="28" height="20" rx="6" fill="currentColor" />
        <rect x="114" y="62" width="28" height="20" rx="6" fill="currentColor" />
      </svg>
      <h2 className="relative mt-5 text-[17px] font-semibold">搭建你的第一支 Agent 团队</h2>
      <p className="relative mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
        先创建一个主 Agent 负责拆解需求，例如用 Claude Code + Opus；再添加几个子 Agent 负责具体实现。
      </p>
      <Button className="relative mt-6" onClick={onCreate}>
        <Plus className="h-4 w-4" />
        创建主 Agent
      </Button>
    </div>
  )
}
