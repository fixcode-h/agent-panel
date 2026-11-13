import { useState, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Collapse } from '@/components/ui/collapse'

/**
 * 能力来源的头（设置 →「MCP」的每一页顶上）：图标、名字、来源和服务名、状态；一句作用；
 * 「什么时候挂」；「用法说明」默认收着，展开是新会话开头交给 Agent 的那一段原文
 */
export function CapabilityServerHeader({
  icon: Icon,
  name,
  meta,
  status,
  summary,
  rows,
  hint,
}: {
  icon: LucideIcon
  name: string
  meta?: string
  status?: ReactNode
  summary?: string
  /** 「什么时候挂」这类说明行：左边标签，右边内容 */
  rows?: { label: string; value: ReactNode }[]
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Card padding="md" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold">{name}</span>
            {meta && <span className="text-caption text-subtle">{meta}</span>}
            {status}
          </div>
          {summary && <div className="mt-1 text-body text-muted">{summary}</div>}
        </div>
      </div>
      {(!!rows?.length || hint) && (
        <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-body">
          {rows?.map((r) => (
            <div key={r.label} className="contents">
              <span className="text-subtle">{r.label}</span>
              <span className="min-w-0 text-muted">{r.value}</span>
            </div>
          ))}
          {hint && (
            <>
              <span className="text-subtle">{t('用法说明')}</span>
              <span className="min-w-0 text-muted">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-accent-text hover:underline"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                >
                  {open ? t('收起') : t('新会话开头交给 Agent 的一段（{n} 字）', { n: hint.length })}
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                </button>
                <Collapse open={open} className="mt-2">
                  <div className="rounded-md bg-sel/50 px-3 py-2 text-caption whitespace-pre-wrap">{hint}</div>
                </Collapse>
              </span>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
