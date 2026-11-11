import { useRef } from 'react'
import { SheetHeaderBar } from '@/components/files/SheetHeaderBar'
import { SheetTable } from '@/components/files/SheetTable'
import { useSheetView } from '@/components/files/use-sheet-view'

/** 样例：一张游戏配置表（修饰 / 导出端 / 类型 / 字段名 / 注释 + 数据），演示数据不翻译 */
const ROWS = [
  ['optional', 'optional', 'optional', 'optional', 'repeated', 'optional'],
  ['Client', 'Client', 'Client', 'Editor', 'Client', 'Client'],
  ['uint32', 'uint32', 'HomeDecorationMountType', 'bytes', 'uint32', 'int32'],
  ['ID', 'EntryID', 'MountType', 'DisplayName', 'AllowCharacterIDs', 'TriggerState'],
  ['全局唯一软装配置ID', '交互物Entry ID', '家装挂载类型', '软装显示名', '交互白名单角色ID列表', '触发交互状态'],
  ['1', '781713001', 'FloorMirror', '曲线穿衣镜', '', '-1'],
  ['2', '781713002', 'FloorMirror', '高脚穿衣镜', '', '-1'],
  ['3', '781713003', 'TabletopDecor', '桌上圆镜', '1001;1003', '-1'],
  ['4', '781713004', 'WallMirror', '镀金画框挂镜', '', '-1'],
  ['5', '781713005', 'WallMirror', '简约横版挂镜', '1002', '0'],
  ['6', '781713006', 'FloorMirror', '落地拱形镜', '', '-1'],
  ['7', '781713007', 'TabletopDecor', '化妆台小镜', '', '-1'],
  ['8', '781713008', 'WallMirror', '复古椭圆挂镜', '', '2'],
]

/**
 * 设置 → 组件里的数据表格样例：和文件弹窗里看 xlsx / CSV 是同一个表格和表头栏，
 * 表头自动识别、分色、钉在顶上、列筛选都能直接试；颜色、行高、字体在下面的微调里改
 */
export function SheetSpecimen() {
  const box = useRef<HTMLDivElement>(null)
  const view = useSheetView('settings-sample', ROWS)
  if (!view) return null
  return (
    <div data-surface="" className="flex w-full flex-col overflow-hidden rounded-lg border bg-(--c-modal-bg)">
      <SheetHeaderBar view={view} rows={ROWS} />
      <div ref={box} className="h-64 overflow-auto">
        <SheetTable
          rows={ROWS}
          scrollEl={box}
          header={view.header}
          order={view.order}
          filters={view.filters}
          sort={view.sort}
          onFilter={view.setFilter}
          onSort={view.setSort}
        />
      </div>
    </div>
  )
}
