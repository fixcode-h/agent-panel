import type { HookEventName } from '@shared/hooks/defs'
import { t } from '@shared/i18n'
import type { HooksView } from '@/lib/api-hooks'
import { Checkbox } from '@/components/ui/checkbox'
import { Group, Row } from './parts'
import { eventLabel } from './hook-labels'

/** CLI 能装的那四个事件；只通知的面板事件不经过 CLI，不在这里开关 */
const CLI_EVENTS: HookEventName[] = ['turn.beforeEnd', 'tool.before', 'tool.after', 'context.restored']

/**
 * 「各 CLI 的事件」（ADR 0049 第四期）：每个 CLI 能装哪几个事件、按 CLI 关掉某个事件（比如中转站上 Codex 的工具后补说明
 * 会让下一次请求报错），以及本机版本太老、装不上的事件要多少版本。关掉的事件对内置和自己的钩子都不装
 */
export function HookCliEvents({
  view,
  busy,
  onChange,
}: {
  view: HooksView
  busy: boolean
  onChange: (cli: string, off: HookEventName[]) => void
}) {
  return (
    <Group title={t('各 CLI 的事件')}>
      {view.support.map((s) => {
        const off = view.cliOff[s.id] ?? []
        const can = CLI_EVENTS.filter((e) => s.events.includes(e))
        const old = s.tooOld.map((x) => t('{event}要 {min} 以上', { event: eventLabel(x.event), min: x.min }))
        return (
          // 四个勾选框放在右边那一栏放不下：上下排，勾选框在标题下面一行
          <Row
            key={s.id}
            stack
            title={s.name}
            desc={s.version ? t('本机版本 {v}', { v: s.version }) : t('还没检测到版本')}
            hint={
              [
                can.length ? '' : t('这个 CLI 没有能装的钩子事件，只有一轮结束后的提醒兜底'),
                old.length ? t('版本太老，这些事件不装：{list}', { list: old.join('、') }) : '',
              ]
                .filter(Boolean)
                .join('；') || undefined
            }
          >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {can.map((e) => (
                <Checkbox
                  key={e}
                  checked={!off.includes(e)}
                  disabled={busy}
                  onChange={(v) => onChange(s.id, v ? off.filter((x) => x !== e) : [...off, e])}
                  label={eventLabel(e)}
                  ariaLabel={`${s.name} ${eventLabel(e)}`}
                />
              ))}
            </div>
          </Row>
        )
      })}
    </Group>
  )
}
