/**
 * 表格的表头识别：游戏配置表开头几行不是数据，而是「修饰（optional / repeated）、导出端（Client / Editor）、
 * 类型、字段名、中文注释」这样的描述行，之后才是数据。这里只看内容猜出表头从哪行开始、每行是什么，
 * 给表格按行分色、把表头钉在顶上用；猜不准时用户手动改（只记在表格外，表格文件不动）。
 * 纯函数，不依赖界面，前后端都能用。
 */

/** 表头行的角色：决定底色，以后也决定按什么规则编辑这一列 */
export const SHEET_ROLES = ['modifier', 'side', 'type', 'name', 'comment', 'other'] as const
export type SheetRole = (typeof SHEET_ROLES)[number]

/** 表头：从第 start 行（从 0 数）开始，roles 有几项就是几行；roles 为空表示没有表头 */
export interface SheetHeader {
  start: number
  roles: SheetRole[]
  /** 每行自己的名字（「导出标记」「默认值」……），不写就用角色名；只影响显示 */
  labels?: string[]
}

export interface DetectedHeader extends SheetHeader {
  /** 有把握：认出了两种以上的表头行，或者认出了一行字段名 */
  sure: boolean
}

/** 只在前面这么多行里找表头：配置表的表头不会更长 */
const SCAN = 12
/** 一行里至少这个比例的格子符合，才算这种行 */
const RATIO = 0.8

const MODIFIERS = new Set(['optional', 'repeated', 'required', 'packed', 'map', 'key', 'list', 'array'])
const SIDES = new Set(['client', 'server', 'editor', 'all', 'both', 'none', 'c', 's', 'e', 'cs', 'sc', 'ce', 'se'])
const PRIMITIVES =
  /^(u?int(8|16|32|64)?|s?int(32|64)|s?fixed(32|64)|float|double|bool(ean)?|string|bytes?|short|long|char|number|text|json|vector[234]|date(time)?|time)(\[\])?$/i
const GENERIC = /^(list|array|map|vector|set|dict)\s*[<(]/i
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const PASCAL = /^[A-Z][A-Za-z0-9_]*(\[\])?$/
const CJK = /[㐀-鿿豈-﫿]/

const lower = (s: string) => s.trim().toLowerCase()
/** 导出端可以写成 Client|Server、C/S 这种组合 */
const isSide = (s: string) =>
  lower(s)
    .split(/[|,/+\s]+/)
    .every((p) => p && SIDES.has(p))
const isPrimitive = (s: string) => PRIMITIVES.test(s.trim()) || GENERIC.test(s.trim())
const isType = (s: string) => isPrimitive(s) || PASCAL.test(s.trim())

function cellsOf(row: string[] | undefined) {
  const out: string[] = []
  for (const c of row ?? []) if (c && c.trim()) out.push(c.trim())
  return out
}

const share = (cells: string[], ok: (s: string) => boolean) => {
  let n = 0
  for (const c of cells) if (ok(c)) n++
  return n / cells.length
}

/** 一行像哪种表头行；像数据就返回 undefined */
export function rowRole(row: string[] | undefined): SheetRole | undefined {
  const cells = cellsOf(row)
  if (!cells.length) return undefined
  if (share(cells, (c) => MODIFIERS.has(lower(c))) >= RATIO) return 'modifier'
  // 只有一两格时单个字母（c、s）太容易撞上数据，要求格子多一点
  if (cells.length >= 2 && share(cells, isSide) >= RATIO) return 'side'
  // 类型行和字段名行都是标识符，区别是类型行里有 int / string 这种基础类型
  if (share(cells, isType) >= RATIO && share(cells, isPrimitive) >= 0.25) return 'type'
  if (share(cells, (c) => IDENT.test(c)) >= RATIO && new Set(cells).size >= cells.length * 0.9) return 'name'
  if (share(cells, (c) => CJK.test(c)) >= 0.5 && share(cells, (c) => !Number.isNaN(Number(c))) < 0.2) return 'comment'
  return undefined
}

/** 第一行只有一格字、下面一行是表头：当标题行跳过 */
function titleRows(rows: string[][]) {
  let n = 0
  while (n < 2 && n + 1 < rows.length && cellsOf(rows[n]).length === 1 && rowRole(rows[n + 1])) n++
  return n
}

/**
 * 猜表头：从开头（跳过标题行）往下，每行认一个角色，同一种角色出现第二次或认不出来就到了数据。
 * 两行连着都像字段名时，前一行其实是全用自定义类型名的类型行。
 */
export function detectSheetHeader(rows: string[][]): DetectedHeader {
  const start = titleRows(rows)
  const roles: SheetRole[] = []
  const end = Math.min(rows.length, start + SCAN)
  for (let r = start; r < end; r++) {
    const role = rowRole(rows[r])
    if (!role) break
    if (roles.includes(role)) {
      const last = roles.length - 1
      // 前一行要全是类型名的写法（大驼峰）才改认：小写的 key,value 后面跟着全是标识符的数据，不能把表头认成两行
      const prev = cellsOf(rows[r - 1])
      if (role === 'name' && roles[last] === 'name' && !roles.includes('type') && share(prev, isType) >= RATIO) {
        roles[last] = 'type'
        roles.push('name')
        continue
      }
      break
    }
    roles.push(role)
  }
  // 整张表都像表头（比如只有表头没数据，或者全是文字的枚举表）：只认第一行，别把数据也钉住
  if (roles.length && start + roles.length >= rows.length && rows.length > 2) roles.splice(1)
  // 只有一行中文：那就是列标题
  if (roles.length === 1 && roles[0] === 'comment') roles[0] = 'name'
  const sure = roles.length >= 2 || roles[0] === 'name'
  return { start: roles.length ? start : 0, roles, sure }
}

/** 表头里当列标题的那一行（字段名行；没有就是注释行），没有返回 -1 */
export function titleRowOf(h: SheetHeader) {
  const i = h.roles.indexOf('name')
  const at = i >= 0 ? i : h.roles.indexOf('comment')
  return at >= 0 ? h.start + at : -1
}

/** 表头结束后的第一行（数据从这行开始） */
export const dataStart = (h: SheetHeader) => (h.roles.length ? h.start + h.roles.length : 0)

/** 手动设置的表头是否合理：起点、行数不越界，角色都认识 */
export function validHeader(h: unknown, rowCount: number): h is SheetHeader {
  if (!h || typeof h !== 'object') return false
  const { start, roles } = h as SheetHeader
  return (
    Number.isInteger(start) &&
    start >= 0 &&
    start < Math.max(1, rowCount) &&
    Array.isArray(roles) &&
    roles.length <= 20 &&
    roles.every((r) => (SHEET_ROLES as readonly string[]).includes(r))
  )
}
