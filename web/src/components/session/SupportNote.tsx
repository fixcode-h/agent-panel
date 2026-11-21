import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { SUPPORT_ITEMS, supportTierLabel, supportValueText, type SupportKey } from '@shared/models/support'
import { SessionDisclosure, SessionDisclosureItem } from './SessionCard'
import { sessionUsage } from './SessionContext'

/**
 * 会话栏「环境」里的一行：这一轮按模型档位加强了扶持（shared/models/support.ts）时写「已按弱模型加强扶持」，
 * 点开列出加强了哪几项、各是多少。数据是这一轮开跑时 runner 记进会话用量的，没加强就不显示
 */
export function SupportNote({ task }: { task: Task }) {
  const sup = sessionUsage(task)?.usage.support
  if (!sup?.boosted.length) return null
  return (
    <div data-model-support={sup.tier}>
      <SessionDisclosure
        label={t('已按{tier}模型加强扶持', { tier: supportTierLabel(sup.tier) })}
        count={sup.boosted.length}
      >
        {sup.boosted.map((b) => {
          const it = SUPPORT_ITEMS.find((x) => x.key === b.key)
          if (!it) return null
          return (
            <SessionDisclosureItem
              key={b.key}
              name={it.label()}
              value={supportValueText(b.key as SupportKey, b.value)}
              title={it.hint()}
            />
          )
        })}
      </SessionDisclosure>
    </div>
  )
}
