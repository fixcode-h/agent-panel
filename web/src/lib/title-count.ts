/**
 * 标签页标题里的「(n)」：n 是正在执行的任务数。
 *
 * 「正在执行」只在 taskBusy 里定义（自己在跑、名下子对话在跑、在等派出的子任务、工作流运行没跑完）：
 * 侧栏「N 个执行中」、行首转圈、标题计数都读它，不再各算一套——只看 working 会因为子对话在跑、
 * 后台命令在跑而少算，出现「两行在转圈、标题写 (1)」。
 *
 * 跟着它直接改标题会一闪一闪：CLI 报完一轮结果到下一轮开始之间会短暂变 false。
 * 所以数量的变化要「稳够一段时间」才认：新起的任务（0 → n）立刻显示，免得刚启动却迟迟看不到；
 * 其他变化等稳够时间再改，加任务短一点、减任务长一点（减任务往往只是这一轮做完了）。
 *
 * 这里只有纯计算，定时器在 notify.ts 的 useRunningTitle 里；单测用模拟时钟回放抖动序列。
 */
import { t } from '@shared/i18n'

/** 数量增加（不是从 0 起来）时稳这么久才改标题 */
export const TITLE_SETTLE_UP = 400
/** 数量减少时稳这么久才改：吸收「报 result / 等下一句」的抖动 */
export const TITLE_SETTLE_DOWN = 1600

export interface TitleState {
  /** 已经写进 document.title 的数量 */
  shown: number
  /** 最近一次看到的数量；和 shown 不同说明正在等它稳下来 */
  target: number
  /** target 变成现在这个值的时间 */
  since: number
}

const clean = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0)

/** 还在执行的任务数：定义只在 shared/task.ts 的 taskBusyCount（侧栏、行首转圈同一个判定） */
export { taskBusyCount as countBusy } from '@shared/task'

/** 标题本体；托盘标记由 page-signal.ts 接在后面 */
export function titleFor(count: number): string {
  return count > 0 ? `(${count}) ${t('Agent 面板')}` : t('Agent 面板')
}

/** 打开页面时已经有任务在跑就直接显示数量，不从 0 慢慢爬 */
export function initialTitleState(count: number, now = 0): TitleState {
  const shown = clean(count)
  return { shown, target: shown, since: now }
}

/** 从 shown 变成 target 要稳多久：0 → n 立刻改 */
export function settleFor(shown: number, target: number): number {
  if (shown === 0) return 0
  return target > shown ? TITLE_SETTLE_UP : TITLE_SETTLE_DOWN
}

/**
 * 拿到一个新的数量之后的状态，shown 就是此刻该显示的数量。
 * 目标没变够久才认，抖动期间 shown 不动，标题就不会来回切。
 */
export function nextTitleState(prev: TitleState, count: number, now: number): TitleState {
  const target = clean(count)
  if (target === prev.shown) return prev.target === target ? prev : { shown: prev.shown, target, since: now }
  // 目标变了就从现在重新计时；目标没变就一直用它开始的时间
  const since = target === prev.target ? prev.since : now
  if (now - since >= settleFor(prev.shown, target)) return { shown: target, target, since: now }
  return { shown: prev.shown, target, since }
}

/** 还要等多久再算一次；undefined 表示数量已经和标题一致，不用等 */
export function titleWait(state: TitleState, now: number): number | undefined {
  if (state.target === state.shown) return undefined
  return Math.max(0, settleFor(state.shown, state.target) - (now - state.since))
}
