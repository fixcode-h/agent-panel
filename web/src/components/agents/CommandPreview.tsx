import { previewCommand } from '@shared/clis'
import { cn } from '@/lib/utils'

/** 仿终端的命令预览 */
export function CommandPreview({
  cli,
  model,
  extraArgs,
  className,
}: {
  cli: string
  model: string
  extraArgs: string[]
  className?: string
}) {
  const [cmd, ...rest] = previewCommand(cli, model, extraArgs).split(' ')
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-[oklch(0.16_0.01_286)] text-[oklch(0.9_0.01_286)]', className)}>
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-[11px] text-white/40">命令预览</span>
      </div>
      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] px-3.5 py-3 font-mono text-[12px] leading-relaxed">
        <span className="text-[oklch(0.75_0.15_150)]">$</span> <span className="text-[oklch(0.82_0.12_290)]">{cmd}</span>{' '}
        {rest.map((t, i) => (
          <span key={i} className={t.startsWith('-') ? 'text-[oklch(0.8_0.1_220)]' : t.startsWith('"') ? 'text-[oklch(0.82_0.12_80)]' : ''}>
            {t}{' '}
          </span>
        ))}
      </pre>
    </div>
  )
}
