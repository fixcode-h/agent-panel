import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { type AnalysisKind, type Attachment, type Task } from '@shared/schema'
import { analysisHome, analyzerId, rootIdOf, type AnalysisScope } from '@shared/analysis-home'
import { t } from '@shared/i18n'
import { type ClosePlan, closeWindowPlan } from './ai-window-close'
import { api } from './api'
import { analysisTiming, type AnalysisTiming } from './analysis-report'

/**
 * 统一的 AI 分析窗口：面板上所有「AI 分析」「AI 排查」只管调用 openAiWindow，
 * 对话按归属规则建好（见 shared/analysis-home.ts：项目里的对话另开项目顶层对话、子对话的开成它顶层对话的子对话、
 * 其余开 Chat），统一用必备角色「分析」，显示在最外层的同一个窗口（AiWindow）里：最小化成右下角的浮条，分析照常进行。
 * 关闭（浮条或窗口标题栏的 ✕）只收窗口，同样不停分析：对话在列表里还在、后台跑完会提醒。
 * 要停分析去对话里的输入框点停止，两个关闭入口都不再兼职停止。
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
  /** 这一轮分析实际的用时（标题栏状态胶囊上显示）；拿不到准确的起止时为空 */
  timing?: AnalysisTiming
  /** 对话被关掉了（从列表里删掉）：窗口不跟着关，显示「对话已关闭」，等用户自己点关闭 */
  gone: boolean
  starting: boolean
  /** 开始时就失败了（例如没有可用的 CLI） */
  error?: string
}
let state: State = { open: false, minimized: false, gone: false, starting: false }
/** 给测试和排查看的状态快照：只读，不含内部字段的写入口 */
export type AiWindowSnapshot = Readonly<State>
const listeners = new Set<() => void>()
const set = (p: Partial<State>) => {
  state = { ...state, ...p }
  listeners.forEach((f) => f())
}

const running = (s?: Task['status']) => s === 'running'
/** 还在跑时多久看一次状态：浮条和结束提醒都要跟得上 */
const RUNNING_POLL_MS = 1500
/** 结束后多久再看一眼：只看对话还在不在（删了要标「对话已关闭」），不用那么勤 */
const ENDED_POLL_MS = 5000
/**
 * 结束后最多再盯几轮就收手：结束时已经提醒过了，再盯只是为了分辨「删掉了」和「又被接着问了」。
 * 不封顶的话，关了窗口再也不开 AI 分析的会话里会一直每 5 秒发一次请求，直到刷新页面。
 */
