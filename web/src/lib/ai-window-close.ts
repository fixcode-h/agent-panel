/**
 * 关掉 AI 分析窗口时怎么处理：只关窗口，分析继续在后台跑（对话在列表里还在）。
 *
 * 两个关闭入口（最小化浮条的 ✕、窗口标题栏的 ✕）语义完全一样，都走这里，
 * 以后要改关闭行为只改这一处，别在组件里各写一份。
 * 停掉分析不再挂在关闭上：要停就去对话里的输入框点停止（窗口里嵌的就是那个对话）。
 */
import type { Task } from '@shared/schema'

/** 判断关闭时要不要提醒、要不要清状态，用得到的这几项 */
export interface CloseState {
  /** 这次分析的对话；还在新建时没有 */
  taskId?: string
  status?: Task['status']
  starting: boolean
  /** 对话已经从列表里删掉了 */
  gone: boolean
  job?: { label: string; title: string }
}

/** 关窗口后 state 怎么变；undefined 的字段表示清掉，不是「不改」 */
export interface ClosePatch {
  open: false
  minimized: false
  /** 对话已经删掉时要清：watch() 已经退出，清掉不影响提醒，但留着会让新建不出下一个分析 */
  taskId?: undefined
  status?: undefined
  gone?: false
}

export interface ClosePlan {
  patch: ClosePatch
  /**
   * 还在分析：关窗口时说清分析没停，并给一个回窗口的入口。
   * running 是「对话已经在跑」，starting 是「还在新建」，两者说的事不一样，不能混：
   * 新建有可能失败（没有可用的 CLI 等），那时候说「继续在后台进行」是假的。
   */
  notify?: { kind: 'running' | 'starting'; label: string; title: string }
}

export function closeWindowPlan(s: CloseState): ClosePlan {
  // 对话都被删了：连状态一起清干净。status 会冻在最后一次轮到的值（可能是 running），
  // 留着的话 openAiWindow 会一直当它还在跑，新的分析永远建不出来；watch() 此时已经退出，清了不影响后台提醒
  if (s.gone) return { patch: { open: false, minimized: false, taskId: undefined, status: undefined, gone: false } }
  const kind = s.status === 'running' ? 'running' : s.starting ? 'starting' : undefined
  return {
    // 故意不清 taskId / status：watch() 靠它们继续盯着对话，后台跑完才有提醒
    patch: { open: false, minimized: false },
    notify: kind && s.job ? { kind, label: s.job.label, title: s.job.title } : undefined,
  }
}
