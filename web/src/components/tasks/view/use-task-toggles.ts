/**
 * 对话页上几块浮层的开关：盖在对话上的文件面板（窄屏）、浮着的任务进度、「对话进程」下拉，以及按 Esc 收起前两个。
 * 从 TaskView.tsx 拆出来（复查报告 B2）
 */
import { useState } from 'react'
import { useEscape } from '@/lib/useEscape'

export function useTaskToggles() {
  // 「对话进程」下拉：钉在标题栏时由它自己的按钮开关，没钉时从菜单打开，开关放在这一层
  const [procOpen, setProcOpen] = useState(false)
  // 窄屏下盖在对话上的文件面板
  const [panel, setPanel] = useState(false)
  // 左边空白不够放任务进度时（窄屏），从标题栏打开，浮在对话上面
  const [progressOpen, setProgressOpen] = useState(false)
  useEscape(panel, () => setPanel(false))
  useEscape(progressOpen, () => setProgressOpen(false))
  return { procOpen, setProcOpen, panel, setPanel, progressOpen, setProgressOpen }
}
