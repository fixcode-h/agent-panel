import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type Attachment, type Task } from '@shared/schema'
import { analysisHome, analyzerId, rootIdOf, type AnalysisHome, type AnalysisScope } from '@shared/analysis-home'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 统一的 AI 分析窗口：面板上所有「AI 分析」「AI 排查」只管调用 openAiWindow，
 * 对话按归属规则建好（见 shared/analysis-home.ts：对话树里的开成父对话的子对话、项目的开项目对话、其余开 Chat），
 * 统一用必备角色「分析」，显示在最外层的同一个窗口（AiWindow）里：最小化成右下角的浮条，分析照常进行；关闭会停止这次分析。
 */
export interface AiJob {
  /** 窗口和浮条上的说法：AI 排查 / AI 分析 */
  label: string
  /** 这次分析的对象，例如报错标题、对话标题 */
  title: string
  /** 新建对话：归属、角色已经由 createAnalysisTask 定好 */
  create: () => Promise<Task>
  /** 分析结束后（不论结果）做什么，例如重新检测、把结果读回去；对话接着问又结束时会再调一次 */
  onDone?: (task: Task) => void
}

interface State {
  open: boolean
  minimized: boolean
  job?: AiJob
  /** 这次分析的对话 */
  taskId?: string
  /** 对话在哪：去对话里看时按它跳 */
  projectId?: string
  parentTaskId?: string
  /** 对话现在的状态（最小化时右下角的浮条用） */
  status?: Task['status']
  /** 对话被关掉了（从列表里删掉）：窗口不跟着关，显示「对话已关闭」，等用户自己点关闭 */
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
 * 对话已经删掉了：正式版返回 404，在线演示没有状态码、错误文案是写死的「任务不存在」，
 * 所以文案中英两种都认（服务端按系统语言返回），不要只看 t() 过一遍的那一种。
 */
const isTaskGone = (e: unknown) => {
  const err = e as Error & { status?: number }
  return err.status === 404 || err.message === '任务不存在' || err.message === t('任务不存在')
}

/**
 * 盯着对话的状态：结束时调 onDone、最小化着的话提醒一下。
 * 窗口和对话是两回事：对话被关掉（删掉）时只标「对话已关闭」，窗口留到用户自己点关闭。
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
      // 结束后又被接着问了：这一轮结束时还要再提醒、再交回结果
      if (running(task.status)) {
        finished = false
        return void setTimeout(tick, 1500)
      }
      if (!finished) {
        finished = true
        state.job?.onDone?.(task)
        if (!state.open || state.minimized)
          toast(t('{label}结束：{title}', { label: state.job?.label ?? '', title: state.job?.title ?? '' }), {
            action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) },
          })
      }
      // 对话结束了不代表用户关了窗口：放慢节奏继续看一眼，之后删掉时要能标出来
      setTimeout(tick, 5000)
    } catch (e) {
      if (state.taskId !== id) return
      // 网络抖动之类的先不判死：下一轮再看
      if (!isTaskGone(e)) return void setTimeout(tick, 5000)
      set({ gone: true })
    }
  }
  setTimeout(tick, 1500)
}

async function start(job: AiJob) {
  set({
    open: true,
    minimized: false,
    job,
    taskId: undefined,
    projectId: undefined,
    parentTaskId: undefined,
    status: undefined,
    gone: false,
    error: undefined,
    starting: true,
  })
  try {
    const task = await job.create()
    set({
      taskId: task.id,
      projectId: task.projectId,
      parentTaskId: task.parentTaskId,
      status: task.status,
      starting: false,
    })
    watch(task.id)
  } catch (e) {
    set({ error: (e as Error).message, starting: false })
  }
}

/** 打开 AI 分析窗口：还有一个在分析时先打开那一个，不同时跑两个 */
export function openAiWindow(job: AiJob) {
  if (state.starting || running(state.status)) {
    set({ open: true, minimized: false })
    if (state.job?.title !== job.title)
      toast(t('上一个{label}还没结束，结束后再试', { label: state.job?.label ?? t('AI 分析') }))
    return
  }
  void start(job)
}

export const minimizeAiWindow = (minimized: boolean) => set({ minimized })
/** 收起窗口但不停止（去对话里看了） */
export const hideAiWindow = () => set({ open: false, minimized: false })
/** 关掉窗口；还在分析时停下（用户点关闭就是真的关，不再先确认） */
export function closeAiWindow() {
  if (state.taskId && running(state.status)) void api.stopTask(state.taskId).catch(() => {})
  // 清掉 taskId：watch() 的轮询下一轮就自己退出了
  set({ open: false, minimized: false, taskId: undefined, status: undefined, gone: false })
}
export const aiWindowRunning = () => state.starting || running(state.status)

export function useAiWindow() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  return state
}

