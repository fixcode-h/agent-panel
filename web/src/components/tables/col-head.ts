import { useState } from 'react'
import { t } from '@shared/i18n'
import type { ColInfo } from '@shared/table-struct'
import type { SheetColHead, SheetColTag } from '@/components/files/SheetTable'

/**
 * 表格页两行列头的内容：字段名 + 类型标签（类型、枚举、引用、数组、必填）。
 * 类型本身就是枚举名时只出一个枚举标签，不重复写两遍
 */
export function colHeadOf(info: ColInfo): SheetColHead | undefined {
  if (!info.field) return undefined
  const tags: SheetColTag[] = []
  if (info.enumName)
    tags.push({
      text: info.enumName,
      tone: 'enum',
      title: t('枚举 {e}', { e: info.enumName }),
    })
  if (info.type && info.type !== info.enumName && !(info.list && /\[\]$/.test(info.type) && info.enumName))
    tags.push({ text: info.type, tone: 'type' })
  if (info.ref) {
    const file = info.ref.split('#')[0] ?? ''
    tags.push({
      text: `→ ${file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')}`,
      tone: 'ref',
      title: t('引用 {ref}', { ref: info.ref }),
    })
  }
  if (info.list) tags.push({ text: '[ ]', tone: 'list', title: t('数组，分隔符 {sep}', { sep: info.sep }) })
  if (info.required) tags.push({ text: '*', tone: 'req', title: t('必填') })
  return { field: info.field, tags }
}

/** 一列的规则写成一句（编辑栏右边显示）：「枚举 Size · 0~4 · 必填」 */
export function ruleText(info: ColInfo | undefined) {
  if (!info?.field) return ''
  const parts: string[] = []
  if (info.enumName) parts.push(t('枚举 {e}', { e: info.enumName }))
  else if (info.ref) parts.push(t('引用 {ref}', { ref: info.ref.replace(/^.*\//, '') }))
  else if (info.type) parts.push(info.type)
  if (info.list) parts.push(t('数组（{sep} 分隔）', { sep: info.sep }))
  if (info.min !== undefined || info.max !== undefined) parts.push(`${info.min ?? ''}~${info.max ?? ''}`)
  if (info.allow?.length) parts.push(t('也允许 {v}', { v: info.allow.join(' / ') }))
  if (info.pattern) parts.push(t('格式 {p}', { p: info.pattern }))
  if (info.required) parts.push(t('必填'))
  else if (info.requiredWhen)
    parts.push(t('{field} 是 {v} 时必填', { field: info.requiredWhen.field, v: info.requiredWhen.values.join(' / ') }))
  return parts.join(' · ')
}

/** 表格页的一个开关（表头折起、编辑栏、ID → 名称……）：整个表格页共用，记在本机 */
export function useLocalFlag(key: string, init = false) {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? init : s === '1'
    } catch {
      return init
    }
  })
  const set = (x: boolean) => {
    setV(x)
    try {
      localStorage.setItem(key, x ? '1' : '0')
    } catch {
      // 存不了就只在这次打开里有效
    }
  }
  return [v, set] as const
}

/** 表头行折没折起来 */
export const useHeadCollapsed = () => useLocalFlag('table-head-collapsed')

/** 表格页行高的三档：标准跟着设置 → 组件 → 数据表格的行高 */
export type Density = 'compact' | 'normal' | 'loose'
export const DENSITY_ROW_H: Record<Density, number | undefined> = { compact: 22, normal: undefined, loose: 32 }

/** 表格页的行高档：整个表格页一个，记在本机 */
export function useDensity() {
  const [v, setV] = useState<Density>(() => {
    try {
      const s = localStorage.getItem('table-density')
      return s === 'compact' || s === 'loose' ? s : 'normal'
    } catch {
      return 'normal'
    }
  })
  const set = (x: Density) => {
    setV(x)
    try {
      localStorage.setItem('table-density', x)
    } catch {
      // 存不了就只在这次打开里有效
    }
  }
  return [v, set] as const
}
