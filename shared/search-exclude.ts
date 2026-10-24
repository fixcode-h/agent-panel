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
 * 提示词里能直接照抄的 rg 排除参数（同样按实际生效的清单生成）：`-g '!Saved/' -g '!Intermediate/'`。
 * 末尾带斜杠只排除目录（rg 的 glob 按 .gitignore 语义）：不带斜杠时连叫 `build` 的脚本文件也一起排掉。
 * 名字不带路径，所以 `Plugins/X/Intermediate` 这种任意深度的同名目录也会跳过；
 * 显式把被排除的目录当搜索起点（`rg 关键字 Saved/Logs`）时仍然会搜，看日志不受影响。
 *
 * onlyProject：Git 仓库里 rg / git grep 本来就跳过 .gitignore 里的产物，内置默认清单再列一遍只是噪声，
 * 还会误伤真叫 build / out / logs 的源码目录（比如 Java 包 `com/x/build/`）。这时只给项目自己填的那几项
 */
export function searchExcludeGlobs(
  project: { searchExclude?: string[] } | undefined,
  opts: { onlyProject?: boolean } = {},
): string {
  const list = searchExcludeOf(project)
  return (opts.onlyProject ? list.filter((d) => !DEFAULT_SEARCH_EXCLUDE.includes(d)) : list)
    .map((d) => `-g '!${d}/'`)
    .join(' ')
}

/**
 * ripgrep 配置文件的内容（每行一个参数）：面板用 RIPGREP_CONFIG_PATH 交给 CLI，
 * Agent 自己跑的 rg 和 CLI 内置的搜索（底下也是 rg）不靠提示词也会跳过这些目录。
 * 和 searchExcludeGlobs 同样只排除目录、显式把排除目录当起点时照样能搜；Git 仓库里只给项目自己填的
 */
export function searchExcludeRgConfig(
  project: { searchExclude?: string[] } | undefined,
  opts: { onlyProject?: boolean } = {},
): string[] {
  const list = searchExcludeOf(project)
  return (opts.onlyProject ? list.filter((d) => !DEFAULT_SEARCH_EXCLUDE.includes(d)) : list).map((d) => `--glob=!${d}/`)
}

/**
 * find 的剪枝表达式：`\( -type d \( -name A -o -name B \) \) -prune -o`，拼在起点目录和条件之间。
 * find 不读 .gitignore，Git 仓库里也要用完整清单；只剪目录，不会把同名文件一起吞掉
 */
export function searchExcludeFindPrune(project: { searchExclude?: string[] } | undefined): string {
  const names = searchExcludeOf(project).map((d) => `-name '${d}'`)
  return names.length ? `\\( -type d \\( ${names.join(' -o ')} \\) \\) -prune -o` : ''
}
