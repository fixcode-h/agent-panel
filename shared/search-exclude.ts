/**
 * 搜索排除目录：Agent 在项目里找文件时该跳过哪些目录。
 *
 * 项目大了以后全仓 grep 会跑几分钟、命中一堆编译产物，所以把「不要在这些目录里搜」
 * 变成项目设置里的固定配置：项目自己的清单 + 内置的通用默认清单合并成实际生效的一份，
 * 提示词里带上一行，Agent 不用每次靠临场叮嘱。
 */
/**
 * 内置的通用默认清单：几乎每个项目都该跳过的依赖、产物和缓存。
 * 项目值只会在它前面追加，不会顶掉这些（这里漏一个就可能扫到几万行生成代码）
 */
export const DEFAULT_SEARCH_EXCLUDE = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.venv',
  'venv',
  'coverage',
  'logs',
]

/** UE 项目的一键预设：编译产物、缓存和 IDE 目录，Content 里的资产另按名字找 */
export const UE_SEARCH_EXCLUDE = ['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'Build', '.vs']

/**
 * 规范化一项：去首尾空白和尾部的斜杠（`Saved/` 和 `Saved` 是同一个目录），
 * 空项和只有斜杠的项丢掉
 */
function normalize(item: string): string {
  return item.trim().replace(/[\\/]+$/, '')
}

/**
 * 项目实际生效的排除清单：项目的值在前（用户能一眼看到自己填的），再补内置默认，去重。
 * 去重按原样比大小写：`Build`（UE 的平台产物）和 `build`（前端产物）在 Linux 上是两个目录，
 * 合并成一个会漏掉其中一个——多列一项同义项没有坏处，少一项就会扫到产物
 */
export function searchExcludeOf(project: { searchExclude?: string[] } | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...(project?.searchExclude ?? []), ...DEFAULT_SEARCH_EXCLUDE]) {
    const item = normalize(raw)
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * 提示词里的一行：`搜索时排除：Saved, Intermediate, …`。
 * 用逗号分隔而不是反引号列表：一行能塞下、Agent 也方便照着拼 `-g '!Saved'`
 */
export function searchExcludePrompt(project: { searchExclude?: string[] } | undefined): string {
  const list = searchExcludeOf(project)
  return list.length ? `搜索时排除：${list.join(', ')}` : ''
}

/**
 * 提示词里能直接照抄的 rg 例子（同样按实际生效的清单生成）：
 * `-g '!Saved' -g '!Intermediate'` 这样抄过去就跳过产物目录（rg 对被排除的目录不再进去）
 */
export function searchExcludeGlobs(project: { searchExclude?: string[] } | undefined): string {
  return searchExcludeOf(project)
    .map((d) => `-g '!${d}'`)
    .join(' ')
}
