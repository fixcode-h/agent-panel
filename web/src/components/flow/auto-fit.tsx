import { useEffect, useRef } from 'react'
import {
  getNodesBounds,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'

/**
 * 让流程图适合画布：放得下就居中显示全部；放不下时不缩得太小，从「开始」那一侧显示，其余拖动查看。
 * 返回设好的视口，AutoFit 用它判断用户后来有没有自己拖动、缩放过
 */
export function smartFit(rf: ReactFlowInstance, el: HTMLElement | null, duration = 0): Viewport | undefined {
  const nodes = rf.getNodes()
  if (!el || !nodes.length) return
  const b = getNodesBounds(nodes)
  const W = el.clientWidth
  const H = el.clientHeight
  if (!W || !H) return
  const pad = 48
  const fit = Math.min((W - pad * 2) / b.width, (H - pad * 2) / b.height)
  // 尽量整张图都放得下；太大时最小缩到 0.45，再小字就看不清了，剩下的靠小地图和拖动
  const zoom = Math.max(0.45, Math.min(1, fit))
  const x = zoom > fit ? pad - b.x * zoom : (W - b.width * zoom) / 2 - b.x * zoom
  const y = (H - b.height * zoom) / 2 - b.y * zoom
  const v = { x, y, zoom }
  void rf.setViewport(v, { duration })
  return v
}

const near = (a: Viewport, b: Viewport) =>
  Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.001

/**
 * 节点第一次量好尺寸时适配一次；之后画布尺寸变了（拖动分界线、窗口缩放、外层布局晚一步定高）或节点卡片长高了
 * （执行中补上耗时、验收行），只要用户还没自己拖动、缩放过，就重新适配。
 * 只在第一次适配时，运行页上面的流程图区域后来变矮，节点会被截掉下半截
 */
export function AutoFit() {
  const rf = useReactFlow()
  const ready = useNodesInitialized()
  const dom = useStore((s) => s.domNode)
  const size = useStore((s) => `${s.width}x${s.height}`)
  // 各节点量到的尺寸：位置不算，拖动节点不触发重新适配
  const dims = useStore((s) => {
    let k = ''
    s.nodeLookup.forEach(
      (n) => (k += `${n.id}:${Math.round(n.measured.width ?? 0)}x${Math.round(n.measured.height ?? 0)},`),
    )
    return k
  })
  const last = useRef<Viewport | undefined>(undefined)
  const first = useRef(true)
  useEffect(() => {
    if (!ready) return
    if (first.current) {
      first.current = false
      last.current = smartFit(rf, dom)
      return
    }
    // 用户动过视口就不再自动改，免得看着看着画面跳走
    if (!last.current || !near(rf.getViewport(), last.current)) return
    last.current = smartFit(rf, dom)
    // 只在就绪、画布尺寸、节点尺寸变化时检查；rf、dom 是稳定引用
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, size, dims])
  return null
}
