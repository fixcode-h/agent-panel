import { useId, useState } from 'react'
import { GripVertical, SquareTerminal } from 'lucide-react'
import { t } from '@shared/i18n'
import { cliColor } from '@/lib/cli-style'
import { useAppUpdate } from '@/lib/app-update'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { NavRow } from '@/components/ui/sidebar'
import * as pp from '@/plugins/PluginParamsNav'
import { SettingsSearchBox } from '@/components/settings/SettingsSearch'
import { cliPage, type Section } from '@/components/settings/settings-sections'
import type { SettingsSearch } from '@/components/settings/use-settings-search'
import type { CliDrafts } from '@/components/settings/use-cli-drafts'

/**
 * 设置弹窗的左栏：标题、搜索框和分类（从 pages/SettingsPage.tsx 挪出）。
 * CLI 相关的几页在这里合成一项「Agent」，插件参数同理；展开后的二级列表见 AgentSubNav、PluginParamsNav。
 */
export function SettingsMainNav({
  sections: SECTIONS,
  cur,
  inCli,
  inPlugin,
  search,
  pluginPages,
  deployDot,
  onSection,
}: {
  sections: Section[]
  cur: Section
  inCli: boolean
  inPlugin: boolean
  search: Pick<SettingsSearch, 'query' | 'setQuery' | 'onSearchKey' | 'searchRef' | 'searching' | 'navHits'>
  pluginPages: Section[]
  deployDot: string | undefined
  onSection: (s: string) => void
}) {
  const { query, setQuery, onSearchKey, searchRef, searching, navHits } = search
  const update = useAppUpdate().data?.update
  // 提示挂在 aria-describedby 上：放进按钮里会被算进可访问名称，按名字找这一项就找不到了
  const agentHintId = useId()
  return (
    <nav
      aria-label={t('设置分类')}
      className="flex min-h-0 shrink-0 border-b bg-rail md:w-[220px] md:flex-col md:border-r md:border-b-0"
    >
      {/* 标题和搜索框固定在左栏顶部，不跟着分类滚动：滚到下面的分类（例如 Agent）时还认得出这是设置、随时能搜。
          只让下面的分类列表滚动，滚动条从搜索框下面开始，不越过搜索框（用户要求） */}
      <div className="flex shrink-0 items-center p-2 pr-0 md:block md:px-2.5 md:pt-3 md:pb-0">
        <span className="hidden px-2.5 pt-1 pb-4 font-serif text-title font-semibold tracking-tight md:block">
          {t('设置')}
        </span>
        <SettingsSearchBox value={query} onChange={setQuery} onKeyDown={onSearchKey} inputRef={searchRef} />
      </div>
      <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto p-2 md:min-h-0 md:flex-col md:overflow-x-visible md:overflow-y-auto md:px-2.5 md:pt-0 md:pb-3">
        {SECTIONS.filter((s) => (!cliPage(s) || s.id === 'models') && !pp.pluginParamsSub(s.id)).map((s, i, list) => {
          // CLI 相关的几页（默认 CLI 和各个 CLI）在左栏里合成一项「CLI」
          // 搜索时内容区是结果列表，左栏不再标当前页
          const on = !searching && (s.id === 'models' ? inCli : s.id === pp.PLUGIN_PARAMS ? inPlugin : s.id === cur.id)
          const head = s.group && s.group !== list[i - 1]?.group
          return (
            <div key={s.id} className="contents">
              {head && (
                // 窄屏左栏是横向的一行，不显示组名
                <span
                  className={cn(
                    'hidden px-2.5 pb-1.5 text-caption font-medium tracking-wide text-subtle md:block',
                    i > 0 ? 'pt-4' : 'pt-0',
                  )}
                >
                  {s.group}
                </span>
              )}
              {/* 窄屏左栏是横向一行：行宽按文字走（w-auto），md 以上竖排才撑满 */}
              <NavRow
                onClick={() => {
                  setQuery('')
                  onSection(s.id === pp.PLUGIN_PARAMS ? pp.pluginParamsEntry(pluginPages) : s.id)
                }}
                on={on}
                aria-describedby={s.id === 'models' && deployDot ? agentHintId : undefined}
                className={cn('w-auto shrink-0 whitespace-nowrap md:w-full', searching && !navHits(s) && 'opacity-50')}
                icon={
                  s.id === 'models' ? (
                    <SquareTerminal className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={2.2} />
                  ) : (
                    s.icon && <s.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={2.2} />
                  )
                }
                label={s.id === 'models' ? 'Agent' : s.label}
                trailing={
                  <>
                    {/* 搜索时每页右边写命中几项，没命中的页淡下去 */}
                    {searching && navHits(s) > 0 && (
                      <span className="shrink-0 text-footnote text-subtle tabular-nums">{navHits(s)}</span>
                    )}
                    {s.id === 'update' && update && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有新版本')} />
                    )}
                    {/* 「部署」在 Agent 的二级列表里：自带技能要更新时先在这一项上亮点 */}
                    {s.id === 'models' && deployDot && (
                      <span
                        aria-hidden="true"
                        title={deployDot}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                  </>
                }
              />
              {s.id === 'models' && deployDot && (
                <span id={agentHintId} className="sr-only">
                  {deployDot}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

/** CLI 的二级列表：默认 CLI 和各个 CLI，CLI 可以拖动调整顺序（新建 Agent、下拉框里也按这个顺序） */
export function AgentSubNav({
  sections: SECTIONS,
  cur,
  cli,
  deployDot,
  onSection,
}: {
  sections: Section[]
  cur: Section
  cli: Pick<CliDrafts, 'statusOf' | 'ordered' | 'isReady' | 'moveCli' | 'defCli'>
  deployDot: string | undefined
  onSection: (s: string) => void
}) {
  const { statusOf, ordered, isReady, moveCli, defCli } = cli
  // 侧栏里拖动 CLI 调整顺序：拖到哪一项上就插到那里
  const [dragging, setDragging] = useState('')
  // 提示挂在 aria-describedby 上：放进按钮里会被算进可访问名称，按名字找这一项就找不到了
  const deployHintId = useId()
  return (
    <nav
      aria-label="Agent"
      className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3 md:pt-6"
    >
      {SECTIONS.filter(cliPage).map((s, i, list) => {
        const on = s.id === cur.id
        const st = s.cli && statusOf(s.cli.id)
        const at = s.cli ? ordered.findIndex((c) => c.id === s.cli!.id) : -1
        // 已接入的排在前面；已安装但停用、没安装的都归到「未启用」
        // 组头还要跟当前项自己的状态一致，否则已接入的 CLI 也会被当成未启用组的开头
        const ready = !!s.cli && isReady(s.cli.id)
        const firstReady = ready && !list.slice(0, i).some((x) => !!x.cli && isReady(x.cli.id))
        const firstOff = !!s.cli && !ready && !list.slice(0, i).some((x) => !!x.cli && !isReady(x.cli.id))
        return (
          <div key={s.id} className="contents">
            {firstReady && (
              <span className="hidden items-center justify-between px-2.5 pt-4 pb-1.5 text-caption font-medium tracking-wide text-subtle md:flex">
                {t('已接入')}
                <span className="font-normal tracking-normal text-subtle/70">{t('拖动调整顺序')}</span>
              </span>
            )}
            {firstOff && (
              <span className="hidden px-2.5 pt-4 pb-1.5 text-caption font-medium tracking-wide text-subtle md:flex">
                {t('未启用')}
              </span>
            )}
            <NavRow
              onClick={() => onSection(s.id)}
              on={on}
              aria-describedby={s.id === 'deploy' && deployDot ? deployHintId : undefined}
              title={s.cli ? t('拖动调整顺序，或按 Alt + ↑ / ↓') : undefined}
              draggable={!!s.cli}
              onDragStart={(e) => {
                if (!s.cli) return
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.cli.id)
                setDragging(s.cli.id)
              }}
              onDragOver={(e) => {
                if (!dragging || !s.cli) return
                e.preventDefault()
                if (s.cli.id !== dragging) moveCli(dragging, at)
              }}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => setDragging('')}
              onKeyDown={(e) => {
                if (!s.cli || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                e.preventDefault()
                moveCli(s.cli.id, at + (e.key === 'ArrowUp' ? -1 : 1))
              }}
              className={cn(
                'group w-auto shrink-0 whitespace-nowrap md:w-full',
                s.cli && dragging === s.cli.id && 'opacity-50',
              )}
              icon={
                s.cli ? (
                  <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(s.cli.id) }} />
                ) : (
                  s.icon && <s.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={2.2} />
                )
              }
              label={s.label}
              trailing={
                <>
                  {s.id === 'deploy' && deployDot && (
                    <span
                      aria-hidden="true"
                      title={deployDot}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                  )}
                  {/* 选中行的底色就是 sel，「默认」小签换成卡片底才分得开（同侧栏的 SidebarCount） */}
                  {s.cli && defCli === s.cli.id && (
                    <Badge className={cn('px-1.5 text-micro', on && 'bg-card')}>{t('默认')}</Badge>
                  )}
                  {s.cli && (
                    <GripVertical className="hidden h-3.5 w-3.5 shrink-0 text-subtle opacity-0 group-hover:opacity-100 md:block" />
                  )}
                  {st && (
                    <span
                      className={cn(
                        'hidden h-1.5 w-1.5 shrink-0 rounded-full md:block',
                        st.installed && st.enabled ? 'bg-success' : 'bg-line-strong',
                      )}
                    />
                  )}
                </>
              }
            />
            {s.id === 'deploy' && deployDot && (
              <span id={deployHintId} className="sr-only">
                {deployDot}
              </span>
            )}
          </div>
        )
      })}
    </nav>
  )
}
