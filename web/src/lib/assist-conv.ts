import { toast } from 'sonner'
import type { AssistKind, Proposal } from '@shared/assist'
import { t } from '@shared/i18n'
import { api } from './api'
import { createAnalysisTask, openAiWindow } from './ai-window'

/**
 * 项目已经存在时的「AI 初始化项目」：不再单独跑一次后台生成，而是在这个项目里开一个对话来做
 * （归属见 shared/analysis-home.ts，角色用「分析」），过程在统一的 AI 分析窗口里看、能接着问。
 * 对话结束后把最后一条回复交给服务端解析成推荐，交回设置页去应用；格式不对时让对话自己修正一次。
 */
export function runAssistInProject(opts: {
  kind: AssistKind
  projectId: string
  /** 窗口和对话列表里的标题 */
  title: string
  /** 用户这次的要求（第一句话） */
  start: string
  subject: Record<string, string>
  onProposal: (p: Proposal) => void
}) {
  const base = {
    kind: opts.kind,
    projectId: opts.projectId,
    subject: opts.subject,
    messages: [{ role: 'user' as const, text: opts.start }],
  }
  // 自动修正只做一次：再不对就交给用户在对话里说
  let fixed = false
  openAiWindow({
    label: t('AI 分析'),
    title: opts.title,
    create: async () => {
      const { prompt } = await api.assistPrompt(base)
      return createAnalysisTask({ scope: { kind: 'project', projectId: opts.projectId }, title: opts.title, prompt })
    },
    onDone: (task) => {
      // 用户停下的不读结果
      if (task.status !== 'done') return
      const reply = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())?.text ?? ''
      void api
        .assistResolve({ ...base, text: reply })
        .then(async (r) => {
          if (r.proposal) {
            opts.onProposal(r.proposal)
            toast.success(t('「{title}」的结果已经交回项目设置，可以去应用', { title: opts.title }))
            return
          }
          if (fixed) {
            toast.error(t('结果的格式还是不对：{error}。可以在对话里让它重新输出', { error: r.error ?? '' }))
            return
          }
          fixed = true
          await api.sendMessage(task.id, `你上面的 JSON 不符合要求：${r.error}\n请修正后重新输出完整的说明和 JSON。`)
        })
        .catch((e) => toast.error((e as Error).message))
    },
  })
}
