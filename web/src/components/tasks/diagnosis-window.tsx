import { useCallback, useContext, useState } from 'react'
import type { Task } from '@shared/schema'
import { PaneNavCtx } from './child-open'
import { DiagnosisDialog } from './DiagnosisDialog'

/** 审阅弹窗要的任务字段：标题和各版报告 */
export type DiagnosisTarget = Pick<Task, 'id' | 'title' | 'diagnoses'>

/**
 * 诊断报告审阅弹窗挂在任务页顶层（和后台命令窗口同一个做法）。
 * 以前弹窗挂在打开它的那一行里（运行区的「诊断报告」行、交报告那一行工具调用、子对话行的「查看报告」）：
 * 对话输出完一轮、子任务做完推回结果时，运行区跟着挂到新一段总结下面、交报告那一行收进折叠，
 * 那一行一卸载弹窗就跟着没了，用户正在看、正在标注的报告被关掉。弹窗只该由用户关。
 * live 是任务页这一刻的任务：打开的正好是它自己的报告时，弹窗读最新一份（新一版、状态变化跟着更新）
 */
export function useDiagnosisHost(live?: DiagnosisTarget | null) {
  const [target, setTarget] = useState<DiagnosisTarget | null>(null)
  // auto 是报告交上来时自动弹：已经开着另一个对话的报告就不顶掉它（用户可能正标注到一半），同一个对话的照常换成新的
  const open = useCallback(
    (task: DiagnosisTarget, auto?: boolean) => setTarget((cur) => (!auto || !cur || cur.id === task.id ? task : cur)),
    [],
  )
  const shown = target && live && target.id === live.id ? live : target
  const dialog = shown ? <DiagnosisDialog task={shown} open onOpenChange={(o) => !o && setTarget(null)} /> : null
  const showing = !!target
  // 任务页把这两个放进 PaneNav，行里的 useDiagnosisWindow 从那里拿
  return { open, dialog, showing, nav: { diagnosis: open, diagnosisShowing: showing } }
}

/**
 * 行里打开诊断报告：在任务页里交给顶层的弹窗（见 useDiagnosisHost），
 * 不在任务页里（独立使用的组件）才退回自己挂一个，dialog 由调用方渲染
 */
export function useDiagnosisWindow(live?: DiagnosisTarget | null) {
  const nav = useContext(PaneNavCtx)
  const local = useDiagnosisHost(live)
  return nav?.diagnosis ? { open: nav.diagnosis, dialog: null, showing: !!nav.diagnosisShowing } : local
}
