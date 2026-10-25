/**
 * 最小化浮条的互斥：屏幕任意时刻最多只显示一个浮条。
 *
 * `MinimizedChat` 只负责画，谁该显示由这里决定：组件挂载时登记、卸载时注销，
 * 只有最后登记的那一个（栈顶）渲染，其余的留在栈里等它让位（被关闭、展开或换了一条新的）。
 * 「AI 排查」「AI 优化」「对话」三类浮条因此自动共用同一条约束，不用各自再写一套互斥。
 *
 * 登记的单位是**实例**而不是业务 id：同一个 id 可能同时挂两个组件（`AssistDialog` 在几个页面各挂一份，
 * id 都是 `assist`），按 id 判会让两个都以为自己是栈顶、一起显示，互斥就被绕过了。
 * 所以由调用方给每条浮条一个实例号，业务 id 只用来记位置。
 *
 * 纯逻辑抽出来单独测：登记顺序、注销后栈顶是谁、被顶掉的怎么回到栈顶，都只有这一份实现。
 */

/**
 * 浮条上的状态。三类浮条共用同一套文字，看起来才是同一个东西；
 * `needs`（等你处理）和 `failed`（失败）单独分出来：都归到「已结束」会让用户以为跑完了，
 * 实际还在等他回答或已经出错。
 */
export type ChatDockState = 'running' | 'needs' | 'failed' | 'done' | 'ended' | 'gone' | 'idle'

/** 登记顺序就是层叠顺序：后登记的在上面（用户刚最小化的那个应该立刻看得到） */
let stack: string[] = []
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((f) => f())

/** 现在该显示哪一个（栈顶）：没有浮条时为 undefined */
export const topDock = (ids: readonly string[] = stack) => ids[ids.length - 1]

/** 这条浮条现在该不该显示：只有栈顶显示，其余都藏着等让位。key 是实例号，不是业务 id */
export const dockVisible = (key: string, keys: readonly string[] = stack) => topDock(keys) === key

/**
 * 登记一条浮条并把它放到栈顶。
 * 同一个实例重复登记（StrictMode 下先卸载再挂载、热更新）只把它提回栈顶，不留两条。
 */
export const registerDock = (key: string, keys: readonly string[] = stack): string[] => [
  ...keys.filter((x) => x !== key),
  key,
]

/** 注销一条浮条（收起 / 展开 / 组件卸载）：它让出位置，下一个自动露出来 */
export const unregisterDock = (key: string, keys: readonly string[] = stack): string[] => keys.filter((x) => x !== key)

/**
 * 当前栈。必须是**同一个引用**返回给 useSyncExternalStore：每次 slice 出新数组的话，
 * React 会认为快照一直在变，渲染 → 读快照 → 又渲染，直接撞上 Maximum update depth（error #185）。
 * 所以栈只在登记 / 注销时换成新数组，读的时候直接给这一个。
 */
export const dockSnapshot = () => stack

export function subscribeDock(f: () => void) {
  listeners.add(f)
  return () => void listeners.delete(f)
}

/** 组件挂载即登记：返回注销函数，交给 useEffect 清理。key 由调用方给，要能区分实例 */
export function addDock(key: string) {
  stack = registerDock(key)
  emit()
  return () => {
    stack = unregisterDock(key)
    emit()
  }
}

/**
 * 清空栈。单元测试用：state 是模块单例，上一个用例留下的浮条会让下一个用例的栈顶判断错位。
 */
export const resetDock = () => {
  stack = []
  emit()
}
