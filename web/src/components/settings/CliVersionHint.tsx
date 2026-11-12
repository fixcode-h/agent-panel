import { CircleAlert } from 'lucide-react'
import type { CliDefinition } from '@shared/clis'
import { versionShortfalls } from '@shared/cli/version'
import { t } from '@shared/i18n'

/**
 * 设置页 CLI 头部的版本门槛提示（ADR 0050）：本机版本低于定义里某个功能要的版本时写一行，
 * 旁边已有的「更新」按钮照旧；够用时什么都不画
 */
export function CliVersionHint({ def, version }: { def: CliDefinition; version?: string }) {
  const need = versionShortfalls(def, version)
  if (!need.length) return null
  return (
    <p className="flex w-full items-center gap-1.5 text-footnote text-warning">
      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
      {t('本机 {cli} {version}，{list}，低于这个版本时面板不装', {
        cli: def.name,
        version: version ?? '',
        list: need.map((n) => t('{what}要 {min} 以上', { what: n.what, min: n.min })).join('；'),
      })}
    </p>
  )
}
