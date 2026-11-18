import { useEffect, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { compValue } from '@shared/component-style'
import { t } from '@shared/i18n'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import { cn } from '@/lib/utils'
import { AutoFit, smartFit } from './auto-fit'

export { AutoFit, smartFit }

/** 小地图上节点的默认颜色：按 data.status 认几种常见状态，其余一律灰 */
export function statusMiniColor(n: Node) {
  const st = (n.data as { status?: string } | undefined)?.status
  if (st === 'done' || st === 'passed') return 'color-mix(in oklab, var(--success) 45%, var(--card))'
  if (st === 'running') return 'color-mix(in oklab, var(--run) 50%, var(--card))'
  if (st === 'failed') return 'color-mix(in oklab, var(--danger) 45%, var(--card))'
  return 'var(--line-strong)'
}

/**
 * 流程图右下角的小地图：工作流编辑器和插件画布（GameTest 流程图）共用一份。
 * 能拖、能滚轮缩放，点一下把画面中心移到点的位置（流程长了靠它跳过去）。
 * 显不显示、多宽在设置 → 组件 → 流程图画布里调（--c-canvas-*）；画布很窄时（容器查询 @2xl 以下）自动藏起来，
 * 免得压住底部工具条，所以外层要有 @container（GraphCanvas 自带）
 */
export function CanvasMiniMap({ nodeColor = statusMiniColor }: { nodeColor?: (n: Node) => string }) {
  const rf = useReactFlow()
  // 宽高要给数字：xyflow 按 style.width / height 算 viewBox，给 CSS 变量会算成 NaN（控制台报 path、viewBox 出错）
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const w = Number(compValue(style, 'canvas', 'minimapW')) || 180
  return (
    <MiniMap
      pannable
      zoomable
      position="bottom-right"
      ariaLabel={t('小地图')}
      onClick={(_, p) => void rf.setCenter(p.x, p.y, { zoom: rf.getZoom(), duration: 200 })}
      className="canvas-minimap !m-4 hidden overflow-hidden rounded-xl !bg-card shadow-pop @2xl:block"
      style={{ width: w, height: Math.round(w * 0.61) }}
      maskColor="color-mix(in oklab, var(--bg) 70%, transparent)"
      nodeColor={nodeColor}
      nodeBorderRadius={3}
      nodeStrokeWidth={0}
    />
  )
}

/**
 * 画布底部居中的浮动工具条（平移、加节点、自动排列、适应画布、撤销重做这类）：
 * 只是外框，按钮由调用方放 IconButton；窄画布时靠左，给左下角的缩放按钮让位
 */
export function CanvasToolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="toolbar"
      aria-label={t('画布工具')}
      className={cn(
        'absolute bottom-3 left-16 z-10 flex h-12 items-center gap-1 rounded-2xl bg-card px-2 shadow-pop md:bottom-4 @3xl:left-1/2 @3xl:-translate-x-1/2',
        className,
      )}
      {...rest}
    />
  )
}

/** 工具条里的竖分隔线 */
export const CanvasToolbarSep = () => <span aria-hidden className="mx-1 h-5 w-px bg-line" />

export type GraphCanvasProps<N extends Node = Node, E extends Edge = Edge> = ReactFlowProps<N, E> & {
  /** 能不能改：只读时左键也拖动画布、不能拖节点和连线 */
  editable?: boolean
  /** 平移模式：编辑时左键也拖动画布（工具条上的「平移」按钮） */
  panMode?: boolean
  /** 节点数超过它才出小地图（默认 4）；false 不要小地图 */
  minimap?: number | false
  miniColor?: (n: N) => string
  /** 节点量好尺寸、画布尺寸变了时自动适配（用户动过视口就不再动），默认开 */
  autoFit?: boolean
  /** 外层 div 的 class（要给定高度）；ReactFlow 本身的 class 用 className */
  frameClassName?: string
  /** 画在 ReactFlow 里面的东西（工具条、Panel、小部件），能用 useReactFlow */
  children?: ReactNode
}

/**
 * 通用流程图画布：面板工作流用的那套外观和手感（点状底、左下缩放、右下小地图、右键拖画布、首次自动适配），
 * 节点和连线由调用方给 nodeTypes / edgeTypes。插件经开放模块拿到它（插件接口 4，shared/plugins/host-modules.json），
 * 再配合同样开放的 @xyflow/react 写自己的节点，外观和面板保持一致，不用各插件自己再搭一遍。
 * 主题色在 web/src/index.css 的 .react-flow 段，可调项在设置 → 组件 → 流程图画布。
 */
export function GraphCanvas<N extends Node = Node, E extends Edge = Edge>({
  editable,
  panMode,
  minimap = 4,
  miniColor,
  autoFit = true,
  frameClassName,
  className,
  children,
  ...flow
}: GraphCanvasProps<N, E>) {
  const count = flow.nodes?.length ?? 0
  // 调用方不管节点变化（布局全由数据算的画布，比如 GameTest 流程图）时，画布自己收下量到的尺寸：
  // xyflow 的受控模式下不回写 measured，useNodesInitialized 一直是 false，自动适配、小地图都不工作。
  // 数据换了就换成新节点，但沿用同 id 节点量过的尺寸，免得每次改动都先藏起来再量一遍
  const own = !flow.onNodesChange && !!flow.nodes
  const [local, setLocal] = useState<N[]>(flow.nodes ?? [])
  useEffect(() => {
    if (!own) return
    setLocal((old) => {
      const seen = new Map(old.map((n) => [n.id, n.measured]))
      return (flow.nodes ?? []).map((n) => (n.measured || !seen.get(n.id) ? n : { ...n, measured: seen.get(n.id) }))
    })
  }, [own, flow.nodes])
  const owned = own
    ? { nodes: local, onNodesChange: (c: NodeChange<N>[]) => setLocal((ns) => applyNodeChanges(c, ns)) }
    : {}
  return (
    // 右键用来拖动画布，不弹浏览器菜单；按画布自己的宽度（容器查询）决定放不放小地图
    <div className={cn('@container relative min-h-0', frameClassName)} onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow<N, E>
        // 鼠标：左键点选、拖节点、空白处拉框选；右键（或中键）拖画布。只读或平移模式时左键也拖画布
        panOnDrag={editable && !panMode ? [1, 2] : true}
        selectionOnDrag={!!editable && !panMode}
        selectionMode={SelectionMode.Partial}
        nodesDraggable={!!editable}
        nodesConnectable={!!editable}
        edgesFocusable={!!editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        className={cn(!editable && 'read-only', className)}
        {...flow}
        {...owned}
      >
        {autoFit && <AutoFit />}
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.6} />
        <Controls showInteractive={false} position="bottom-left" />
        {minimap !== false && count > minimap && (
          <CanvasMiniMap nodeColor={miniColor as ((n: Node) => string) | undefined} />
        )}
        {children}
      </ReactFlow>
    </div>
  )
}
