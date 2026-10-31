import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { useNav, useTasks } from '@/lib/data'
import { closeMiniTask, dockStateOf, miniTaskState, shownInPage, subscribeMiniTask, taskRoute } from '@/lib/mini-task'
import { MinimizedChat } from '@/components/ui/minimized-chat'

/** 浮条上的标题：太长本来就会被浮条截断，这里只挡住异常长的 */
const LABEL_MAX = 80

/**
 * 「转成弹窗」后的对话浮条：挂在 App 顶层，切走页面、对话页卸载了它也还在。
 *
 * - 屏幕同时最多一个对话：状态在 mini-task.ts 里只存一份，再最小化另一个就换掉前一个
 * - 和 AI 排查 / AI 优化的浮条共用 chat-dock 的互斥（任意时刻最多一个浮条）
 * - **页面正显示的就是这个对话时不挂浮条**：用户从侧栏把它点开、或点了浮条的展开，
 *   同一份内容不能同时以页面和浮条两种形态出现；这时只是不渲染，状态留着，切走时它又回来
 *   （刻意不清状态：用户只是去看一眼，回来时接住原来的位置；要「打开即视为已展开」
 *   就改成在这里调 closeMiniTask）。注意它的副产品：如果先有一个被顶掉的浮条（例如 AI 排查），
 *   在这里让位时那个会自动回到屏幕上——和「关掉当前浮条后被顶掉的回来」是同一套机制，是预期行为
 * - 展开回那个对话所在的地方；关闭只是收起浮条，对话照常在列表里、后台接着跑
 */
export function TaskDock() {
  const [mini, setMini] = useState(miniTaskState)
  useEffect(() => subscribeMiniTask(() => setMini(miniTaskState())), [])
  const { tasks } = useTasks()
  const { go, route } = useNav()
  const current = mini.task
  const task = current ? tasks.find((x) => x.id === current.id) : undefined
  const state = dockStateOf(task)
  const running = state === 'running'
  // 收起期间跑完了：没展开过就点一个红点（和 AI 窗口的提醒方式一致）
  const [unseen, setUnseen] = useState(false)
  // 换了对话要重新算：上一个对话结束的提醒不能带到这一条上。
  // 只在「运行中 → 不运行」时亮起来：收起时本来就已经结束的对话，用户早就知道了
  const shownId = useRef(current?.id)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (shownId.current !== current?.id) {
      shownId.current = current?.id
      wasRunning.current = running
      setUnseen(false)
      return
    }
    if (wasRunning.current && !running) setUnseen(true)
    wasRunning.current = running
  }, [current?.id, running])
  if (!current || shownInPage(current, route)) return null
  const miniTask = current
  const expand = () => {
    closeMiniTask()
    setUnseen(false)
    // 对话已经删掉了就没有可回去的页面，收起浮条就好（列表里也没有它了）
    if (task) go(taskRoute(miniTask))
  }
  return (
    <MinimizedChat
      id="mini-task"
      label={t('对话：{title}', { title: (task?.title ?? miniTask.id).slice(0, LABEL_MAX) })}
      state={state}
      unseen={unseen}
      onExpand={expand}
      onClose={() => closeMiniTask()}
    />
  )
}