const ENDED_POLL_MAX = 12

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
  // 结束后已经慢速盯了几轮：查不多之后就收手，不把轮询永久挂在后台
  let slowTicks = 0
  const tick = async () => {
    if (state.taskId !== id) return
    try {
      const task = await api.task(id)
      if (state.taskId !== id) return
      set({ status: task.status, timing: analysisTiming(task) })
      // 结束后又被接着问了：这一轮结束时还要再提醒、再交回结果
      if (running(task.status)) {
        finished = false
        slowTicks = 0
        return void setTimeout(tick, RUNNING_POLL_MS)
      }
      if (!finished) {
        finished = true
        state.job?.onDone?.(task)
        if (!state.open || state.minimized)
          toast(t('{label}结束：{title}', { label: state.job?.label ?? '', title: state.job?.title ?? '' }), {
            action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) },
          })
      }
      // 对话结束了不代表用户关了窗口：放慢节奏继续看一眼，之后删掉时要能标出来。
      // 但不能无限盯：关掉窗口又再也不开 AI 分析的会话里，这里会每 5 秒发一次请求直到刷新。
      // 结束后降到 ENDED_POLL_MS 一次，再盯 ENDED_POLL_MAX 次就收手（还能盖住「被接着问了又结束」这种短期情况）
      slowTicks += 1
      if (slowTicks > ENDED_POLL_MAX) return
      setTimeout(tick, ENDED_POLL_MS)
    } catch (e) {
      if (state.taskId !== id) return
      if (isTaskGone(e)) return void set({ gone: true })
      // 网络抖动之类的先不判死：下一轮再看。但后端一直不通时也不能无限发请求，
      // 和结束后那一支用同一个计数、同一个慢节奏
      slowTicks += 1
      if (slowTicks > ENDED_POLL_MAX) return
      setTimeout(tick, ENDED_POLL_MS)
    }
  }
  setTimeout(tick, RUNNING_POLL_MS)
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
    timing: undefined,
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
      timing: analysisTiming(task),
      starting: false,
    })
    watch(task.id)
  } catch (e) {
    set({ error: (e as Error).message, starting: false })
    // 窗口已经关掉了：错误得弹出来，否则用户只看到「正在新建」那句话，真正的原因留在看不见的窗口里
    if (!state.open) toast.error((e as Error).message)
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
/** 收起窗口但不停止（去对话里看了），也不提醒：用户自己走过去看的 */
export const hideAiWindow = () => set({ open: false, minimized: false })

/**
 * 关掉窗口：只收窗口，不停止分析（浮条和标题栏的两个 ✕ 都是这个）。
 * taskId / status 故意留着：watch() 靠它们继续盯着，后台跑完照样弹「{label}结束」+「查看」；
 * 还在分析时再补一句「分析继续在后台进行」，免得用户以为关掉就把分析停了。
 */
export function closeAiWindow() {
  const plan: ClosePlan = closeWindowPlan(state)
  set(plan.patch)
  if (!plan.notify) return
  // 还在新建：只是还没建完，别断言「在后台进行」——建失败时这句就是假的，失败会另外提示
  if (plan.notify.kind === 'starting')
    return toast(
      t('{label}正在新建对话，关掉窗口不影响它继续建：{title}', {
        label: plan.notify.label,
        title: plan.notify.title,
      }),
      { action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) } },
    )
  toast(t('{label}继续在后台进行：{title}', { label: plan.notify.label, title: plan.notify.title }), {
    action: { label: t('查看'), onClick: () => set({ open: true, minimized: false }) },
  })
}
export const aiWindowRunning = () => state.starting || running(state.status)
/** 当前窗口状态的快照：单测和排查用，改状态走上面的函数 */
export const aiWindowState = (): AiWindowSnapshot => ({ ...state })
/**
 * 清回初始状态。单元测试用：state 是模块单例，上一个用例留下的 taskId/starting
 * 会让下一个用例的 openAiWindow 以为「还有一个在分析」，也会让 watch() 的轮询停不下来。
 */
export const resetAiWindow = () => {
  // 先把 taskId 清掉：已经排上的 watch() 下一拍会因为 state.taskId !== id 直接退出，
  // 否则旧轮询会和测试里新建的 watch 同时跑（两个用例都用 'task-1'，光换 state 拦不住）
  state = { open: false, minimized: false, gone: false, starting: false }
  listeners.forEach((f) => f())
}

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

/**
 * 按归属规则新建一个分析对话：放在哪由 analysisHome 定，角色用必备角色「分析」。
 * 「提问」默认关着（用户 2026-10-25 要求），开成子对话时也不跟父对话的开关；要问的在对话里打开
 */
export async function createAnalysisTask(opts: {
  scope: AnalysisScope
  /** 哪种分析：标题区分、右侧功能面板按它挑内容 */
  kind: AnalysisKind
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
    askUser: opts.askUser ?? false,
    analysis: opts.kind,
    // 分析的是某个对话：记下它，结论里的「在当前对话里修」把修复建议发回那个对话
    ...(opts.scope.kind === 'task' && { analysisOf: opts.scope.task.id }),
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

/** 对话页右栏记住开着哪个子对话、哪次运行、文件面板收没收起（TaskView 读同一组键） */
export const paneChildKey = (taskId: string) => `task-child:${taskId}`
export const paneRunKey = (taskId: string) => `task-run:${taskId}`
export const paneFilesKey = (taskId: string) => `task-files:${taskId}`
/** 分析对话的功能面板收没收起（默认开着） */
export const paneReportKey = (taskId: string) => `task-report:${taskId}`
export const OPEN_CHILD_EVENT = 'agent-panel:open-child'
export const SHOW_PARENT_EVENT = 'agent-panel:show-parent'

/**
 * 侧栏里点的正好是当前打开的对话：地址不变、页面不会重挂，
 * 发个事件让对话页把父对话切到前台（子对话 / 运行页签留着）
 */
export function showParentTab(taskId: string) {
  window.dispatchEvent(new CustomEvent(SHOW_PARENT_EVENT, { detail: taskId }))
}

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
