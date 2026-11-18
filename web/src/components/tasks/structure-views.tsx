import { lazy, Suspense, useEffect, useState } from 'react'
import { useNav } from '@/lib/data'
import { usePlugins } from '@/plugins/registry'
import { openWrap, useWrapRequest } from '@/plugins/wrap-state'

/** 包装弹窗只有点了「安装 Archify」才用到，不跟着 Markdown 一起加载 */
const WrapDialog = lazy(() => import('@/plugins/WrapDialog').then((m) => ({ default: m.WrapDialog })))

/** Archify 的官方配方（插件仓库 wraps/tt-a1i__archify.json），包装后插件 id 是 archify */
export const ARCHIFY = { id: 'archify', url: 'https://github.com/tt-a1i/archify' }

/** 切到某个页签：页签条的选中样式、面板的显示都写在元素上（渲染出来的 HTML，不经 React 状态） */
function switchTab(box: HTMLElement, kind: string) {
  const tab = box.querySelector<HTMLButtonElement>(`[data-sv-tab="${CSS.escape(kind)}"]`)
  if (tab?.disabled) return
  box.dataset.svOn = kind
  box.querySelectorAll<HTMLElement>('.sv-tab').forEach((b) => {
    const on = b.dataset.svTab === kind
    b.classList.toggle('seg-thumb', on)
    b.setAttribute('aria-selected', String(on))
  })
  box
    .querySelectorAll<HTMLElement>('.sv-panel')
    .forEach((p) => p.toggleAttribute('data-on', p.dataset.svPanel === kind))
}

/** 点的是图上哪个节点：取那一块的文字（时序图点方框时取同一组里参与者的名字） */
function clickedName(target: Element): string {
  const own = target.closest('text, .nodeLabel, .classTitle')
  const g = target.closest('g')
  const el = own ?? g?.querySelector('text.actor, .nodeLabel, .classTitle, text')
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 图上点到的节点 → 下面那一行对应的文件标记，点它打开文件（和正文里的文件标记同一条路） */
function openNode(panel: HTMLElement, target: Element): boolean {
  const name = clickedName(target)
  if (!name) return false
  const nodes = [...panel.querySelectorAll<HTMLElement>('[data-sv-node]')]
  const hit =
    nodes.find((n) => n.dataset.svLabel === name || n.dataset.svNode === name) ??
    nodes.find((n) => name.startsWith(n.dataset.svLabel ?? '\0') || name.startsWith(n.dataset.svNode ?? '\0'))
  const ref = hit?.querySelector<HTMLElement>('[data-file-ref]')
  if (!hit || !ref) return false
  ref.click()
  hit.classList.add('sv-flash')
  setTimeout(() => hit.classList.remove('sv-flash'), 1200)
  return true
}

/**
 * 诊断报告「功能结构」页签的交互（HTML 在 web/src/lib/markdown/structure.ts 出）：切页签、点图上的节点打开代码、
 * 架构页没画时按 Archify 装没装、开没开显示不同的说明，「安装 Archify」直接弹包装弹窗（不离开报告）。
 * 返回点击处理（是这里的点击就处理掉并返回 true）和包装弹窗那一层
 */
export function useStructureViews(root: React.RefObject<HTMLDivElement | null>, html: string) {
  const { rows } = usePlugins()
  const { openSettings } = useNav()
  const wrapReq = useWrapRequest()
  const [asked, setAsked] = useState(false)
  const row = rows.find((r) => r.manifest.id === ARCHIFY.id)
  const state = !row ? 'off' : row.enabled ? 'on' : 'idle'
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('.md-sv').forEach((el) => (el.dataset.archify = state))
  }, [root, html, state])
  // 包装弹窗关了（装好或取消）就把这一层撤掉，免得和插件页里的那一份同时挂着
  useEffect(() => {
    if (asked && !wrapReq) setAsked(false)
  }, [asked, wrapReq])

  const onClick = (e: React.MouseEvent): boolean => {
    const target = e.target as HTMLElement
    const box = target.closest<HTMLElement>('.md-sv')
    if (!box) return false
    const tab = target.closest<HTMLElement>('[data-sv-tab]')
    if (tab) {
      switchTab(box, tab.dataset.svTab ?? '')
      return true
    }
    const act = target.closest<HTMLElement>('[data-sv-act]')?.dataset.svAct
    if (act === 'archify') {
      setAsked(true)
      openWrap({ url: ARCHIFY.url })
      return true
    }
    if (act === 'plugins') {
      openSettings('plugins')
      return true
    }
    const panel = target.closest<HTMLElement>('.sv-panel')
    if (panel && target.closest('.md-mermaid-svg') && !target.closest('[data-mmd]')) return openNode(panel, target)
    return false
  }
  const layer = asked ? (
    <Suspense fallback={null}>
      <WrapDialog />
    </Suspense>
  ) : null
  return { onClick, layer }
}