/** 对话所在那棵树的顶层对话：子对话的分析要知道父对话能不能挂子对话；取不到时按挂不了处理 */
async function rootOf(scope: AnalysisScope) {
  if (scope.kind !== 'task') return undefined
  const tk = scope.task
  if (!tk.parentTaskId) return tk
  return api.task(rootIdOf(tk)).catch(() => undefined)
}

/** 按归属规则算出分析对话放哪（界面上提前说明用） */
export async function resolveHome(scope: AnalysisScope): Promise<AnalysisHome> {
  return analysisHome(scope, await rootOf(scope))
}

/**
 * 按归属规则新建一个分析对话：放在哪由 analysisHome 定，角色用必备角色「分析」。
 * 开成子对话时跟着父对话的「提问」开关；顶层对话按调用方给的
 */
export async function createAnalysisTask(opts: {
  scope: AnalysisScope
  title: string
  prompt: string
  attachments?: Attachment[]
  cli?: string
  model?: string
  askUser?: boolean
}) {
  const [root, agents] = await Promise.all([rootOf(opts.scope), api.agents().catch(() => [])])
  const home = analysisHome(opts.scope, root)
  const created = await api.createTask({
    projectId: home.projectId,
    mode: 'chat',
    ...(home.parentTaskId && { parentTaskId: home.parentTaskId }),
    workflowId: '',
    agentId: analyzerId(agents),
    cli: opts.cli ?? '',
    model: opts.model ?? '',
    effort: '',
    params: {},
    prompt: opts.prompt,
    attachments: opts.attachments ?? [],
    isolate: false,
    askUser: home.parentTaskId && root && 'askUser' in root ? !!root.askUser : (opts.askUser ?? false),
  })
  // 列表里用分析对象当标题，一眼能认出是哪次分析
  return api.renameTask(created.id, opts.title.slice(0, 80)).catch(() => created)
}

/**
 * 去对话里看：子对话打开它的父对话、在右栏打开它；顶层对话直接打开。
 * 右栏开哪个子对话记在本地（和对话页同一个键），再发个事件让已经开着的父对话马上切过去
 */
export function analysisRoute(s: Pick<State, 'taskId' | 'projectId' | 'parentTaskId'>) {
  if (!s.taskId) return null
  if (s.parentTaskId) {
    showChildInPane(s.parentTaskId, s.taskId)
    return { page: 'projects' as const, id: s.projectId, sub: s.parentTaskId }
  }
  return s.projectId
    ? { page: 'projects' as const, id: s.projectId, sub: s.taskId }
    : { page: 'chat' as const, id: s.taskId }
}

/** 对话页右栏记住开着哪个子对话、哪次运行（TaskView 读同一组键） */
export const paneChildKey = (taskId: string) => `task-child:${taskId}`
export const paneRunKey = (taskId: string) => `task-run:${taskId}`
export const OPEN_CHILD_EVENT = 'agent-panel:open-child'

export function showChildInPane(parentId: string, childId: string) {
  try {
    localStorage.setItem(paneChildKey(parentId), childId)
    // 子对话和运行面板互斥：右栏同一时间只显示一个
    localStorage.removeItem(paneRunKey(parentId))
  } catch {
    // 存不下（隐私模式）：只靠下面的事件，已经开着的父对话照样能切过去
  }
  window.dispatchEvent(new CustomEvent(OPEN_CHILD_EVENT, { detail: { parentId, childId } }))
}
