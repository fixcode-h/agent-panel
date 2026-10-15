import { SquareTerminal } from 'lucide-react'
import { getCli } from '@shared/clis'
import { cn } from '@/lib/utils'

/** 仿终端的命令预览，固定深色 */
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
  const def = getCli(cli)
  if (!def) return null
  const args = def.buildArgs({ model, prompt: '"<任务描述>"', extraArgs })
  const color = (t: string) =>
    t.startsWith('-') ? 'text-[#7cc4fa]' : t.startsWith('"') ? 'text-[#f2c46d]' : 'text-[#d9dbe0]'
  return (
    <section className={cn('overflow-hidden rounded-xl border border-[#23252c] bg-[#0b0c0f]', className)}>
      <div className="flex items-center gap-1.5 border-b border-[#1e2026] px-3.5 py-2.5 text-xs text-[#8c909a]">
        <SquareTerminal className="h-3.5 w-3.5" />
        命令预览
      </div>
      <p className="px-3.5 pt-3 pb-3.5 font-mono text-[12.5px] leading-[1.7] [overflow-wrap:anywhere]">
        <span className="text-[#5fd39a]">$ </span>
        <span className="text-[#b9aeff]">{def.command} </span>
        {args.map((t, i) => (
          <span key={i} className={color(t)}>
            {t}{' '}
          </span>
        ))}
      </p>
    </section>
  )
}
