/**
 * 对话页顶层弹窗的开关（画在 TaskDialogs.tsx）：标题栏菜单、消息菜单、文件路径、后台命令行都往这一份里写。
 * 从 TaskView.tsx 拆出来（复查报告 B2）
 */
import { useCallback, useState } from 'react'
import type { JobTarget } from '../JobDialog'
import { NO_DIALOGS, type TaskDialogState } from './TaskDialogs'

export function useTaskDialogs() {
  const [dialogs, setDialogs] = useState<TaskDialogState>(NO_DIALOGS)
  const setDialog = useCallback(
    <K extends keyof TaskDialogState>(key: K, value: TaskDialogState[K]) => setDialogs((s) => ({ ...s, [key]: value })),
    [],
  )
  // Agent 输出里点了文件路径：在弹窗里看文件内容
  const openFile = useCallback((path: string, line?: number) => setDialog('fileTarget', { path, line }), [setDialog])
  // 后台命令行的标题点了：在顶层打开这条命令的窗口。挂在页面顶层而不是运行区那一行里，
  // 命令跑完那一行会消失，窗口跟着行卸载的话用户正好看不到最终输出
  const openJob = useCallback((job: JobTarget) => setDialog('jobTarget', job), [setDialog])
  return { dialogs, setDialog, openFile, openJob }
}
