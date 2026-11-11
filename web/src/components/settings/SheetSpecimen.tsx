import { useRef } from 'react'
import { SheetHeaderBar } from '@/components/files/SheetHeaderBar'
import { SheetTable, type SheetColHead, type SheetEditing } from '@/components/files/SheetTable'
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
 * 表格页里的样子（只看，不能真改）：一格改过没保存、一格不合规、当前格描边，
 * 枚举列悬停出下拉箭头、引用列虚下划线、必填空着的斜线底纹
 */
const SAMPLE_EDIT: SheetEditing = {
  picked: () => false,
  focus: { row: 8, col: 2 },
  focusSeq: 0,
  editing: null,
  mark: (r, c) =>
    [
      r === 6 && c === 3 && 'sheet-dirty',
      r === 12 && c === 5 && 'sheet-bad',
      r >= 5 && c === 2 && 'sheet-enum',
      r >= 5 && c === 4 && ROWS[r][4] && 'sheet-ref',
      r === 9 && c === 4 && 'sheet-need',
    ]
      .filter(Boolean)
      .join(' ') || undefined,
  tip: (r, c) => (r === 12 && c === 5 ? 'TriggerState 只能是 -1 到 1' : undefined),
  onDown: () => {},
  onEnter: () => {},
  onDouble: () => {},
}

/** 表格页的两行列头：字段名 + 类型标签（颜色跟着表头每种行的颜色） */
const HEADS: (SheetColHead | undefined)[] = [
  {
    field: 'ID',
    tags: [
      { text: 'uint32', tone: 'type' },
      { text: '*', tone: 'req' },
    ],
  },
  { field: 'EntryID', tags: [{ text: 'uint32', tone: 'type' }] },
  { field: 'MountType', tags: [{ text: 'HomeDecorationMountType', tone: 'enum' }] },
  { field: 'DisplayName', tags: [{ text: 'bytes', tone: 'type' }] },
  {
    field: 'AllowCharacterIDs',
    tags: [
      { text: 'uint32', tone: 'type' },
      { text: '→ C_Character', tone: 'ref' },
      { text: '[ ]', tone: 'list' },
    ],
  },
  { field: 'TriggerState', tags: [{ text: 'int32', tone: 'type' }] },
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
          edit={SAMPLE_EDIT}
          colHead={(c) => HEADS[c]}
        />
      </div>
    </div>
  )
}
