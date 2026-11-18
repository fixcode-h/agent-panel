import { useState, type ComponentType, type ReactNode } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Hand, LayoutGrid, Plus } from 'lucide-react'
import type { CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { CountBadge } from '@/components/ui/count-badge'
import { IconButton } from '@/components/ui/icon-button'
import { CanvasToolbar, CanvasToolbarSep, GraphCanvas } from '@/components/flow/GraphCanvas'
import { Group } from '@/components/settings/parts'

/**
 * 设置 → 组件里「流程图画布」的样例：通用画布 GraphCanvas（插件也用它画自己的流程图）和圆底数字角标。
 * 节点是一排示例卡片，够数量才出小地图；角标演示 0 不显示、两位数、超过 999 写「999+」
 */
type Demo = Node<{ label: string; hits: number; status?: string }>

function DemoNode({ data }: NodeProps<Demo>) {
  return (
    <div className="relative w-32 rounded-xl bg-card px-3 py-2 text-body shadow-card">
      <Handle type="target" position={Position.Left} />
      {data.label}
      <CountBadge corner count={data.hits} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { demo: DemoNode }
const N = [t('登录'), t('打开福利'), t('领取'), t('等弹窗'), t('点确定'), t('检查红点')]
const nodes: Demo[] = N.map((label, i) => ({
  id: `n${i}`,
  type: 'demo',
  position: { x: i * 180, y: i % 2 ? 40 : 0 },
  data: { label, hits: [0, 3, 0, 12, 0, 1200][i], status: i < 2 ? 'done' : i === 2 ? 'running' : undefined },
}))
const edges = N.slice(1).map((_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` }))

export function GraphCanvasSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  const [pan, setPan] = useState(false)
  return (
    <Group title={t('流程图画布')}>
      <Specimen name="GraphCanvas · CanvasToolbar · CanvasMiniMap" tune={['canvas', 'countBadge']}>
        <GraphCanvas
          frameClassName="h-72 w-full overflow-hidden rounded-xl bg-bg"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          panMode={pan}
        >
          <CanvasToolbar>
            <IconButton
              icon={Hand}
              size="sm"
              label={t('平移')}
              className={cn(pan && 'bg-sel text-fg')}
              aria-pressed={pan}
              onClick={() => setPan(!pan)}
            />
            <CanvasToolbarSep />
            <IconButton icon={Plus} size="sm" label={t('添加节点')} />
            <IconButton icon={LayoutGrid} size="sm" label={t('自动排列')} />
          </CanvasToolbar>
        </GraphCanvas>
      </Specimen>
      <Specimen name="CountBadge" tune={['countBadge']}>
        {[0, 1, 42, 999, 1000].map((n) => (
          <span key={n} className="relative inline-flex h-9 items-center rounded-lg bg-card px-3 text-body shadow-card">
            {n}
            <CountBadge corner count={n} />
          </span>
        ))}
      </Specimen>
    </Group>
  )
}
