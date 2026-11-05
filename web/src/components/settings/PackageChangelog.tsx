import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { newerThan, type ChangelogEntry } from '@shared/package-changelog'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { Markdown } from '@/components/tasks/Markdown'

const NO_TEAM = new Set<string>()

/**
 * 一个已装插件的更新说明（ADR 0050 第四期）：读包里的 CHANGELOG。from 是更新前的版本：
 * 刚更新完时只列比它新的几条（「这次更新了什么」），平时点开列最近的
 */
export function PackageChangelog({ cli, source, from }: { cli: string; source: string; from?: string }) {
  const [entries, setEntries] = useState<ChangelogEntry[] | null | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    setEntries(undefined)
    cliMoreApi
      .packageChangelog(cli, source)
      .then(setEntries)
      .catch((e) => setError((e as Error).message))
  }, [cli, source])
  if (error) return <p className="px-3 pb-2 text-footnote text-warning">{t('读取失败：{error}', { error })}</p>
  if (entries === undefined)
    return (
      <p className="flex items-center gap-1.5 px-3 pb-2 text-footnote text-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('读取中…')}
      </p>
    )
  const shown = entries ? newerThan(entries, from).slice(0, from ? 30 : 5) : []
  if (!shown.length)
    return (
      <p className="px-3 pb-2 text-footnote text-subtle">
        {!entries ? t('这个插件没有提供更新说明') : t('没有比 {version} 新的更新说明', { version: from ?? '' })}
      </p>
    )
  return (
    <div className="mx-3 mb-2 flex max-h-72 flex-col gap-3 overflow-auto rounded-lg bg-field px-3 py-2">
      {from && <p className="text-footnote text-subtle">{t('从 {version} 更新后新增的：', { version: from })}</p>}
      {shown.map((e) => (
        <section key={e.version} className="flex flex-col gap-1">
          <h4 className="font-mono text-footnote font-medium">{e.version}</h4>
          {e.body ? (
            <Markdown text={e.body} teamNames={NO_TEAM} compact />
          ) : (
            <p className="text-footnote text-subtle">{t('（没有写内容）')}</p>
          )}
        </section>
      ))}
    </div>
  )
}
