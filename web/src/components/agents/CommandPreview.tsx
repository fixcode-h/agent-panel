import { Fragment, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, SquareTerminal } from 'lucide-react'
import { commandText, getCli, quoteArg } from '@shared/clis'
import type { Settings } from '@shared/schema'
import { agentCli, agentPermission, agentRun, cliSettings, defaultSettings } from '@shared/settings'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 仿终端的命令预览，固定深色。任务描述通过 stdin 传入，所以写成管道形式 */
export function CommandPreview({
  cli,
  model,
  effort = '',
  permission = '',
  extraArgs,
  className,
  title = t('命令预览'),
  override,
}: {
  cli: string
  model: string
  effort?: string
  /** Agent 自己指定的权限；为空跟随 CLI 设置 */
  permission?: string
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
    permission: agentPermission({ cli, permission }, s),
    extraArgs: [...cs.extraArgs, ...extraArgs],
    options: cs.options,
  })
  return <Terminal argv={[cs.command, ...args]} title={title} className={className} />
}

/** 复制按钮：复制后短暂显示「已复制」 */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => toast.error(t('复制失败，可以手动选中命令复制')))
      }
      title={t('复制命令')}
      aria-label={t('复制命令')}
      className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[#8c909a] transition-colors hover:bg-[#1e2026] hover:text-[#d9dbe0]"
    >
      {done ? <Check className="h-3.5 w-3.5 text-[#5fd39a]" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? t('已复制') : t('复制')}
    </button>
  )
}

/** 短参数整段不断行，超长的参数允许在任意位置断开，免得撑出横向滚动 */
const wrapClass = (a: string) => (a.length > 32 ? '[overflow-wrap:anywhere]' : 'whitespace-nowrap')

/** 仿终端显示一条命令（第一个是可执行文件），右上角可以复制 */
export function Terminal({
  argv,
  title = t('命令预览'),
  className,
}: {
  argv: string[]
  title?: string
  className?: string
}) {
  const [cmd, ...args] = argv
  const color = (a: string) => (a.startsWith('-') ? 'text-[#7cc4fa]' : 'text-[#d9dbe0]')
  return (
    <section className={cn('overflow-hidden rounded-xl border border-[#23252c] bg-[#0b0c0f]', className)}>
      <div className="flex items-center gap-1.5 border-b border-[#1e2026] px-3.5 py-2 text-xs text-[#8c909a]">
        <SquareTerminal className="h-3.5 w-3.5" />
        {title}
        <CopyButton text={commandText(argv)} />
      </div>
      {/* 只在参数之间换行：参数里的「-」也是浏览器默认的断行点，不禁掉的话「--verbose」会被拆成两行；
          特别长的单个参数（路径、JSON）才在中间断开 */}
      <p className="px-3.5 pt-3 pb-3.5 font-mono text-[0.78125rem] leading-[1.7] select-text">
        <span className="text-[#5fd39a]">$ </span>
        <span className="whitespace-nowrap text-[#f2c46d]">echo "{t('<任务描述>')}"</span>{' '}
        <span className="text-[#8c909a]">| </span>
        <span className={cn('text-[#b9aeff]', wrapClass(cmd ?? ''))}>{quoteArg(cmd ?? '')}</span>{' '}
        {args.map((a, i) => (
          <Fragment key={i}>
            <span className={cn(color(a), wrapClass(a))}>{quoteArg(a)}</span>{' '}
          </Fragment>
        ))}
      </p>
    </section>
  )
}
