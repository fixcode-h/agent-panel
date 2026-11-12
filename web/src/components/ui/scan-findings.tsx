import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ConfigFinding, ScanLevel, ScanSummary } from '@shared/config-scan'
import { summarize } from '@shared/config-scan'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from './badge'
import { Button } from './button'

/**
 * 配置安全扫描的结果（借鉴 ECC 的 AgentShield）：插件安装弹窗、Skill 详情、MCP 导入、钩子编辑器、项目文档共用。
 * ScanBadge 是列表里的小盾牌（只数中级以上），ScanFindings 是逐条列出、能点「这条没问题」的清单。
 * 设置 → 组件里有样张
 */

const LEVEL_TONE: Record<ScanLevel, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}
export const levelLabel = (l: ScanLevel) => ({ high: t('高'), medium: t('中'), low: t('低') })[l]

/** 列表里的小盾牌：有中级以上的发现才画，悬停写各级条数。给 summary（列表接口只带条数）或 findings */
export function ScanBadge({
  summary,
  findings,
  className,
}: {
  summary?: ScanSummary
  findings?: Pick<ConfigFinding, 'level'>[]
  className?: string
}) {
  const s = summary ?? summarize(findings ?? [])
  const n = s.high + s.medium
  if (!n) return null
  const title = t('安全扫描：高 {high} 条，中 {medium} 条', { high: s.high, medium: s.medium })
  return (
    <Badge tone={s.high ? 'danger' : 'warning'} className={className} title={title} aria-label={title}>
      <ShieldAlert className="h-3 w-3" aria-hidden />
      {n}
    </Badge>
  )
}

/**
 * 逐条列出：级别、文件和行号、为什么危险、那一行（截短、密钥打码）。onIgnore 给了才有「这条没问题」，
 * 点了这一条就不再出现（那一行改了会重新出现）。低级默认收起，点「还有 N 条低级」展开
 */
export function ScanFindings({
  findings,
  onIgnore,
  className,
  title,
}: {
  findings: ConfigFinding[]
  onIgnore?: (f: ConfigFinding) => Promise<void> | void
  className?: string
  /** 不传用默认的「安全扫描发现 N 处要看一下」 */
  title?: string
}) {
  const [showLow, setShowLow] = useState(false)
  const [busy, setBusy] = useState('')
  if (!findings.length) return null
  const main = findings.filter((f) => f.level !== 'low')
  const low = findings.filter((f) => f.level === 'low')
  const list = showLow || !main.length ? findings : main
  const s = summarize(findings)
  const tone = s.high ? 'text-danger' : s.medium ? 'text-warning' : 'text-subtle'
  const key = (f: ConfigFinding) => `${f.rule}|${f.file}|${f.line}|${f.snippet}`
  return (
    <div data-surface="" className={cn('flex flex-col gap-2 rounded-lg border bg-card p-3', className)}>
      <p className={cn('flex items-center gap-1.5 text-body font-medium', tone)}>
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        {title ?? t('安全扫描发现 {n} 处要看一下', { n: main.length || low.length })}
      </p>
      <ul className="flex flex-col gap-2">
        {list.map((f) => (
          <li key={key(f)} className="flex min-w-0 flex-col gap-0.5 text-body">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge tone={LEVEL_TONE[f.level]}>{levelLabel(f.level)}</Badge>
              <span className="min-w-0 truncate font-mono text-xs text-muted">
                {f.line ? `${f.file}:${f.line}` : f.file}
              </span>
              {f.example && <span className="text-xs text-subtle">{t('（在示例里，降了一级）')}</span>}
              {onIgnore && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy === key(f)}
                  onClick={async () => {
                    setBusy(key(f))
                    try {
                      await onIgnore(f)
                    } finally {
                      setBusy('')
                    }
                  }}
                >
                  {t('这条没问题')}
                </Button>
              )}
            </div>
            <span className="text-muted">{f.why}</span>
            <code className="block min-w-0 truncate rounded-sm bg-sel/60 px-1.5 py-0.5 font-mono text-xs text-subtle">
              {f.snippet}
            </code>
          </li>
        ))}
      </ul>
      {!showLow && main.length > 0 && low.length > 0 && (
        <Button size="sm" variant="link" className="self-start" onClick={() => setShowLow(true)}>
          {t('还有 {n} 条低级', { n: low.length })}
        </Button>
      )}
    </div>
  )
}
