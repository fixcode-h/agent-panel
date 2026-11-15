import { t } from '../../shared/i18n.ts'
import { dependentsOf, unmetRequires, type UnmetRequire } from '../../shared/plugins/requires.ts'
import type { PluginManifest, PluginSource } from '../../shared/plugins/types.ts'
import { comparePluginVersions } from '../../shared/plugins/version.ts'
import { log } from '../log.ts'
import { DEFAULT_MARKET, downloadEntry, type MarketEntry } from './github.ts'
import { afterInstall, findInstalled, installedList, updatePlugin } from './manager.ts'
import { readMarketCached } from './market-cache.ts'
import { packageRoot, parseManifest, writePackage } from './store.ts'
import { readZip } from './zip.ts'
import { pluginEnabled, pluginOn } from '../../shared/plugins/index.ts'
import { getSettings } from '../settings.ts'

/**
 * 装插件时把它依赖的插件一起装上（插件接口 10，用户 2026-11-15 定）。
 * 依赖从插件市场取：从 GitHub 装的先找同一个仓库的插件目录，找不到再找默认市场（fixcode-h/agent-plugins）；
 * 压缩包、本机目录装的直接找默认市场。依赖自己的依赖也一样处理，绕成圈的只装一次。
 * 预览时只查不装（requiresPlan），找不到、市场里的版本也太旧时直接报错，不让用户点了确认才失败；
 * 确认时先装依赖再装插件本身（installRequires），依赖装失败就停下，插件本身不装
 */

/** 预览里列出的一项：要一起装（或升级）的依赖 */
export interface RequirePlanItem extends UnmetRequire {
  name: string
  latest: string
}

const have = () =>
  installedList().map((p) => ({ id: p.manifest.id, version: p.manifest.version, requires: p.manifest.requires }))

const markets = (source?: PluginSource) => [
  ...new Set([...(source?.kind === 'github' ? [source.ref] : []), DEFAULT_MARKET]),
]

/** 在市场里找依赖：先找到的、版本够的那个 */
async function findEntry(u: UnmetRequire, source?: PluginSource) {
  let tooOld: { repo: string; entry: MarketEntry } | undefined
  for (const repo of markets(source)) {
    const list = (await readMarketCached(repo).catch(() => undefined))?.plugins
    const entry = list?.find((e) => e.id === u.id)
    if (!entry) continue
    if (!u.min || comparePluginVersions(entry.version, u.min) >= 0) return { repo, entry }
    tooOld ??= { repo, entry }
  }
  if (tooOld)
    throw new Error(
      t('依赖插件 {id} 要 {min} 或更新，插件市场里只有 {latest}', {
        id: u.id,
        min: u.min,
        latest: tooOld.entry.version,
      }),
    )
  throw new Error(t('依赖插件 {id} 在插件市场里找不到，请先手动装上它', { id: u.id }))
}

/** 预览：列出要一起装的依赖（只看直接依赖；依赖的依赖在确认时一并处理） */
export async function requiresPlan(m: PluginManifest, source?: PluginSource): Promise<RequirePlanItem[]> {
  const out: RequirePlanItem[] = []
  for (const u of unmetRequires(m.id, m.requires, have())) {
    const { entry } = await findEntry(u, source)
    out.push({ ...u, name: entry.name, latest: entry.version })
  }
  return out
}

/** 依赖装着但关着：一起打开（不然装上的插件照样用不了） */
export async function enableRequires(m: PluginManifest) {
  const s = await getSettings()
  for (const id of Object.keys(m.requires ?? {}))
    if (id !== m.id && findInstalled(id) && !pluginOn(s.plugins, id)) await updatePlugin(id, { enabled: true })
}

/** 确认安装时：缺的、太旧的依赖先装上，返回装了哪些 */
export async function installRequires(m: PluginManifest, source?: PluginSource, seen = new Set<string>()) {
  seen.add(m.id)
  const done: string[] = []
  for (const u of unmetRequires(m.id, m.requires, have())) {
    if (seen.has(u.id)) continue
    seen.add(u.id)
    const { repo, entry } = await findEntry(u, source)
    const got = await downloadEntry(repo, entry, 'HEAD')
    const files = readZip(got.zip)
    const root = packageRoot(files, got.path)
    const dep = parseManifest(JSON.parse(files.find((f) => f.name === `${root}plugin.json`)!.data.toString('utf8')))
    if (dep.id !== u.id) throw new Error(t('插件市场里 {id} 的包实际是 {got}，没有安装', { id: u.id, got: dep.id }))
    done.push(...(await installRequires(dep, { kind: 'github', ref: repo }, seen)))
    await writePackage(dep.id, files, root, { kind: 'github', ref: repo, tag: entry.tag ?? 'HEAD', path: got.path })
    await afterInstall(dep.id)
    log.info('plugin', `装 ${m.id} 时一起装上依赖插件 ${dep.id} ${dep.version}`)
    done.push(dep.id)
  }
  await enableRequires(m)
  return done
}

/**
 * 删除（或关掉）一个被别的插件依赖的插件之前拦下：返回给用户看的原因，没人依赖时为空。
 * 关掉只看开着的依赖方，删除看所有装着的
 */
export function dependentsBlock(id: string, onlyEnabled: boolean, enabled = (x: string) => pluginEnabled(x)) {
  const list = installedList()
    .filter((p) => !onlyEnabled || enabled(p.manifest.id))
    .map((p) => ({ id: p.manifest.id, requires: p.manifest.requires }))
  const deps = dependentsOf(id, list)
  if (!deps.length) return ''
  const names = deps.map((d) => findInstalled(d)?.manifest.name ?? d).join('、')
  return onlyEnabled
    ? t('{names} 依赖这个插件，先关掉它们再关这个', { names })
    : t('{names} 依赖这个插件，先删掉它们再删这个', { names })
}
