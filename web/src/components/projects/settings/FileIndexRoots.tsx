import { t } from '@shared/i18n'
import type { FileIndexStatus } from '@shared/file-index/types'

/** 根目录的来源怎么叫：项目、文档根（P4 / SVN 项目外的 ProjectDoc/docs 这类）、额外目录、插件报来的（UE 引擎目录） */
function sourceLabel(source: string) {
  if (source === 'project') return t('项目目录')
  if (source === 'doc') return t('文档根')
  if (source === 'extra') return t('额外目录')
  if (source.startsWith('plugin:')) return t('插件 {id}', { id: source.slice('plugin:'.length) })
  return source
}

/**
 * 状态卡里按根目录分开列：文档根、引擎目录在项目外时，一眼看得出它们也收进了索引、各收了多少
 * （用户 2026-11-23 以为项目外的文档目录没进索引）。只有一个根时不列
 */
export function FileIndexRoots({ roots }: { roots: FileIndexStatus['roots'] }) {
  if (roots.length < 2) return null
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {roots.map((r) => (
        <li key={r.key} className="flex min-w-0 items-center gap-2">
          <span className="w-16 shrink-0 text-muted">{sourceLabel(r.source)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-subtle" title={r.root}>
            {r.root}
          </span>
          <span className="shrink-0 font-mono text-muted">
            {r.state === 'building' ? t('建立中') : t('{files} 个文件', { files: r.files.toLocaleString() })}
          </span>
        </li>
      ))}
    </ul>
  )
}
