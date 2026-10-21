import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type Task } from '@shared/schema'
import type { FixInput } from '@shared/fix'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 「AI 处理」：报错的地方只管调用 openAiFix。每次处理都在聊天里新建一个对话（之后在聊天列表里能接着看、接着问），
 * 对话显示在最外层的弹窗（AiFixDialog）里：最小化成右下角的按钮，排查照常进行；关闭会停止排查。
 */
export type FixIssue = Partial<FixInput> & {
  title: string
  /** 排查结束后（不论结果）做什么，例如重新检测 */
  onDone?: () => void
}

interface State {
  open: boolean
  minimized: boolean
  issue?: FixIssue
  /** 这次排查的聊天对话 */
  taskId?: string
  /** 对话现在的状态（最小化时右下角的按钮用） */
  status?: Task['status']
  starting: boolean
  /** 开始时就失败了（例如没有可用的 CLI） */
  error?: string
}
let state: State = { open: false, minimized: false, starting: false }
const listeners = new Set<() => void>()
const set = (p: Partial<State>) => {
  state = { ...state, ...p }
  listeners.forEach((f) => f())
}

const running = (s?: Task['status']) => s === 'running'

/** 盯着对话的状态：结束时调 onDone，最小化着的话提醒一下 */
function watch(id: string) {
  const tick = async () => {
    if (state.taskId !== id) return
    try {
      const task = await api.task(id)
      if (state.taskId !== id) return
      set({ status: task.status })
      if (running(task.status)) return void setTimeout(tick, 1500)
      state.issue?.onDone?.()
      if (!state.open || state.minimized)
        toast(t('AI 排查结束：{title}', { title: state.issue?.title ?? '' }), {
          action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) },
        })
    } catch {
      // 对话被删掉了：弹窗也不用留着
      set({ open: false, minimized: false, taskId: undefined, status: undefined })
    }
  }
  setTimeout(tick, 1500)
}

async function start(issue: FixIssue) {
  const { onDone: _, ...input } = issue
  set({ open: true, minimized: false, issue, taskId: undefined, status: undefined, error: undefined, starting: true })
  try {
    const s = await api.aiFix(input)
    const task = await api.createTask({
      projectId: '',
      mode: 'chat',
      workflowId: '',
      agentId: '',
      cli: s.cli,
      model: s.model,
      effort: '',
      prompt: s.prompt,
      attachments: [],
      params: {},
      isolate: false,
      // 排查中 AI 要问的（例如要不要删某个文件）交给用户
      askUser: true,
    })
    // 聊天列表里用报错当标题，一眼能认出是哪次排查
    const named = await api
      .renameTask(task.id, t('AI 排查：{title}', { title: s.title }).slice(0, 80))
      .catch(() => task)
    set({ taskId: named.id, status: named.status, starting: false })
    watch(named.id)
  } catch (e) {
    set({ error: (e as Error).message, starting: false })
  }
}

/** 把报错交给 AI 处理：还有一个在排查时先打开那一个，不同时跑两个 */
export function openAiFix(issue: FixIssue) {
  if (state.starting || running(state.status)) {
    set({ open: true, minimized: false })
    if (state.issue?.title !== issue.title) toast(t('上一个报错还在排查，排查完再试'))
    return
  }
  void start(issue)
}

export const minimizeAiFix = (minimized: boolean) => set({ minimized })
/** 收起弹窗但不停止（去聊天里看了） */
export const hideAiFix = () => set({ open: false, minimized: false })
/** 关掉弹窗；还在排查时停下 */
export function closeAiFix() {
  if (state.taskId && running(state.status)) void api.stopTask(state.taskId).catch(() => {})
  set({ open: false, minimized: false })
}
export const aiFixRunning = () => state.starting || running(state.status)

export function useAiFix() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  return state
}
