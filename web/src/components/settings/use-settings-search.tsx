import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { SquareTerminal } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'
import { cliColor } from '@/lib/cli-style'
import * as pp from '@/plugins/PluginParamsNav'
import { revealSetting } from '@/components/settings/section-nav'
import type { SettingsHitGroup } from '@/components/settings/SettingsSearch'
import { fillVars, searchSettings, searchTerms, type SettingsItem } from '@/lib/settings-search'
import { cliPage, type Section } from '@/components/settings/settings-sections'
import settingsIndex from 'virtual:settings-index'

/**
 * 设置页的搜索：跨所有页搜设置项（索引在构建时从源码抽出，见 scripts/lib/settings-index.mjs）。
 * 从 pages/SettingsPage.tsx 挪出：搜索框在左栏、结果在内容区，两边都读这一份。
 */
export function useSettingsSearch({
  sections: SECTIONS,
  defCli,
  onSection,
}: {
  sections: Section[]
  defCli: string
  onSection: (s: string) => void
}) {
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const terms = searchTerms(query)
  const searching = terms.length > 0
  const sectionPath = (s: Section) =>
    cliPage(s) && s.id !== 'models'
      ? `Agent › ${s.label}`
      : pp.pluginParamsSub(s.id)
        ? `${t('插件参数')} › ${s.label}`
        : s.label
  const sectionIcon = (s: Section) =>
    s.cli ? (
      <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: cliColor(s.cli.id) }} />
    ) : s.id === 'models' ? (
      <SquareTerminal className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
    ) : (
      s.icon && <s.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
    )
  const defName = CLIS.find((c) => c.id === defCli)?.name ?? defCli
  // 索引存的是中文原文：翻成当前语言再搜；各个 CLI 共用的那页（@cli）落到默认 CLI 上
  const searchItems = useMemo(() => {
    const vars = { cli: defName }
    const pages = new Set(SECTIONS.map((s) => s.id))
    const tr = (zh?: string) => (zh ? fillVars(t(zh), vars) : undefined)
    const items: SettingsItem[] = SECTIONS.map((s) => ({
      section: s.id,
      title: s.id === 'models' ? 'Agent' : s.label,
      isSection: true,
      zh: s.id,
    }))
    for (const e of settingsIndex) {
      const section = e.section === '@cli' ? `cli:${defCli}` : e.section
      if (!pages.has(section)) continue
      items.push({
        section,
        title: tr(e.title)!,
        group: e.isGroup ? undefined : tr(e.group),
        desc: tr(e.desc),
        hint: tr(e.hint),
        isGroup: e.isGroup,
        zh: [e.title, e.group, e.desc, e.hint].filter(Boolean).join('\n'),
      })
    }
    return items
    // SECTIONS 每次渲染都重建，按它的 id 序列判断变化即可
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [SECTIONS.map((s) => s.id).join(), defCli, defName])
  // 结果按左栏的顺序分组；整页那一项排在组里最前面
  const hitGroups: SettingsHitGroup[] = searching
    ? SECTIONS.flatMap((s) => {
        const items = searchSettings(
          searchItems.filter((it) => it.section === s.id),
          query,
        )
        return items.length ? [{ section: s.id, label: sectionPath(s), icon: sectionIcon(s), items }] : []
      })
    : []
  const hits = hitGroups.flatMap((g) => g.items)
  const hitCount = (id: string) => hitGroups.find((g) => g.section === id)?.items.length ?? 0
  // 左栏每一项命中几条：Agent 那一项合计默认 Agent、部署、API 和各个 CLI 页
  const navHits = (s: Section) =>
    (s.id === 'models'
      ? SECTIONS.filter(cliPage)
      : s.id === pp.PLUGIN_PARAMS
        ? SECTIONS.filter((x) => pp.pluginParamsPage(x.id))
        : [s]
    ).reduce((n, x) => n + hitCount(x.id), 0)
  // 换了搜索词从第一项开始选
  useEffect(() => setHit(0), [query])
  const pick = (it: SettingsItem) => {
    setQuery('')
    onSection(it.section)
    if (it.isSection) return
    const css = (v: string) => CSS.escape(v)
    revealSetting(
      it.isGroup
        ? [`[data-setting-group="${css(it.title)}"] > h3`]
        : [
            ...(it.group ? [`[data-setting-group="${css(it.group)}"] [data-setting="${css(it.title)}"]`] : []),
            `[data-setting="${css(it.title)}"]`,
          ],
    )
  }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      setQuery('')
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setHit((i) => (i + d + hits.length) % hits.length)
    } else if (e.key === 'Enter' && hits[hit]) {
      e.preventDefault()
      pick(hits[hit])
    }
  }
  // Ctrl / ⌘ + F 聚焦搜索框（照 VS Code 的设置页），不弹浏览器自己的页内查找
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { query, setQuery, hit, setHit, searchRef, terms, searching, hitGroups, hits, navHits, pick, onSearchKey }
}

export type SettingsSearch = ReturnType<typeof useSettingsSearch>
