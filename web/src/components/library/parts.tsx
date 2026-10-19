import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'

/** 页面外层：标题、说明、右上角操作、内容 */
export function PageFrame({
  title,
  intro,
  actions,
  children,
}: {
  title: string
  intro: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-4 pt-6 pb-12 md:px-8 md:pt-8">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-1 max-w-[620px] text-[0.8125rem] leading-relaxed text-muted">{intro}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
        {children}
      </div>
    </main>
  )
}

/** CLI 的小标签：标识色的点加名字 */
export function CliTag({
  id,
  name,
  onClick,
  className,
}: {
  id: string
  name: string
  onClick?: () => void
  className?: string
}) {
  const body = (
    <>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cliColor(id) }} />
      {name}
    </>
  )
  const cls = cn(
    'inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-px text-[0.71875rem] text-muted',
    onClick && 'cursor-pointer hover:bg-sel hover:text-fg',
    className,
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <span className={cls}>{body}</span>
  )
}
