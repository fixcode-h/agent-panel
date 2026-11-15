/**
 * 右栏页签条上的网页页签（设计稿第 6 节）：切换跟着 openWebTab 走，关掉后回默认页签，
 * 并把「右栏现在是不是网页」报给 lib/web-view/tabs.ts。从 TaskFiles 拆出来，那边只留调用
 */
import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import { t } from '@shared/i18n'
import { closeWebTab, setWebShown, type WebTab, type useWebTabs } from '@/lib/web-view/tabs'
import { TabItem } from '@/components/ui/tab-bar'

/** 右栏当前停在哪个网页页签上（不在网页页签上时是 undefined） */
export function useWebRail(
  taskId: string,
  web: ReturnType<typeof useWebTabs>,
  tab: string,
  setTab: (tab: string) => void,
  home: string,
) {
  const onWeb = web.tabs.find((x) => tab === `web:${x.id}`)
  // 回复里、地址栏里新开了网页（openWebTab）就切到它；挂上时那一次已经按 shown 停好了
  const seen = useRef(web.focus)
  useEffect(() => {
    if (web.focus === seen.current) return
    seen.current = web.focus
    if (web.active) setTab(`web:${web.active}`)
    // setTab 是 useState 的 setter，不会变
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [web.focus, web.active])
  // 网页页签被关掉了：回默认页签
  useEffect(() => {
    if (tab.startsWith('web:') && !onWeb) setTab(home)
    // 同上
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, onWeb, home])
  // 告诉别处现在右栏是不是网页页签（回复里的 HTML 卡片据此标「右栏正在显示」）
  const shown = onWeb?.id ?? ''
  useEffect(() => setWebShown(taskId, shown), [taskId, shown])
  return onWeb
}

export function WebTabItems({
  taskId,
  tabs,
  current,
  onSelect,
}: {
  taskId: string
  tabs: WebTab[]
  current?: string
  onSelect: (id: string) => void
}) {
  return tabs.map((x) => (
    <TabItem
      key={x.id}
      active={current === x.id}
      onSelect={() => onSelect(x.id)}
      onClose={() => closeWebTab(taskId, x.id)}
      closeLabel={t('关闭网页')}
      title={x.target.kind === 'file' ? x.target.path : x.target.url}
      icon={<Globe className="h-[0.8125rem] w-[0.8125rem]" />}
      className="max-w-[12rem] min-w-[5rem] shrink"
    >
      <span data-web-tab>{x.title}</span>
    </TabItem>
  ))
}
