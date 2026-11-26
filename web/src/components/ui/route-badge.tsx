import { Plug, Waypoints } from 'lucide-react'
import type { ToolRoute } from '@shared/capability-router/tool-route'
import { t } from '@shared/i18n'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'

const OUTCOME: Record<ToolRoute['steps'][number]['outcome'], { label: () => string; tone: string }> = {
  used: { label: () => t('用了'), tone: 'text-success' },
  empty: { label: () => t('没查到'), tone: 'text-subtle' },
  skipped: { label: () => t('跳过'), tone: 'text-subtle' },
  failed: { label: () => t('出错'), tone: 'text-danger' },
}

const viaLabel = (via: 'mcp' | 'panel') => (via === 'mcp' ? 'MCP' : t('面板'))

/** 小标上写的字：最后给出结果的几条路；都没查到时写「都没查到」 */
export function routeText(route: ToolRoute): string {
  return route.served.length ? route.served.map((s) => s.label).join(' + ') : t('都没查到')
}

/**
 * 工具卡片标题行耗时旁的小标：这次调用最终实际走的路（「· 面板按文本找」「· idea · lua_code」），后面淡淡标出是 MCP 还是面板自带。
 * 网关改写过的写「改走」（以后第二期）。设置 → 组件微调「路由小标」能关掉（--c-routeBadge-show）；点开那一行看 RouteSteps
 */
export function RouteBadge({ route, className }: { route: ToolRoute; className?: string }) {
  const via = route.served[0]?.via
  const tip = route.steps
    .map((s) => `${s.label}（${viaLabel(s.via)}）：${OUTCOME[s.outcome].label()}${s.why ? ` · ${s.why}` : ''}`)
    .join('\n')
  return (
    <span
      data-route-badge=""
      title={tip}
      className={cn(
        'min-w-0 shrink items-center gap-1 text-caption text-subtle [display:var(--c-routeBadge-show)]',
        className,
      )}
    >
      <span aria-hidden className="text-subtle/60">
        ·
      </span>
      {route.from && <span className="shrink-0">{t('改走')}</span>}
      <span className={cn('min-w-0 truncate', !route.served.length && 'text-warning')}>{routeText(route)}</span>
      {via && (
        <span className="chip-lift shrink-0 rounded-sm bg-sel px-1 text-micro leading-4 text-subtle">
          {viaLabel(via)}
        </span>
      )}
    </span>
  )
}

/** 点开工具卡片时最上面的一段：路由走过的每条路，用了 / 没查到 / 跳过（为什么）/ 出错，各自多久 */
export function RouteSteps({ route }: { route: ToolRoute }) {
  return (
    <div data-route-steps="" className="flex flex-col gap-1 px-3 py-2 font-sans text-caption">
      <span className="flex items-center gap-1.5 text-subtle">
        <Waypoints className="h-3 w-3 shrink-0" />
        {route.from
          ? t('面板把 {from} 改走 {cap}', { from: route.from, cap: route.capability })
          : route.capability === 'mcp'
            ? t('面板代为调用外部服务')
            : t('面板按顺序试了这几条路')}
        {route.ms !== undefined && <span className="tabular-nums">· {fmtDuration(route.ms)}</span>}
      </span>
      {route.steps.map((s, i) => (
        <span key={`${s.source}-${i}`} className="flex min-w-0 items-center gap-2 pl-4.5">
          <span className="w-4 shrink-0 text-right font-mono text-subtle/70 tabular-nums">{i + 1}</span>
          {s.via === 'mcp' ? (
            <Plug className="h-3 w-3 shrink-0 text-subtle" />
          ) : (
            <Waypoints className="h-3 w-3 shrink-0 text-subtle" />
          )}
          <span className="shrink-0 text-muted">{s.label}</span>
          <span className="shrink-0 text-subtle/70">{viaLabel(s.via)}</span>
          <span className={cn('shrink-0', OUTCOME[s.outcome].tone)}>{OUTCOME[s.outcome].label()}</span>
          {s.why && (
            <span className="min-w-0 truncate text-subtle" title={s.why}>
              {s.why}
            </span>
          )}
          {s.ms !== undefined && <span className="ml-auto shrink-0 text-subtle tabular-nums">{fmtDuration(s.ms)}</span>}
        </span>
      ))}
    </div>
  )
}
