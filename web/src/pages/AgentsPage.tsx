import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Bot, Plus, RefreshCw, Sparkles } from 'lucide-react'
import type { Agent, AgentInput, CliStatus } from '@shared/schema'
import { api } from '@/lib/api'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AgentCard } from '@/components/agents/AgentCard'
import { AgentEditor, emptyAgent } from '@/components/agents/AgentEditor'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Agent): AgentInput => rest

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
    } finally {
      setChecking(false)
    }
  }

  const main = agents.find((a) => a.role === 'main')
  const subs = useMemo(() => agents.filter((a) => a.role !== 'main'), [agents])
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
      toast.success(editor.id ? '已保存' : `已创建「${input.name}」`)
      setEditor((s) => ({ ...s, open: false }))
      setAgents(await api.agents())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const setMain = async (a: Agent) => {
    try {
      setAgents(await api.setMain(a.id))
      toast.success(`「${a.name}」已设为主 Agent`)
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

  const cardProps = (a: Agent) => ({
    agent: a,
    cli: cliById(a.cli),
    onEdit: () => openEdit(a),
    onDuplicate: () => openDuplicate(a),
    onDelete: () => setDeleting(a),
    onSetMain: () => setMain(a),
  })

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 md:px-10 md:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent 配置</h1>
          <p className="mt-1.5 text-sm text-muted">
            定义可以调度的本机 Agent：每个 Agent 绑定一个 CLI 和模型，其中一个作为主 Agent 负责拆分和分派任务。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建 Agent
        </Button>
      </header>

      <section className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">本机 CLI</span>
        {clis.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-2 rounded-full border bg-surface px-3 py-1 text-xs"
            title={c.version}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', cliStyle(c.id).dot)} />
            {c.name}
            <span className={c.installed ? 'text-success' : 'text-warning'}>
              {c.installed ? '可用' : '未安装'}
            </span>
          </span>
        ))}
        <Button variant="ghost" size="sm" onClick={refreshClis} disabled={checking}>
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          重新检测
        </Button>
      </section>

      {loading ? (
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl border bg-surface" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div className="mt-10 flex flex-col items-center rounded-3xl border border-dashed bg-surface/50 px-6 py-16 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-soft text-accent">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">还没有 Agent</h2>
          <p className="mt-1.5 max-w-sm text-sm text-muted">
            先创建一个主 Agent，例如用 Claude Code 负责拆解需求，再添加若干子 Agent 负责具体实现。
          </p>
          <Button className="mt-6" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            创建第一个 Agent
          </Button>
        </div>
      ) : (
        <>
          <section className="mt-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">主 Agent</h2>
            {main ? (
              <div className="max-w-2xl">
                <AgentCard featured {...cardProps(main)} />
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed p-5 text-sm text-muted">尚未指定主 Agent</div>
            )}
          </section>

          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
              子 Agent <span className="rounded-full bg-surface-2 px-1.5 text-[10px]">{subs.length}</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {subs.map((a) => (
                <AgentCard key={a.id} {...cardProps(a)} />
              ))}
              <button
                onClick={openCreate}
                className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-sm text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
              >
                <Bot className="h-5 w-5" />
                添加子 Agent
              </button>
            </div>
          </section>
        </>
      )}

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
          title={`删除「${deleting?.name ?? ''}」？`}
          description={
            deleting?.role === 'main'
              ? '这是当前的主 Agent，删除后会自动把第一个子 Agent 设为主 Agent。此操作无法撤销。'
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
