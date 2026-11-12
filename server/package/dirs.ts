import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { npmName, type CliPackages, type InstalledPackage } from '../../shared/cli-spec.ts'
import { changelogPath, parseChangelog, type ChangelogEntry } from '../../shared/package-changelog.ts'
import { expandHome } from '../cli/extras.ts'

/**
 * 已装的包在本机哪个目录（ADR 0050）：npm 来源在 npmRoot/<包名>，git 来源在 gitRoot/<主机>/<路径>，
 * 本机目录就是它自己（target 已经换成绝对路径）。认不出的返回空串
 */
export function packageDir(spec: Pick<CliPackages, 'npmRoot' | 'gitRoot'>, p: InstalledPackage): string {
  const name = npmName(p.source)
  if (name) return spec.npmRoot ? path.join(expandHome(spec.npmRoot), name) : ''
  const git = /^(?:git:|https?:\/\/)([^/@\s]+)\/(.+?)(?:\.git)?(?:@[^/@]*)?\/?$/i.exec(p.source.trim())
  if (git) return spec.gitRoot ? path.join(expandHome(spec.gitRoot), git[1], git[2]) : ''
  return path.isAbsolute(p.target) ? p.target : ''
}

/** 包的 package.json，读不到是 undefined */
export async function readManifest(dir: string): Promise<Record<string, any> | undefined> {
  if (!dir) return undefined
  return readFile(path.join(dir, 'package.json'), 'utf8')
    .then((t) => JSON.parse(t) as Record<string, any>)
    .catch(() => undefined)
}

/**
 * 包的更新说明：按定义里的 changelog 找文件（包可以自己指定，写空串是不提供），只认包目录里面的文件。
 * 返回 null 表示这个包没有更新说明
 */
export async function packageChangelog(spec: CliPackages, p: InstalledPackage): Promise<ChangelogEntry[] | null> {
  const dir = packageDir(spec, p)
  if (!spec.changelog || !dir) return null
  const rel = changelogPath(spec.changelog, await readManifest(dir))
  if (!rel) return null
  const file = path.resolve(dir, rel)
  if (file !== dir && !file.startsWith(dir + path.sep)) return null
  const text = await readFile(file, 'utf8').catch(() => '')
  const entries = parseChangelog(text)
  return entries.length ? entries : null
}
