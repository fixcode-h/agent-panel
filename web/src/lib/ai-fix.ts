import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { FixInput, FixJob } from '@shared/fix'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 「AI 处理」的状态放在组件外面：报错的地方只管调用 openAiFix，弹窗（AiFixDialog）挂在最外层。
 * 关掉弹窗不停止处理，处理完弹提示，点「查看」再打开
 */
export type FixIssue = Partial<FixInput> & {
  title: string
  /** 处理完后（不论结果）做什么，例如重新检测 */
  onDone?: () => void
}

interface State {
  open: boolean
  issue?: FixIssue
  job?: FixJob
  /** 开始时就失败了（例如没有可用的 CLI） */
  error?: string
}
let state: State = { open: false }
const listeners = new Set<() => void>()
const set = (p: Partial<State>) => {
  state = { ...state, ...p }
  listeners.forEach((f) => f())
}

function poll(id: string) {
  const tick = async () => {
    if (state.job?.id !== id) return
    try {
      const j = await api.fixJob(id)
      if (state.job?.id !== id) return
      set({ job: j })
      if (j.status === 'running') return void setTimeout(tick, 800)
      state.issue?.onDone?.()
      if (!state.open)
        toast[j.status === 'done' ? 'success' : 'error'](
          j.status === 'done' ? t('AI 处理完了：{title}', { title: j.title }) : t('AI 处理没有成功'),
          { action: { label: t('查看'), onClick: () => set({ open: true }) } },
        )
    } catch (e) {
      set({ job: state.job && { ...state.job, status: 'failed', error: (e as Error).message } })
    }
  }
  setTimeout(tick, 600)
}

async function start(issue: FixIssue) {
  const { onDone, ...input } = issue
  void onDone
  set({ open: true, issue, job: undefined, error: undefined })
  try {
    const j = await api.startFix(input)
    set({ job: j })
    poll(j.id)
  } catch (e) {
    set({ error: (e as Error).message })
  }
}

/** 把报错交给 AI 处理：还有一个在处理时先打开那一个，不同时跑两个 */
export function openAiFix(issue: FixIssue) {
  if (state.job?.status === 'running') {
    set({ open: true })
    if (state.issue?.title !== issue.title) toast(t('上一个报错还在处理，处理完再试'))
    return
  }
  void start(issue)
}

export const retryAiFix = () => state.issue && void start(state.issue)
export const stopAiFix = () => state.job && void api.stopFix(state.job.id).catch(() => {})
export const setAiFixOpen = (open: boolean) => set({ open })

export function useAiFix() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  return state
}
