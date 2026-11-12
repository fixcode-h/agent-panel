import { useRef } from 'react'
import type { SheetLook } from '@shared/files'
import { SheetHeaderBar } from '@/components/files/SheetHeaderBar'
import { SheetTable, type SheetColHead, type SheetColKind, type SheetEditing } from '@/components/files/SheetTable'
import { useSheetView } from '@/components/files/use-sheet-view'

/** 样例：一张游戏配置表（修饰 / 导出端 / 类型 / 字段名 / 注释 + 数据），演示数据不翻译 */
const ROWS = [
  ['optional', 'optional', 'optional', 'optional', 'repeated', 'optional', 'optional'],
  ['Client', 'Client', 'Client', 'Editor', 'Client', 'Client', 'Client'],
  ['uint32', 'uint32', 'HomeDecorationMountType', 'bytes', 'uint32', 'int32', 'bool'],
  ['ID', 'EntryID', 'MountType', 'DisplayName', 'AllowCharacterIDs', 'TriggerState', 'Visible'],
  [
    '全局唯一软装配置ID',
    '交互物Entry ID',
    '家装挂载类型',
    '软装显示名',
    '交互白名单角色ID列表',
    '触发交互状态',
    '是否显示',
  ],
  ['1', '781713001', 'FloorMirror', '曲线穿衣镜', '', '-1', '1'],
  ['2', '781713002', 'FloorMirror', '高脚穿衣镜', '', '-1', '1'],
  ['3', '781713003', 'TabletopDecor', '桌上圆镜', '1001;1003', '-1', '0'],
  ['4', '781713004', 'WallMirror', '镀金画框挂镜', '', '-1', '1'],
  ['5', '781713005', 'WallMirror', '简约横版挂镜', '1002', '0', '1'],
  ['6', '781713006', 'FloorMirror', '落地拱形镜', '', '-1', '0'],
  ['7', '781713007', 'TabletopDecor', '化妆台小镜', '', '-1', '1'],
  ['8', '781713008', 'WallMirror', '复古椭圆挂镜', '', '2', '1'],
]

/**
 * 表格页里的样子（只看，不能真改）：一格改过没保存、一格不合规、选中的一块和当前格描边、
 * 选区右下角的填充柄，枚举列悬停出下拉箭头、引用列虚下划线、必填空着的斜线底纹
 */
const SAMPLE_EDIT: SheetEditing = {
  // 选中一小块：外面一圈框，行号、列名跟着高亮，右下角是填充柄
  picked: (r, c) => r >= 7 && r <= 8 && c >= 2 && c <= 3,
  handle: { r: 8, c: 3, onDown: () => {} },
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
  tip: (r, c) =>
    r === 12 && c === 5
      ? {
          title: '不合规',
          tone: 'danger',
          lines: [
            { label: '原因', text: 'TriggerState 只能是 -1 到 1' },
            { label: '规则', text: 'int32 · -1~1' },
          ],
        }
      : undefined,
  onDown: () => {},
  onEnter: () => {},
  onDouble: () => {},
}

/**
 * 从 xlsx 里还原的显示：批注角标、超链接、整行底色色条（演示数据不翻译）。
 * 合并单元格在第 1 行（修饰行）的后两格，表头展开时看得到
 */
const SAMPLE_LOOK: SheetLook = {
  merges: [{ r: 0, c: 4, rows: 1, cols: 2 }],
  notes: [{ r: 7, c: 3, text: '只在桌面上出现，地面摆不下', author: '策划' }],
  links: [{ r: 10, c: 3, url: 'https://example.com/wiki/mirror', tip: '原画参考' }],
  fills: [
    { r: 11, color: '#f5c542' },
    { r: 12, color: '#e5534b' },
  ],
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
  { field: 'Visible', tags: [{ text: 'bool', tone: 'type' }] },
]

/** 每列的显示方式：数字右对齐、枚举胶囊、布尔小勾（表格页按列结构给，这里写死） */
const KINDS: (SheetColKind | undefined)[] = [
  { kind: 'num' },
  { kind: 'num' },
  { kind: 'enum' },
  undefined,
  undefined,
  { kind: 'num' },
  { kind: 'bool' },
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
      {/* 带编辑样子的表格是一组行（rowgroup），外面要有 grid */}
      <div ref={box} role="grid" aria-readonly aria-rowcount={ROWS.length} className="h-64 overflow-auto">
        <SheetTable
          rows={ROWS}
          look={SAMPLE_LOOK}
          scrollEl={box}
          header={view.header}
          order={view.order}
          filters={view.filters}
          sort={view.sort}
          onFilter={view.setFilter}
          onSort={view.setSort}
          edit={SAMPLE_EDIT}
          colHead={(c) => HEADS[c]}
          colKind={(c) => KINDS[c]}
        />
      </div>
    </div>
  )
}
