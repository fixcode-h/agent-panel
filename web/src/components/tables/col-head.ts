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

const KEY = 'table-head-collapsed'

/** 表头行折没折起来：整个表格页一个开关，记在本机 */
export function useHeadCollapsed() {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const set = (x: boolean) => {
    setV(x)
    try {
      localStorage.setItem(KEY, x ? '1' : '0')
    } catch {
      // 存不了就只在这次打开里有效
    }
  }
  return [v, set] as const
}
