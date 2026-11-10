import type { LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { NavRow } from '@/components/ui/sidebar'
import { pluginIcon } from './icon'
import { usePlugins } from './registry'

/**
 * 设置 →「插件参数」的左栏入口和二级列表：开着的插件各占一页，和「Agent」那一项一样点进去是二级列表。
 * 设置页一打开就要画左栏，这部分单独成文件、不带表单，参数页本身（PluginParams.tsx）按需加载。
 */

/** 左栏那一项的 id；每个插件的页是 `pparam:<插件 id>` */
export const PLUGIN_PARAMS = 'plugin-params'
const PREFIX = 'pparam:'
export const pluginParamsId = (pluginId: string) => PREFIX + pluginId
export const pluginParamsPage = (id: string) => id === PLUGIN_PARAMS || id.startsWith(PREFIX)
/** 只是二级列表里的页（左栏不单独列出） */
export const pluginParamsSub = (id: string) => id.startsWith(PREFIX)

/** 开着的插件：设置页把它们当二级页加进分页列表（名字当标题、清单图标当图标） */
export function usePluginParamPages() {
  const { rows } = usePlugins()
  return rows
    .filter((r) => r.enabled)
    .map((r) => ({ id: pluginParamsId(r.manifest.id), label: r.manifest.name, icon: pluginIcon(r.manifest.icon) }))
}

/** 点左栏「插件参数」直接进第一个开着的插件；一个都没开就停在总页（空状态） */
export const pluginParamsEntry = (pages: { id: string }[]) => pages[0]?.id ?? PLUGIN_PARAMS

/** 二级列表：开着的插件，选中的高亮；总页时第一个算选中 */
export function PluginParamsNav({
  pages,
  current,
  onSection,
}: {
  pages: { id: string; label: string; icon: LucideIcon }[]
  current: string
  onSection: (id: string) => void
}) {
  const { rows, webErrors } = usePlugins()
  const sel = current === PLUGIN_PARAMS ? pages[0]?.id : current
  return (
    <nav
      aria-label={t('插件参数')}
      className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3 md:pt-6"
    >
      <span className="hidden px-2.5 pb-1.5 text-caption font-medium tracking-wide text-subtle md:flex">
        {t('已开启的插件')}
      </span>
      {pages.map((p) => {
        const on = p.id === sel
        const row = rows.find((r) => pluginParamsId(r.manifest.id) === p.id)
        const broken = !!row && !!(row.error || webErrors.get(row.manifest.id))
        return (
          <NavRow
            key={p.id}
            onClick={() => onSection(p.id)}
            on={on}
            className="w-auto shrink-0 whitespace-nowrap md:w-full"
            icon={<p.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={2.2} />}
            label={p.label}
            trailing={
              <span
                title={broken ? t('加载出错') : undefined}
                className={cn('hidden h-1.5 w-1.5 shrink-0 rounded-full md:block', broken ? 'bg-danger' : 'bg-success')}
              />
            }
          />
        )
      })}
      {!pages.length && <span className="px-2.5 py-1.5 text-body text-subtle">{t('还没有开启的插件')}</span>}
    </nav>
  )
}
