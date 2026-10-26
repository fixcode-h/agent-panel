import { useCallback, useMemo, useState } from 'react'
import {
  LOAD_STEPS,
  abortWaiting,
  createTrace,
  failStep,
  finishStep,
  recoverStep,
  skipStep,
  startStep,
  type TraceStep,
  type TraceStepId,
} from './load-trace'

/**
 * 打开对话时的加载日志状态。各步的埋点在 TaskView 里请求真正发起 / 返回的位置调用，
 * 这里只负责把新状态交给界面：都是内存里换一个数组，不发额外请求、不拖慢加载。
 */
export function useLoadTrace(ids: readonly TraceStepId[] = LOAD_STEPS) {
  // ids 是常量表，不用进依赖；换对话时靠 reset 回到初始状态
  const [steps, setSteps] = useState<TraceStep[]>(() => createTrace(ids))
  const update = useCallback((fn: (cur: TraceStep[]) => TraceStep[]) => setSteps(fn), [])

  const start = useCallback((id: TraceStepId) => update((cur) => startStep(cur, id)), [update])
  const finish = useCallback(
    (id: TraceStepId, detail?: string) => update((cur) => finishStep(cur, id, Date.now(), detail)),
    [update],
  )
  /** 失败：留下错误原文，不吞；阻塞性失败之后由调用方调 abort 把没轮到的步骤标成「未执行」 */
  const fail = useCallback((id: TraceStepId, error: string) => update((cur) => failStep(cur, id, error)), [update])
  const abort = useCallback(() => update((cur) => abortWaiting(cur)), [update])
  /** 失败后确认恢复了（例如实时推送重连成功）：改回完成并清掉错误，免得面板一直误报「加载失败」 */
  const recover = useCallback(
    (id: TraceStepId, detail?: string) => update((cur) => recoverStep(cur, id, detail)),
    [update],
  )
  const skip = useCallback((id: TraceStepId, detail?: string) => update((cur) => skipStep(cur, id, detail)), [update])
  /** 换了一条对话：重新从头记（组件实例可能被复用） */
  const reset = useCallback(() => setSteps(createTrace(ids)), [ids])

  return useMemo(
    () => ({ steps, start, finish, fail, abort, recover, skip, reset }),
    [steps, start, finish, fail, abort, recover, skip, reset],
  )
}
