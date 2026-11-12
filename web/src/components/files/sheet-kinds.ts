import { useLayoutEffect, useState } from 'react'
import type { SheetHeader } from '@shared/sheet-header'

/**
 * 数据表格里一列的显示方式：数字右对齐、布尔画成小勾、枚举画成胶囊。
 * 表格页按列结构给（结构文件里的类型），文件弹窗、设置样例没有结构，按表头的类型行或数据猜（inferColKinds）
 */
export interface SheetColKind {
  kind: 'num' | 'bool' | 'enum'
  /** 数组列的分隔符：枚举数组每一项画一个胶囊 */
  sep?: string
}

/** 设置 → 组件 → 数据表格里几项显示开关（--c-grid-*，开 '1' 关 '0'）和行高 */
export interface GridLook {
  rowH: number
  pills: boolean
  bools: boolean
  blank: boolean
}

const LOOK0: GridLook = { rowH: 26, pills: true, bools: true, blank: true }

/**
 * 读设置 → 组件 → 数据表格的几项：行高要参与虚拟滚动的位置计算，开关决定格子里画什么，都不能只交给 CSS。
 * 每次渲染后看一眼（一次 getComputedStyle 读全部），设置里拖了滑块、拨了开关，下一次渲染就跟上
 */
export function useGridLook(): GridLook {
  const [look, setLook] = useState(LOOK0)
  // 故意不写依赖：设置改的是 CSS 变量，React 不知道它变了，每次渲染后都看一眼；值没变不 setState，不会循环
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const s = getComputedStyle(document.documentElement)
    const flag = (name: string) => s.getPropertyValue(name).trim() !== '0'
    const h = parseFloat(s.getPropertyValue('--c-grid-rowH'))
    const next: GridLook = {
      rowH: h > 0 ? h : look.rowH,
      pills: flag('--c-grid-pills'),
      bools: flag('--c-grid-bools'),
      blank: flag('--c-grid-blank'),
    }
    if (next.rowH !== look.rowH || next.pills !== look.pills || next.bools !== look.bools || next.blank !== look.blank)
      setLook(next)
  })
  return look
}

/** 布尔值：是 / 否；不是这几种写法的（写错了）返回 undefined，照原样显示，免得把错值藏起来 */
export function boolOf(v: string): boolean | undefined {
  const s = v.trim().toLowerCase()
  if (s === '1' || s === 'true') return true
  if (s === '0' || s === 'false') return false
  return undefined
}

/**
 * 枚举胶囊的色相：按值算一个固定的角度，同一个值在哪张表、哪次打开都是同一种颜色。
 * 取 24 档（每档 15°），相邻的值不会只差一点点颜色
 */
export function pillHue(v: string): number {
  let h = 2166136261
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 24) * 15
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/
const INT_T = /^(s?int(8|16|32|64)?|u?int(8|16|32|64)|sfixed(32|64)|fixed(32|64)|long|ulong|short|ushort|byte)$/i
const FLOAT_T = /^(float|double|number|real|decimal)$/i
const BOOL_T = /^(bool|boolean)$/i
/** 猜列的显示方式只看前面这么多行数据：几万行的表不为这个全扫 */
const SAMPLE = 200

/**
 * 没有列结构时猜每列的显示方式（文件弹窗、设置样例）：
 * 有类型行就按类型行（int / float / bool）；没有类型行时，前面一段数据里非空的格子全是数字的列算数字列。
 * 只猜数字和布尔：枚举要有结构文件里的取值表才算，猜错了反而误导
 */
export function inferColKinds(
  rows: string[][],
  header: SheetHeader,
  from: number,
  cols: number,
): (SheetColKind | undefined)[] {
  const out: (SheetColKind | undefined)[] = Array.from({ length: cols })
  const ti = header.roles.indexOf('type')
  if (ti >= 0) {
    const types = rows[header.start + ti] ?? []
    for (let c = 0; c < cols; c++) {
      const tp = (types[c] ?? '').trim()
      if (INT_T.test(tp) || FLOAT_T.test(tp)) out[c] = { kind: 'num' }
      else if (BOOL_T.test(tp)) out[c] = { kind: 'bool' }
    }
    return out
  }
  const end = Math.min(rows.length, from + SAMPLE)
  for (let c = 0; c < cols; c++) {
    let seen = 0
    let num = true
    for (let r = from; r < end && num; r++) {
      const v = (rows[r]?.[c] ?? '').trim()
      if (!v) continue
      seen++
      num = NUM.test(v)
    }
    if (num && seen > 0) out[c] = { kind: 'num' }
  }
  return out
}

/** 每列左右相邻的「没隐藏」的列（宽度为 0 的是隐藏列，-1 是没有）：选区外框看左右邻居在不在选区里 */
export function neighborCols(colW: number[]): [number[], number[]] {
  const prev: number[] = []
  const next: number[] = Array.from({ length: colW.length }, () => -1)
  let last = -1
  colW.forEach((w, c) => {
    prev.push(last)
    if (w > 0) {
      if (last >= 0) next[last] = c
      last = c
    }
  })
  return [prev, next]
}
