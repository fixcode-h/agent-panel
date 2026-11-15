import { useState } from 'react'
import { BookOpen, FileText, Loader2, SearchX, Wrench, type LucideIcon } from 'lucide-react'
import { taskSummary } from '@shared/task'
import type { Project } from '@shared/schema'
import type { DistillRequest } from '@shared/knowledge/candidate'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { knowledgeApi } from '@/lib/api-experience'
import { openAiWindow } from '@/lib/ai-window'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageIntro } from '../settings/parts'
import { useKnowledgeState } from './use-knowledge-state'

type Target = Exclude<DistillRequest['target'], 'hook'>

const ACTIONS: { target: Target; icon: LucideIcon; title: () => string; desc: () => string }[] = [
  {
    target: 'agents',
    icon: FileText,
    title: () => t('写成 AGENTS.md 补丁'),
    desc: () => t('挑出用上很多次、帮上过的教训，写成项目说明里的规则；改动在对话里给你过目，确认后才算数。'),
  },
  {
    target: 'docs',
    icon: BookOpen,
    title: () => t('合进模块文档'),
    desc: () => t('按模块把相关的教训和经验合进模块文档，已有的合并不覆盖。'),
  },
  {
    target: 'panel',
    icon: Wrench,
    title: () => t('面板改进建议'),
    desc: () => t('从反复推送、反复被违反的条目里找出该由面板自己改进的地方，写成建议清单。'),
  },
  {
    target: 'misses',
    icon: SearchX,
    title: () => t('补没配上的查询'),
    desc: () => t('看 Agent 搜了却没有经验对得上的说法，查清位置后补成经验。'),
  },
]

/**
 * 项目设置 →「提炼」（设计稿四期）：把攒下的教训、经验提炼成更长效的东西。
 * 点一个动作向面板要提示词（POST /projects/:id/knowledge/distill），再在这个项目里新开一个对话去做，
 * 在 AI 窗口里看进度；挑不出可提炼的条目时直接说明原因，不开对话
 */
export function DistillPage({ project }: { project: Project }) {
  const { upsertTask } = useData()
  const { state } = useKnowledgeState(project.id)
  const [busy, setBusy] = useState<Target | ''>('')
  const counts: Partial<Record<Target, number>> = {
    agents: state?.suggestions.filter((s) => s.action === 'promote').length,
    misses: state?.misses.length,
  }
  const run = async (target: Target, label: string) => {
    setBusy(target)
    try {
      const r = await knowledgeApi.distill(project.id, { target })
      if (!r.ok || !r.prompt) {
        toast(r.info || t('现在没有可提炼的条目'))
        return
      }
      const prompt = r.prompt
      openAiWindow({
        label: t('AI 提炼'),
        title: r.title || label,
        create: async () => {
          const created = await api.createTask({
            projectId: project.id,
            mode: 'chat',
            workflowId: '',
            // 提炼要改项目说明、模块文档：用项目默认的对话角色，不用只读的分析角色
            agentId: project.defaultAgentId ?? '',
            cli: '',
            model: '',
            effort: '',
            params: {},
            prompt,
            attachments: [],
            isolate: false,
            askUser: false,
          })
          const named = await api.renameTask(created.id, (r.title || label).slice(0, 80)).catch(() => created)
          upsertTask(taskSummary(named))
          return named
        },
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('提炼')}
        desc={t(
          '教训和经验攒多了，常用的值得写进项目说明或模块文档，总是被违反的值得做成钩子或改进面板。每个动作会在这个项目里新开一个对话，改动照常给你过目。',
        )}
      />
      <ul className="grid gap-2 sm:grid-cols-2">
        {ACTIONS.map((a) => {
          const Icon = a.icon
          const n = counts[a.target]
          return (
            <Card as="li" key={a.target} className="flex flex-col gap-2 px-3.5 py-3">
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-accent-text" />
                <span className="min-w-0 flex-1 truncate text-body font-medium">{a.title()}</span>
                {!!n && <span className="shrink-0 text-caption text-subtle">{t('{n} 条可提炼', { n })}</span>}
              </span>
              <p className="flex-1 text-footnote leading-relaxed text-subtle">{a.desc()}</p>
              <Button
                size="sm"
                variant="secondary"
                className="self-end"
                disabled={!!busy}
                onClick={() => void run(a.target, a.title())}
              >
                {busy === a.target && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('开始')}
              </Button>
            </Card>
          )
        })}
      </ul>
    </div>
  )
}
