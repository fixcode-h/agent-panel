import type { FixInput } from '@shared/fix'
import type { AnalysisScope } from '@shared/analysis-home'
import { t } from '@shared/i18n'
import { api } from './api'
import { createAnalysisTask, openAiWindow } from './ai-window'

/**
 * 「AI 处理」：报错的地方只管调用 openAiFix。服务端按报错整理好第一句话、挑能用的 CLI，
 * 对话按归属规则建好（项目里对话的报错在项目里另开顶层对话、子对话里的报错开在它所属顶层对话下、项目设置里的开项目对话、其余开 Chat），
 * 显示在统一的 AI 分析窗口（AiWindow）里。
 */
export type FixIssue = Partial<FixInput> & {
  title: string
  /** 报错属于哪里：不写就是和项目无关，开 Chat 对话 */
  home?: AnalysisScope
  /** 排查结束后（不论结果）做什么，例如重新检测 */
  onDone?: () => void
}

/** 把报错交给 AI 处理：还有一个在排查时先打开那一个，不同时跑两个 */
export function openAiFix(issue: FixIssue) {
  const { onDone, home, ...input } = issue
  openAiWindow({
    label: t('AI 排查'),
    title: issue.title,
    onDone: onDone && (() => onDone()),
    create: async () => {
      const s = await api.aiFix(input)
      return createAnalysisTask({
        scope: home ?? { kind: 'chat' },
        kind: 'fix',
        title: t('AI 排查：{title}', { title: s.title }),
        prompt: s.prompt,
        cli: s.cli,
        model: s.model,
      })
    },
  })
}
