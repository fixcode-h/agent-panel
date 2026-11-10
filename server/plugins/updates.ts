import { isNewerPlugin, type PluginUpdate } from '../../shared/plugins/version.ts'
import { readMarket, readRepoVersion, type MarketEntry } from './github.ts'
import type { Installed } from './store.ts'

/**
 * 检查插件更新：只看从 GitHub 装的插件（压缩包、本机目录没有上游可比）。
 * 同一个仓库只读一次插件目录（plugins.json）：插件在目录里就拿目录里的版本比，
 * 仓库没有插件目录（整个仓库是一个插件）就读安装时那个分支 / 子目录上的 plugin.json。
 * 某个仓库读不到（断网、限流）只记一条错误，不影响其他仓库。
 */
export async function checkPluginUpdates(list: Installed[]) {
  const github = list.filter((p) => p.source.kind === 'github')
  const markets = new Map<string, Promise<MarketEntry[] | undefined>>()
  const updates: PluginUpdate[] = []
  const errors: { repo: string; error: string }[] = []
  await Promise.all(
    github.map(async (p) => {
      const repo = p.source.ref
      try {
        if (!markets.has(repo)) markets.set(repo, readMarket(repo))
        const market = await markets.get(repo)
        let latest: string | undefined
        let install: PluginUpdate['install']
        if (market) {
          latest = market.find((e) => e.id === p.manifest.id)?.version
          install = { repo, id: p.manifest.id }
        } else {
          const ref = p.source.tag || 'HEAD'
          latest = await readRepoVersion(repo, ref, p.source.path)
          install = { repo, ref, path: p.source.path ?? '' }
        }
        if (latest && isNewerPlugin(latest, p.manifest.version))
          updates.push({ id: p.manifest.id, current: p.manifest.version, latest, install })
      } catch (e) {
        if (!errors.some((x) => x.repo === repo)) errors.push({ repo, error: (e as Error).message })
      }
    }),
  )
  return { updates, errors, checkedAt: new Date().toISOString() }
}
