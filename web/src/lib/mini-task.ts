/**
 * 「转成弹窗」：把正在看的对话收成右下角的浮条。
 *
 * 只记一件事——现在收起来的是哪个对话，所以同一时间只可能有一个对话浮条：
 * 再最小化另一个对话就把前一个换掉（前一个回到正常页面 / 留在列表里，什么都没丢）。
 * 跨类别（AI 排查、AI 优化）的互斥在 chat-dock.ts，这一份只管「是哪个对话」。
 *
 * 收起和展开都不动对话本身：这里不停止、不关闭对话，只是换个地方显示。
 */
import type { Task } from '@shared/schema'
import { taskBusy, taskState } from '@shared/task'
import type { ChatDockState } from './chat-dock'

export interface MiniTask {
  /** 对话 id */
  id: string
  /** 属于哪个项目：空表示 Chat 里的聊天 */
  projectId?: string
}

interface State {
  task?: MiniTask
}

let state: State = { task: undefined }
const listeners = new Set<() => void>()
const set = (p: State) => {
  state = p
  listeners.forEach((f) => f())
}

/** 转成弹窗：替换掉上一个被最小化的对话（就这一份，保证屏幕上只有一个对话浮条） */
export const minimizeTask = (task: MiniTask) => set({ task })

/**
 * 收起浮条：只收浮条，对话照常留在列表里、后台接着跑。
 * 和 AI 窗口不同，这里不需要留着 id 继续盯状态（侧栏就是那个对话的列表项），所以直接清空。
 */
export const closeMiniTask = () => set({ task: undefined })

/** 当前收起来的对话：单测和排查用，改状态走上面两个函数 */
export const miniTaskState = (): Readonly<State> => ({ ...state })

export function subscribeMiniTask(f: () => void) {
  listeners.add(f)
  return () => void listeners.delete(f)
}

/** 清回初始状态。单元测试用：state 是模块单例，会带到下一个用例 */
export const resetMiniTask = () => set({ task: undefined })

/** 展开时去哪：项目里的对话回项目，Chat 里的回聊天，都直接打开那个对话 */
export const taskRoute = (task: MiniTask) =>
  task.projectId
    ? { page: 'projects' as const, id: task.projectId, sub: task.id }
    : { page: 'chat' as const, id: task.id }

/**
 * 收起后页面停在哪：项目里的对话回项目首页、Chat 里的回新聊天页。
 * 不能停在原页面——那样对话页和浮条同时显示同一个对话，收起就没有意义了。
 */
export const minimizeBackRoute = (task: Pick<MiniTask, 'projectId'>) =>
  task.projectId ? { page: 'projects' as const, id: task.projectId } : { page: 'chat' as const }

/**
 * 浮条上的状态。和 AI 窗口的浮条用同一个 ChatDockState，
 * 「进行中 / 等你处理 / 失败 / 已完成」看起来才是同一种东西，不用另一套说法。
 *
 * `needs`（等你处理）和 `failed`（失败）不能并进「已结束」：用户收起来就是为了跟浮条看进度，
 * 把「在等你回答」和「跑失败了」都写成「已结束」，他会以为这一轮已经正常跑完。
 * 对话已经不在列表里（`undefined`）时标「对话已关闭」，和 AI 窗口对同一件事的处理一致。
 */
export function dockStateOf(task?: Task): ChatDockState {
  if (!task) return 'gone'
  // 顺序跟 convState 的优先级一致：needs / failed 都优先于「在忙」，
  // 先判 taskBusy 会让「在跑但同时在等你回答」显示成进行中，看不出在等他
  const state = taskState(task)
  if (state === 'needs') return 'needs'
  if (state === 'failed') return 'failed'
  if (taskBusy(task)) return 'running'
  return state === 'done' ? 'done' : 'ended'
}

/**
 * 页面现在是不是正显示这个对话：项目里比 `sub`、Chat 里比 `id`。
 * 正显示着就不该再挂浮条——同一份内容不能同时以页面和浮条两种形态出现。
 */
export const shownInPage = (task: MiniTask, route: { page: string; id?: string; sub?: string }) =>
  route.page === 'projects' ? route.sub === task.id : route.page === 'chat' && route.id === task.id
