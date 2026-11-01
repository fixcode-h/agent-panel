import { Suspense, lazy, useRef, type ComponentProps } from 'react'
import type { AssistDialog as RealAssistDialog } from './AssistDialog'

// AI 助手弹窗带着流程图画布（@xyflow/react）和一大堆表单。对话页、项目工作区都会挂它（教训、技能优化），
// 静态引入会把整个画布打进首屏：这里换成第一次打开时才加载，之后一直挂着，关闭动画照常
const Inner = lazy(() => import('./AssistDialog').then((m) => ({ default: m.AssistDialog })))

export function AssistDialog(props: ComponentProps<typeof RealAssistDialog>) {
  const opened = useRef(false)
  if (props.open) opened.current = true
  if (!opened.current) return null
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  )
}
