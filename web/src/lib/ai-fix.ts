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
  /** 对话现在的状态（最小化时右下角的浮条用） */
  status?: Task['status']
  /** 对话被关掉了（从聊天列表里删掉）：窗口不跟着关，显示「对话已关闭」，等用户自己点关闭 */
  gone: boolean
  starting: boolean
  /** 开始时就失败了（例如没有可用的 CLI） */
  error?: string
}
let state: State = { open: false, minimized: false, gone: false, starting: false }
const listeners = new Set<() => void>()
const set = (p: Partial<State>) => {
  state = { ...state, ...p }
  listeners.forEach((f) => f())
}

const running = (s?: Task['status']) => s === 'running'

/**
 * 对话已经从聊天列表里删掉了：正式版返回 404，在线演示没有状态码、错误文案是写死的「任务不存在」，
 * 所以文案中英两种都认（服务端按系统语言返回），不要只看 t() 过一遍的那一种。
 */
const isTaskGone = (e: unknown) => {
  const err = e as Error & { status?: number }
  return err.status === 404 || err.message === '任务不存在' || err.message === t('任务不存在')
}

/**
 * 盯着对话的状态：结束时调 onDone、最小化着的话提醒一下。
 * 窗口和对话是两回事：对话被关掉（从聊天列表里删掉）时只标「对话已关闭」，窗口留到用户自己点关闭。
 */
function watch(id: string) {
  // 结束只提醒一次：结束后还会放慢节奏继续盯着对话在不在，不能每次都提醒
  let finished = false
  const tick = async () => {
    if (state.taskId !== id) return
    try {
      const task = await api.task(id)
      if (state.taskId !== id) return
      set({ status: task.status })
      if (running(task.status)) return void setTimeout(tick, 1500)
      if (!finished) {
        finished = true
        state.issue?.onDone?.()
        if (!state.open || state.minimized)
          toast(t('AI 排查结束：{title}', { title: state.issue?.title ?? '' }), {
            action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) },
          })
      }
      // 对话结束了不代表用户关了窗口：放慢节奏继续看一眼，之后从列表里删掉时要能标出来
      setTimeout(tick, 5000)
    } catch (e) {
      if (state.taskId !== id) return
      // 网络抖动之类的先不判死：下一轮再看
      if (!isTaskGone(e)) return void setTimeout(tick, 5000)
      // 对话被删掉了：窗口不自动关，显示「对话已关闭」，只有用户手动点关闭才关
      set({ gone: true })
    }
  }
  setTimeout(tick, 1500)
}

async function start(issue: FixIssue) {
  const { onDone: _, ...input } = issue
  set({
    open: true,
    minimized: false,
    issue,
    taskId: undefined,
    status: undefined,
    gone: false,
    error: undefined,
    starting: true,
  })
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
/** 关掉弹窗；还在排查时停下（用户点关闭就是真的关，不再先确认） */
export function closeAiFix() {
  if (state.taskId && running(state.status)) void api.stopTask(state.taskId).catch(() => {})
  // 清掉 taskId：watch() 的轮询下一轮就自己退出了
  set({ open: false, minimized: false, taskId: undefined, status: undefined, gone: false })
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
