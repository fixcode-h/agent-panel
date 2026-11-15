import type { PluginUpdate } from '../../../shared/plugins/version.ts'
import type { Installed } from '../store.ts'
import { upstreamHead } from './fetch.ts'
import { versionOf } from './generate.ts'

/**
 * 包装插件的更新检查（ADR 0068，设计稿第 8 节）：按清单 wrap.track 查上游——最新 Release 的标签变了、
 * 或分支 / 标签指到了新提交，就算有更新。只读不装；升级走包装预览（只列新增发现和权限变化）。
 */
export async function checkWrapUpdate(p: Installed): Promise<PluginUpdate | undefined> {
  const w = p.manifest.wrap
  if (!w) return undefined
  const head = await upstreamHead(w.repo, w.track, w.ref)
  const changed = head.commit ? head.commit !== w.commit : head.ref !== p.source.tag
  if (!changed) return undefined
  return {
    id: p.manifest.id,
    current: p.manifest.version,
    latest: head.commit ? versionOf(head.ref, head.commit) : versionOf(head.ref, ''),
    install: { repo: w.repo, wrap: true },
  }
}
