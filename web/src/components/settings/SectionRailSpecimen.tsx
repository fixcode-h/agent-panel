import { useState, type ComponentType, type ReactNode } from 'react'
import {
  ArrowLeft,
  Blocks,
  Box,
  Braces,
  Bug,
  Camera,
  CircleAlert,
  Database,
  Eye,
  FileCode2,
  FlaskConical,
  Gauge,
  LayoutGrid,
  List,
  SlidersHorizontal,
  SquareTerminal,
  Undo2,
  Wand2,
} from 'lucide-react'
import type { CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import {
  RailAction,
  SectionRail,
  SidePanel,
  SidePanelLabel,
  SidePanelRow,
  StatusChip,
  type SectionRailItem,
} from '@/components/ui/section-rail'
import { Group } from '@/components/settings/parts'

/**
 * 设置 → 组件里「分区导航」的样例：UE 页那样的图标轨 + 二级面板 + 目标卡上的状态小块。
 * 调宽度、圆角、角标写不写数字、底色时这里跟着变。示例数据不翻译
 */
const ITEMS: SectionRailItem[] = [
  { id: 'overview', label: '概览', icon: LayoutGrid, group: 'run' },
  { id: 'console', label: '控制台', icon: SquareTerminal, group: 'run' },
  { id: 'gm', label: 'GM', icon: Wand2, group: 'run' },
  { id: 'lua', label: 'Lua', icon: Braces, group: 'run' },
  { id: 'objects', label: '对象', icon: Box, group: 'data' },
  { id: 'assets', label: '资源', icon: Database, group: 'data', badge: { tone: 'warn', text: '1 未存' } },
  { id: 'forge', label: 'AssetForge', icon: FileCode2, group: 'ext' },
  { id: 'gametest', label: 'GameTest', icon: FlaskConical, group: 'ext' },
  { id: 'watch', label: '监视', icon: Eye, group: 'see' },
  { id: 'perf', label: '性能', icon: Gauge, group: 'see' },
  { id: 'logs', label: '运行日志', icon: List, group: 'see', badge: { count: 22, tone: 'danger', text: '22 错误' } },
  { id: 'history', label: '操作记录', icon: Undo2, group: 'see', badge: { tone: 'warn', text: '2 可撤' } },
  { id: 'plugins', label: 'UE 插件', icon: Blocks, end: true, badge: { tone: 'accent', text: '2 可升级' } },
  { id: 'bridge', label: '权限与设置', icon: SlidersHorizontal, end: true },
]

/** 目标卡上的示例世界名（示例数据，不翻译） */
const WORLD = '游戏世界 · Map_ForgeSample'

export function SectionRailSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  const [cur, setCur] = useState('logs')
  const [level, setLevel] = useState('Error')
  const label = ITEMS.find((x) => x.id === cur)?.label ?? ''
  return (
    <Group title={t('分区导航')}>
      <Specimen name="SectionRail · SidePanel · StatusChip" tune={['sectionRail', 'nav', 'chip']}>
        <div className="flex h-[38rem] w-[30rem] max-w-full overflow-hidden rounded-xl bg-bg shadow-card">
          <SectionRail
            items={ITEMS}
            current={cur}
            onPick={setCur}
            top={<RailAction icon={ArrowLeft} short={t('返回')} label={t('返回')} onClick={() => {}} />}
            bottom={<RailAction icon={Camera} short={t('截图')} label="截视口" onClick={() => {}} />}
          />
          <SidePanel title={label} className="w-56">
            <div className="flex flex-col gap-1.5 rounded-xl bg-card p-2 shadow-card">
              <div className="truncate text-body font-medium">{WORLD}</div>
              <div className="flex flex-wrap gap-1">
                <StatusChip tone="ok">PIE 18616</StatusChip>
                <StatusChip tone="ok" icon={Bug}>
                  VS 调试
                </StatusChip>
                <StatusChip onClick={() => {}} title="启动后台编辑器">
                  后台
                </StatusChip>
              </div>
            </div>
            <SidePanelLabel>{t('级别')}</SidePanelLabel>
            <SidePanelRow icon={List} label="全部" meta="1,284" on={level === ''} onClick={() => setLevel('')} />
            <SidePanelRow
              icon={CircleAlert}
              label="错误"
              meta="22"
              tone="danger"
              on={level === 'Error'}
              onClick={() => setLevel('Error')}
            />
            <SidePanelRow
              icon={CircleAlert}
              label="警告"
              meta="140"
              tone="warn"
              on={level === 'Warning'}
              onClick={() => setLevel('Warning')}
            />
          </SidePanel>
          <div className="flex-1" />
        </div>
      </Specimen>
    </Group>
  )
}
