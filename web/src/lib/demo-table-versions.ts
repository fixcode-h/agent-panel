/**
 * 在线演示的表格「别的版本」：版本记录里的旧提交、另一个工作区（客户端主工程 = Release 分支）里的同一批表。
 * 都从示例表按固定规则改出来，演示数据不翻译
 */
import type { SheetData } from '@shared/files'

const CONFIG = 'data/C_HomeDecorationConfig.xlsx'
/** 配置表数据从第 6 行（下标 5）开始；DisplayName 是第 5 列，白名单第 6 列，挂载类型第 4 列 */
const FROM = 5

const edit = (sheets: SheetData[], f: (rows: string[][]) => string[][]) =>
  sheets.map((s, i) => (i === 0 ? { ...s, rows: f(s.rows.map((r) => [...r])) } : s))

/** 演示的版本记录：最新的在前 */
export const DEMO_REVS = [
  {
    id: 'c3',
    label: '5e1c09a2',
    author: 'lin.wei',
    time: '2026-11-10T10:40:00.000Z',
    message: '镜子类软装补交互白名单',
  },
  { id: 'c2', label: '9b7d3f10', author: 'zhao.k', time: '2026-11-08T03:02:00.000Z', message: '调整挂载类型和显示名' },
  { id: 'c1', label: '41aa0c6e', author: 'qa.bot', time: '2026-11-03T08:25:00.000Z', message: '新增家装配置表' },
]

/** 某个提交时这个文件的样子：c3 就是示例数据（HEAD），越早的改得越多 */
export function demoAt(path: string, rev: string, head: SheetData[]): SheetData[] {
  if (path !== CONFIG || rev === 'c3' || rev === 'HEAD') return head
  // c2：还没补白名单
  const c2 = edit(head, (rows) =>
    rows.map((r, i) => {
      if (i >= FROM) r[5] = ''
      return r
    }),
  )
  if (rev === 'c2') return c2
  // c1：最后 10 行还没加，几行的挂载类型、显示名是旧的
  return edit(c2, (rows) =>
    rows.slice(0, rows.length - 10).map((r, i) => {
      if (i >= FROM && i % 9 === 2) r[3] = 'FloorMirror'
      if (i >= FROM && i % 13 === 6) r[4] = `${r[4]}（旧）`
      return r
    }),
  )
}

/** 另一个工作区（Release）里的样子：少几行、改了几格、白名单列没有 */
export function demoRelease(path: string, sheets: SheetData[]): SheetData[] {
  if (path !== CONFIG) return sheets
  return edit(sheets, (rows) =>
    rows.slice(0, rows.length - 3).map((r, i) => {
      if (i >= FROM && i % 17 === 4) r[4] = `${r[4]}（发布版）`
      if (i >= FROM && i % 23 === 8) r[2] = 'M'
      return r
    }),
  )
}
