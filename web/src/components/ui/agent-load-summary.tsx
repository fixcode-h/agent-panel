import { t } from '@shared/i18n'
import { Card } from '@/components/ui/card'

/** 几千 tokens 写成「4.8k」 */
export const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/**
 * 「交给 Agent 的」小结（项目设置 →「能力」右栏，设计稿 6.3）：打开了的插件、MCP、技能，工具个数和工具说明
 * 大约多少 tokens，再和全部打开时比，看得出关掉能省多少。外观跟卡片的调节走（设置 → 组件）
 */
export function AgentLoadSummary({
  rows,
  tools,
  tokens,
  allTools,
  allTokens,
}: {
  /** 每行一类：插件、MCP、技能 → 写成一句 */
  rows: { label: string; value: string }[]
  tools: number
  tokens: number
  /** 全部打开时：和现在一样就不写对比 */
  allTools: number
  allTokens: number
}) {
  return (
    <Card padding="md" className="flex flex-col gap-3">
      <h4 className="text-body font-semibold">{t('交给 Agent 的')}</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-footnote">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-subtle">{r.label}</dt>
            <dd className="min-w-0 break-words text-fg">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1 border-t pt-3">
        <span className="text-body">
          <span className="text-title font-semibold tabular-nums">{tools}</span> {t('个工具')}
        </span>
        <span className="text-caption leading-relaxed text-subtle">
          {allTools > tools
            ? t('工具说明约 {k} tokens；全部打开是 {n} 个、约 {all}。', {
                k: kTokens(tokens),
                n: allTools,
                all: kTokens(allTokens),
              })
            : t('工具说明约 {k} tokens。', { k: kTokens(tokens) })}
        </span>
      </div>
    </Card>
  )
}
