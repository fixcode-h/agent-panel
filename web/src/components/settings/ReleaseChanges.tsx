import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { releaseChanges, type AppRelease } from '@shared/version'
import { Markdown } from '@/components/tasks/Markdown'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 更新说明里没有 @角色 */
const NO_TEAM = new Set<string>()

/**
 * 「版本更新」里可展开的改动说明：当前版本看「本版更新内容」，有新版本时看从当前版本到新版本之间每一版的改动。
 * 只显示改动各节，下载和安装说明留在 GitHub 的 Release 页面
 */
export function ReleaseChanges({
  label,
  releases,
  defaultOpen = false,
}: {
  label: string
  /** 要列出的版本，新的在前；只有一个时不再重复写版本号 */
  releases: AppRelease[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!releases.length) return null
  const single = releases.length === 1
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-fit cursor-pointer items-center gap-1 text-body text-muted hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && (
        <div className="ml-5 flex max-h-96 flex-col gap-3 overflow-y-auto rounded-lg bg-sel/50 px-4 py-3">
          {releases.map((r) => (
            <div key={r.tag} className="flex flex-col gap-1">
              {!single && <span className="font-mono text-body font-medium">{r.tag}</span>}
              <Markdown
                text={r.notes ? releaseChanges(r.notes) : t('没有更新说明。')}
                teamNames={NO_TEAM}
                compact
                className="release-notes"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
