/**
 * 设置页搜索的判定（纯函数，有单测）：哪些项算命中、命中的字怎么标出来、说明太长时从哪里截。
 * 索引由 scripts/lib/settings-index.mjs 在构建时从源码抽出，界面在 web/src/components/settings/SettingsSearch.tsx。
 */

/** 索引里的一项：都是中文原文（t() 的键），section 是左栏那一页的 id（`@cli` 表示各个 CLI 的页） */
export interface SettingsEntry {
  section: string
  title: string
  group?: string
  desc?: string
  /** 问号悬停里的详细说明：能搜到，结果里只在说明没命中时拿它当摘要 */
  hint?: string
  /** 小节标题本身（`<Group title>`），跳转时定位到小节 */
  isGroup?: boolean
}

/** 翻译成当前语言后的一项；zh 留着中文原文，英文界面下用中文也能搜到 */
export interface SettingsItem {
  section: string
  title: string
  group?: string
  desc?: string
  hint?: string
  isGroup?: boolean
  /** 左栏那一页本身（标题就是页名），点了只切页 */
  isSection?: boolean
  zh: string
}

/** 搜索词拆成小写的几段，空格隔开的每段都要命中 */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * 命中：每段词都出现在标题、小节名、说明或中文原文里。
 * 不拿左栏页名去比：搜「网络」时整页的项都算命中会把真正相关的淹掉，页名由 isSection 那一项单独命中。
 */
export function matchSetting(item: SettingsItem, terms: string[]): boolean {
  if (!terms.length) return false
  const hay = [item.title, item.group, item.desc, item.hint, item.zh].filter(Boolean).join('\n').toLowerCase()
  return terms.every((w) => hay.includes(w))
}

export function searchSettings(items: SettingsItem[], query: string): SettingsItem[] {
  const terms = searchTerms(query)
  return items.filter((it) => matchSetting(it, terms))
}

/** 文案里的 {变量}：知道的换成值，不知道的换成省略号（索引里没有运行时的值） */
export function fillVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '…')
}

/** 把文字按命中的词切成几段，hit 的段要标出来；多个词重叠的区间合并 */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const low = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const w of terms) {
    if (!w) continue
    for (let at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + w.length)) ranges.push([at, at + w.length])
  }
  if (!ranges.length) return text ? [{ text, hit: false }] : []
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  const out: { text: string; hit: boolean }[] = []
  let i = 0
  for (const [a, b] of merged) {
    if (a > i) out.push({ text: text.slice(i, a), hit: false })
    out.push({ text: text.slice(a, b), hit: true })
    i = b
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

/** 结果里显示的那行说明：说明里命中了就用说明，否则命中落在悬停详情里时显示详情，都没命中时用说明 */
export function hitText(item: { desc?: string; hint?: string }, terms: string[]): string | undefined {
  const has = (s?: string) => !!s && terms.some((w) => s.toLowerCase().includes(w))
  if (has(item.desc) || !has(item.hint)) return item.desc
  return item.hint
}

/**
 * 说明太长时，命中的词可能落在两行之外被截掉：第一个命中点离开头超过 lead 个字，就从它前面 lead 个字处开始，
 * 前面加省略号。没命中（只是标题命中）就从头显示。
 */
export function snippet(text: string, terms: string[], lead = 24): string {
  const low = text.toLowerCase()
  const at = Math.min(...terms.map((w) => low.indexOf(w)).filter((i) => i >= 0))
  if (!Number.isFinite(at) || at <= lead) return text
  return `…${text.slice(at - lead)}`
}
