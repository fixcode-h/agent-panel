import { CheckCircle2, CircleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from './badge'
import { Card } from './card'

/**
 * 一次命令运行的结果：头一行成功 / 失败和展开后的命令，下面是交给 Agent 的同一份结果文字，
 * 再下面是输出尾部（等宽、可滚）。自建工具的试运行和保存弹窗里的试运行都用它（ADR 0082）
 */
export function ToolRunResult({
  ok,
  line,
  text,
  output,
  dryRun,
  className,
}: {
  ok: boolean
  line: string
  /** 交给 Agent 的结果文字 */
  text: string
  output?: string[]
  /** 只展开了命令、没执行 */
  dryRun?: boolean
  className?: string
}) {
  const Icon = ok ? CheckCircle2 : CircleAlert
  return (
    <Card padding="sm" className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-center gap-1.5 text-body font-medium">
        <Icon className={cn('h-4 w-4', ok ? 'text-success' : 'text-danger')} />
        {dryRun ? (ok ? t('命令展开成功（没有执行）') : t('展开失败')) : ok ? t('运行成功') : t('运行失败')}
      </div>
      {line && <code className="block font-mono text-footnote break-all whitespace-pre-wrap text-muted">{line}</code>}
      {!dryRun && text && (
        <pre className="max-h-48 overflow-auto rounded-md bg-sel/50 p-2 font-mono text-caption whitespace-pre-wrap">
          {text}
        </pre>
      )}
      {dryRun && !ok && text && <p className="text-footnote text-danger">{text}</p>}
      {!!output?.length && (
        <details>
          <summary className="cursor-pointer text-footnote text-subtle">
            {t('完整输出 {n} 行', { n: output.length })}
          </summary>
          <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-sel/50 p-2 font-mono text-caption whitespace-pre-wrap">
            {output.join('\n')}
          </pre>
        </details>
      )}
    </Card>
  )
}

const EFFECT_TONE = { read: 'success', write: 'warning', external: 'danger' } as const
type Effect = keyof typeof EFFECT_TONE
export const commandEffectLabel = (e: Effect) =>
  e === 'read' ? t('只读') : e === 'write' ? t('会改文件') : t('影响外部')

/** 一条命令会不会改东西的小标签：只读绿、改文件黄、影响外部红（自建工具的列表、保存弹窗）。和 MCP 工具的 EffectBadge（capability-row）分开：那套是工具对外界做什么的七类，这里只分三档 */
export function CommandEffectBadge({ effect }: { effect: Effect }) {
  return <Badge tone={EFFECT_TONE[effect]}>{commandEffectLabel(effect)}</Badge>
}
