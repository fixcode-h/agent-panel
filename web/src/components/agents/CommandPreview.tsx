import { SquareTerminal } from 'lucide-react'
import { getCli } from '@shared/clis'
import type { Settings } from '@shared/schema'
import { agentCli, agentRun, cliSettings, defaultSettings } from '@shared/settings'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'

/** 仿终端的命令预览，固定深色。任务描述通过 stdin 传入，所以写成管道形式 */
export function CommandPreview({
  cli,
  model,
  effort = '',
  extraArgs,
  className,
  title = '命令预览',
  override,
}: {
  cli: string
  model: string
  effort?: string
  extraArgs: string[]
  className?: string
  title?: string
  /** 设置页还没保存的改动：预览要跟着输入马上变，不等自动保存 */
  override?: Settings['clis'][string]
}) {
  const { settings } = useData()
  const saved = settings ?? defaultSettings()
  const s = override ? { ...saved, clis: { ...saved.clis, [cli]: override } } : saved
  const id = agentCli({ cli }, s)
  const def = getCli(id)
  if (!def) return null
  const cs = cliSettings(s, id)
  const run = agentRun({ cli, model, effort }, s)
  const args = def.buildArgs({
    model: run.model,
    effort: run.effort,
    permission: cs.permission,
    extraArgs: [...cs.extraArgs, ...extraArgs],
  })
  const color = (t: string) => (t.startsWith('-') ? 'text-[#7cc4fa]' : 'text-[#d9dbe0]')
  return (
    <section className={cn('overflow-hidden rounded-xl border border-[#23252c] bg-[#0b0c0f]', className)}>
      <div className="flex items-center gap-1.5 border-b border-[#1e2026] px-3.5 py-2.5 text-xs text-[#8c909a]">
        <SquareTerminal className="h-3.5 w-3.5" />
        {title}
      </div>
      <p className="px-3.5 pt-3 pb-3.5 font-mono text-[12.5px] leading-[1.7] [overflow-wrap:anywhere]">
        <span className="text-[#5fd39a]">$ </span>
        <span className="text-[#f2c46d]">echo "&lt;任务描述&gt;" </span>
        <span className="text-[#8c909a]">| </span>
        <span className="text-[#b9aeff]">{/\s/.test(cs.command) ? JSON.stringify(cs.command) : cs.command} </span>
        {args.map((t, i) => (
          <span key={i} className={color(t)}>
            {/[\s"]/.test(t) ? JSON.stringify(t) : t}{' '}
          </span>
        ))}
      </p>
    </section>
  )
}
