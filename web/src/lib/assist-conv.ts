import { toast } from '@/lib/toast'
import type { AssistKind, Proposal } from '@shared/assist'
import type { AnalysisKind } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from './api'
import { createAnalysisTask, openAiWindow, turnStatus } from './ai-window'

/** 自动纠正那句话的开头：认出「这一轮是我们补发的纠正」，纠正过一次还不对就不再自动发 */
const FIX_HEAD = '你上面的 JSON 不符合要求：'

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
  /** 对话记成哪种分析：默认 init（右侧画项目设置的应用面板）；结果在别处应用的给 run，不出那个面板 */
  analysis?: AnalysisKind
  onProposal: (p: Proposal) => void
}) {
  const base = {
    kind: opts.kind,
    projectId: opts.projectId,
    subject: opts.subject,
    messages: [{ role: 'user' as const, text: opts.start }],
  }
  return runPromptInProject({
    projectId: opts.projectId,
    title: opts.title,
    analysis: opts.analysis,
    prompt: async () => (await api.assistPrompt(base)).prompt,
    resolve: async (reply) => {
      const r = await api.assistResolve({ ...base, text: reply })
      if (!r.proposal) return { error: r.error ?? '' }
      opts.onProposal(r.proposal)
      toast.success(t('「{title}」的结果已经交回项目设置，可以去应用', { title: opts.title }))
      return {}
    },
  })
}

/**
 * 在项目里开一个分析对话跑一段现成的提示词（插件接口 6 开放给插件，例如表格插件的「AI 分析表格风格」）：
 * 过程在统一的 AI 分析窗口里看、能接着问；每一轮说完（包括用户接着问的那几轮）都马上把最后一条回复交给 resolve，
 * 返回 error 时让对话自己修正一次，再不对就提示用户在对话里说
 */
export function runPromptInProject(opts: {
  projectId: string
  /** 窗口和对话列表里的标题 */
  title: string
  prompt: () => Promise<string>
  /** 对话记成哪种分析：默认 init（右侧画项目设置的应用面板）；结果在别处应用的给 run，不出那个面板 */
  analysis?: AnalysisKind
  resolve: (reply: string) => Promise<{ error?: string }>
}) {
  // 同一条回复只读一次：推送和轮询都可能报「这一轮结束」，别对着同一条回复重复纠正
  let lastReply = ''
  openAiWindow({
    label: t('AI 分析'),
    title: opts.title,
    create: async () =>
      createAnalysisTask({
        scope: { kind: 'project', projectId: opts.projectId },
        kind: opts.analysis ?? 'init',
        title: opts.title,
        prompt: await opts.prompt(),
      }),
    onDone: (task) => {
      // 每一轮说完都会到这里（CLI 还开着等下一句也算，见 turnStatus）；用户停下的、失败的不读结果
      if (turnStatus(task) !== 'done') return
      const msgs = task.messages
      const last = [...msgs].reverse().find((m) => m.role === 'agent' && m.text.trim())
      if (!last || last.id === lastReply) return
      lastReply = last.id
      // 这一轮是谁问的：是我们上一次补发的纠正，说明已经纠正过一次还不对，交给用户；
      // 是用户自己的追问（例如「补吧」），这一轮缺 JSON 照样马上纠正一次，不只管第一轮
      const asked = msgs
        .slice(0, msgs.indexOf(last))
        .reverse()
        .find((m) => m.role === 'user')
      const fixedOnce = !!asked?.text.startsWith(FIX_HEAD)
      void opts
        .resolve(last.text)
        .then(async (r) => {
          if (r.error === undefined) return
          if (fixedOnce) {
            toast.error(t('结果的格式还是不对：{error}。可以在对话里让它重新输出', { error: r.error }))
            return
          }
          await api.sendMessage(task.id, `${FIX_HEAD}${r.error}\n请修正后重新输出完整的说明和 JSON。`)
        })
        .catch((e) => toast.error((e as Error).message))
    },
  })
}
