import { Check, CircleAlert, Loader2 } from 'lucide-react'
import type { SaveStatus } from '@/lib/useAutosave'

/** 右侧详情：头部 + 两栏内容（表单 / 辅助信息） */
export function Detail({
  header,
  form,
  aside,
}: {
  header: React.ReactNode
  form: React.ReactNode
  aside: React.ReactNode
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      {header}
      <div className="flex flex-wrap items-start gap-8 px-4 pt-6 pb-10 md:px-8 md:pt-7">
        <div className="flex max-w-[760px] min-w-0 flex-[999_1_440px] flex-col gap-7">{form}</div>
        <aside className="flex max-w-[380px] min-w-0 flex-[1_1_280px] flex-col gap-4 xl:sticky xl:top-7">{aside}</aside>
      </div>
    </main>
  )
}

export function DetailHeader({
  leading,
  title,
  meta,
  subtitle,
  actions,
  save,
}: {
  leading: React.ReactNode
  title: string
  meta?: React.ReactNode
  subtitle: string
  actions: React.ReactNode
  save: { status: SaveStatus; error: string; invalid?: string }
}) {
  return (
    <header className="flex flex-wrap items-center gap-4 border-b bg-bg px-4 py-5 md:px-8">
      {leading}
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-xl font-semibold">{title}</h2>
          {meta}
        </div>
        <p className="truncate text-[13px] text-muted">{subtitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SaveIndicator {...save} />
        {actions}
      </div>
    </header>
  )
}

function SaveIndicator({ status, error, invalid }: { status: SaveStatus; error: string; invalid?: string }) {
  if (invalid)
    return (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        <CircleAlert className="h-3.5 w-3.5" />
        {invalid}
      </span>
    )
  if (status === 'error')
    return (
      <span className="flex max-w-60 items-center gap-1.5 truncate text-xs text-danger" title={error}>
        <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        保存失败：{error}
      </span>
    )
  if (status === 'pending' || status === 'saving')
    return (
      <span className="flex items-center gap-1.5 text-xs text-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        保存中
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-xs text-subtle">
      <Check className="h-3.5 w-3.5" />
      已自动保存
    </span>
  )
}

export function DetailEmpty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-[420px] flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</div>
        <h2 className="mt-4 text-base font-semibold">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </main>
  )
}
