import { t } from '@shared/i18n'
import type { PluginHookView } from '@/lib/api-hooks'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'
import { eventLabel } from './hook-labels'

/**
 * 设置 →「钩子」里「插件带的钩子」：开着的插件清单里写的钩子（插件接口 3），插件打开就生效，
 * 这里只能单独关掉某一个；定义跟着插件包走，关掉或删除插件后整组消失
 */
export function PluginHooksGroup({
  hooks,
  busy,
  supportText,
  onToggle,
}: {
  hooks: PluginHookView[]
  busy: string
  supportText: (event: string) => string
  onToggle: (h: PluginHookView, on: boolean) => void
}) {
  if (!hooks.length) return null
  return (
    <Group title={t('插件带的钩子')}>
      {hooks.map((h) => (
        <Row
          key={h.id}
          title={h.name}
          desc={
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge>{h.plugin}</Badge>
              {h.description && <span>{h.description}</span>}
            </span>
          }
          hint={`${eventLabel(h.event)} · ${supportText(h.event)}`}
        >
          <Switch
            checked={h.on}
            disabled={busy === `p:${h.id}`}
            onCheckedChange={(on) => onToggle(h, on)}
            aria-label={h.name}
          />
        </Row>
      ))}
    </Group>
  )
}
