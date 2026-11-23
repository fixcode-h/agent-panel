/**
 * 文件索引收哪些目录：排除清单就是项目的「不收录、也不搜索的目录」（searchExclude，AI 初始化分析项目后填的）
 * 加内置默认（shared/search-exclude.ts）再加下面几个永远不收的。
 *
 * 写法：不带斜杠的是目录名，任意一层同名都跳（`Saved`）；带斜杠的按相对根目录的路径通配（`Plugins/*\/Intermediate`，
 * `*` 不跨层、`**` 跨层）。Windows 上不分大小写（NTFS 本来就不分），别处按原样比
 */
import { searchExcludeOf } from '../search-exclude.ts'

/**
 * 永远不收：版本库自己的目录，World Partition 一个 Actor 一个文件的目录（成千上万个哈希名，搜不到有用的东西，
 * UE 插件的跳转索引一直也跳过它们）
 */
export const ALWAYS_SKIP = ['.git', '.svn', '.hg', '__ExternalActors__', '__ExternalObjects__']

export interface SkipRule {
  /** 不带斜杠的目录名 */
  names: Set<string>
  /** 带斜杠的路径通配 */
  paths: RegExp[]
  /** 不分大小写 */
  ci: boolean
}

/** 路径通配 → 正则：`*` 不跨层、`**` 跨层、`?` 一个字 */
export function pathGlob(glob: string, ci: boolean): RegExp {
  let re = ''
  const g = glob.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      // `**/` 可以是零层
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '')
}

/** 编好的规则：项目的排除清单 + 内置默认 + 永远不收的 */
export function skipRule(exclude: string[], ci: boolean): SkipRule {
  const names = new Set<string>()
  const paths: RegExp[] = []
  for (const raw of [...exclude, ...ALWAYS_SKIP]) {
    const item = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (!item) continue
    if (item.includes('/')) paths.push(pathGlob(item, ci))
    else names.add(ci ? item.toLowerCase() : item)
  }
  return { names, paths, ci }
}

/** 项目根用的规则：项目的 searchExclude 加内置默认 */
export function projectSkipRule(project: { searchExclude?: string[] } | undefined, ci: boolean) {
  return skipRule(searchExcludeOf(project), ci)
}

/** 这个子目录跳不跳：name 是这一层的名字，rel 是相对根目录的路径（/ 分隔） */
export function skipDir(rule: SkipRule, name: string, rel: string): boolean {
  if (rule.names.has(rule.ci ? name.toLowerCase() : name)) return true
  for (const re of rule.paths) if (re.test(rel)) return true
  return false
}

/** 规则的指纹：规则变了索引要整份重建（写进落盘文件头） */
export function ruleKey(exclude: string[], extra: string): string {
  return [...new Set(exclude.map((x) => x.trim()).filter(Boolean))].sort().join('|') + `#${extra}`
}
