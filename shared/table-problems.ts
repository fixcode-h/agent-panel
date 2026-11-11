/**
 * 检查结果按「字段 + 种类」分组，和每组能用的批量修法（表格页底部的检查结果用）。
 * 纯函数：一万处问题分组也只是走一遍数组
 */
import { t } from './i18n.ts'
import type { ColInfo, Problem, ProblemRule } from './table-struct.ts'

export interface ProblemGroup {
  /** 列号 + 种类（没种类的老结果按原因） */
  key: string
  c: number
  field: string
  rule?: ProblemRule
  /** 组名里的原因：同一种的原因只差在值上时取通用说法 */
  label: string
  items: Problem[]
}

/** 原因里带了具体值的几种：分组时用通用说法 */
function ruleLabel(rule: ProblemRule | undefined, msg: string, info: ColInfo | undefined) {
  if (rule === 'enum') return t('不是 {e} 里的值', { e: info?.enumName ?? '' })
  if (rule === 'ref') return t('引用的表里没有')
  if (rule === 'key') return t('主键重复')
  if (rule === 'unique') return t('组合重复')
  if (rule === 'requiredWhen') return t('条件必填')
  if (rule === 'header') return t('表头取值不对')
  return msg
}

/** 按「列 + 种类」分组，组按出现的先后排（大致就是从左到右、从上到下） */
export function groupProblems(problems: Problem[], infos: ColInfo[]): ProblemGroup[] {
  const map = new Map<string, ProblemGroup>()
  for (const p of problems) {
    // 种类相同但原因里的边界值不同（范围改过）也算一组：只按种类分；没种类的按原因
    const key = `${p.c}\u0000${p.rule ?? p.msg}`
    let g = map.get(key)
    if (!g) {
      const info = infos[p.c]
      g = { key, c: p.c, field: info?.field ?? '', rule: p.rule, label: ruleLabel(p.rule, p.msg, info), items: [] }
      map.set(key, g)
    }
    g.items.push(p)
  }
  return [...map.values()]
}

/** 一种批量修法：把这一组的格子都改成 value */
export interface GroupFix {
  label: string
  value: string
}

/** 这一组能怎么批量修：超出范围改成边界值、改成允许的特殊值、不是必填的可以清空 */
export function groupFixes(g: ProblemGroup, info: ColInfo | undefined): GroupFix[] {
  if (!info) return []
  const out: GroupFix[] = []
  if (g.rule === 'max' && info.max !== undefined)
    out.push({ label: t('全部改成 {v}', { v: info.max }), value: String(info.max) })
  if (g.rule === 'min' && info.min !== undefined)
    out.push({ label: t('全部改成 {v}', { v: info.min }), value: String(info.min) })
  if (g.rule === 'min' || g.rule === 'max' || g.rule === 'type' || g.rule === 'enum' || g.rule === 'ref')
    for (const v of (info.allow ?? []).slice(0, 3)) out.push({ label: t('全部改成允许的值 {v}', { v }), value: v })
  const emptyOk =
    !info.required && g.rule !== 'required' && g.rule !== 'requiredWhen' && g.rule !== 'key' && g.rule !== 'header'
  if (emptyOk && !info.list) out.push({ label: t('全部清空'), value: '' })
  return out
}
