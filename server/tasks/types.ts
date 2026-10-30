import type { HelperSpec, Orchestra } from '../../shared/engine.ts'
import type { StopReason, Task } from '../../shared/schema.ts'

/** tasksApi 依赖的列表源（角色、工作流、项目、项目分类） */
export type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 执行位：执行中的任务放在内存里。rev：执行中每次有变化加一，实时推送靠它判断要不要比较内容 */
export type Live = {
  task: Task
  stop: boolean
  /** 为什么停：只有 'user' 是用户按的暂停，其余是顺带结束的动作（见 shared/schema.ts 的 StopReason） */
  stopReason?: StopReason
  abort: AbortController
  done?: Promise<void>
  rev: number
  /**
   * 这一轮对话级的 Orchestra（引擎每轮构造时回调，轮结束清掉）：
   * 子对话转交来的「禁止子对话执行」的子任务直接派到这里（见 ADR 0019）
   */
  orch?: Orchestra
  /** 换 CLI/模型/强度时由 PATCH 负责重启，收尾不要重复预热 */
  restart?: boolean
}

/** 子对话转交给父对话的子任务请求：父对话下一轮建 Orchestra 时直接派 */
export type ForwardedSpawn = { from: string; fromTitle: string; spec: HelperSpec; at: string }

/**
 * 按取值函数建 TasksScope：每个名字取值时才读闭包（声明顺序不影响），let 变量再给一个写入函数。
 * 写成取值函数而不是直接放值：闭包里很多名字是后面才解构出来的常量，建 scope 时还没有值。
 */
export function lazyScope<T extends object>(get: {
  [K in keyof T]: (() => T[K]) | readonly [() => T[K], (v: T[K]) => void]
}): T {
  const out = {} as T
  for (const [key, fn] of Object.entries(get) as [string, (() => unknown) | [() => unknown, (v: unknown) => void]][])
    Object.defineProperty(
      out,
      key,
      Array.isArray(fn) ? { get: fn[0], set: fn[1], enumerable: true } : { get: fn, enumerable: true },
    )
  return out
}
