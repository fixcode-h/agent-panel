import { Check, Info, TriangleAlert } from 'lucide-react'
import type { Check as CheckItem } from '@/lib/readiness'
import { cn } from '@/lib/utils'

export function ReadinessCard({ checks }: { checks: CheckItem[] }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h3 className="text-[13px] font-semibold">就绪检查</h3>
      {checks.map((c) => {
        const Icon = c.ok ? Check : c.optional ? Info : TriangleAlert
        return (
          <div key={c.label} className="flex items-start gap-2.5">
            <span
              className={cn(
                'mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-white',
                c.ok ? 'bg-success' : c.optional ? 'bg-subtle' : 'bg-warning',
              )}
            >
              <Icon className="h-3 w-3" strokeWidth={3} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px]">{c.label}</span>
              <span className="text-xs text-subtle [overflow-wrap:anywhere]">{c.hint}</span>
            </span>
          </div>
        )
      })}
    </section>
  )
}
