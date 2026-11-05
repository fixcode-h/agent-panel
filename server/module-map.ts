/**
 * 模块地图的读写（ADR 0048）：扫 `<DOC_ROOT>/modules/<模块>/README.md` 的元数据头，重写 `<DOC_ROOT>/MODULE-MAP.md` 里的模块表。
 * 纯逻辑在 shared/module-docs.ts；这里只管文件。用户的项目不需要自带生成脚本：「文档」写完模块文档后由面板调它。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Agent } from '../shared/schema.ts'
import { projectDocRoot } from './doc-root.ts'
import { parseModuleDoc, withModuleTable, type ModuleDoc } from '../shared/module-docs.ts'

/**
 * 项目的文档根：P4 / SVN 项目按「文档」角色的设置算（可能在项目外）；Git 和没有版本管理的项目 projectDocRoot 不给，
 * 按 project-documentation 的路径模型取：已有 docs/ 或 doc/ 就用它，没有就是 docs/
 */
export async function docRootOf(projectPath: string, agents: Agent[]) {
  return (await docInfoOf(projectPath, agents)).root
}

/**
 * 文档根和当前分支：P4 / SVN 各分支共用文档根时才有分支（server/doc-group.ts），
 * 模块文档上写的分支和它不同，就是别的分支写的
 */
export async function docInfoOf(
  projectPath: string,
  agents: Agent[],
): Promise<{ root: string; branch?: string; conflicts?: string[] }> {
  const doc = await projectDocRoot(projectPath, agents).catch(() => undefined)
  if (doc) return { root: doc.root, branch: doc.branch, conflicts: doc.conflicts }
  const have = ['docs', 'doc', 'Docs'].find((d) => existsSync(path.join(projectPath, d)))
  return { root: path.join(projectPath, have ?? 'docs') }
}

/** 模块文档是别的分支写的：没写分支的老文档按当前分支写的算 */
const otherBranch = (d: ModuleDoc, branch: string | undefined) => !!branch && !!d.branch && d.branch !== branch

/** 文档根下所有模块文档（按目录名），读不出元数据的跳过 */
export async function readModuleDocs(docRoot: string): Promise<ModuleDoc[]> {
  const dir = path.join(docRoot, 'modules')
  if (!existsSync(dir)) return []
  const out: ModuleDoc[] = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const file = path.join(dir, d.name, 'README.md')
    const text = await readFile(file, 'utf8').catch(() => '')
    const doc = text && parseModuleDoc(d.name, text)
    if (doc) out.push(doc)
  }
  return out
}

/**
 * 按模块文档重新生成地图里的模块表。没有 modules/ 目录、也没有地图时什么都不做；
 * 返回 changed 表示改写了文件（内容一样就不写，重复调用不产生改动）
 */
export async function syncModuleMap(docRoot: string): Promise<{ changed: boolean; file: string; modules: number }> {
  const file = path.join(docRoot, 'MODULE-MAP.md')
  const docs = await readModuleDocs(docRoot)
  const before = await readFile(file, 'utf8').catch(() => '')
  if (!docs.length && !before) return { changed: false, file, modules: 0 }
  const next = withModuleTable(before, docs)
  if (next === before.replace(/\r\n/g, '\n')) return { changed: false, file, modules: docs.length }
  await writeFile(file, next, 'utf8')
  return { changed: true, file, modules: docs.length }
}

/**
 * 协调器建子对话前查模块文档（shared/docs-first.ts）：每个模块看 `<DOC_ROOT>/modules/<模块>/README.md` 在不在。
 * 只做文件检查，不建索引、不搜代码（用户 2026-11-03 定）；路径写成相对项目根的样子，子对话照着读
 */
export async function lookupModuleDocs(projectPath: string, agents: Agent[], modules: string[]) {
  const root = await docRootOf(projectPath, agents)
  const found: Record<string, string> = {}
  const missing: string[] = []
  for (const m of modules) {
    const file = path.join(root, 'modules', m, 'README.md')
    if (existsSync(file)) found[m] = path.relative(projectPath, file).split(path.sep).join('/') || file
    else missing.push(m)
  }
  return { root, found, missing }
}

/**
 * 子对话合回后查一遍：模块文档里写的「源码」路径是不是全都不在了（模块被删、移走或并进别的模块）。
 * 面板只负责发现，删目录还是改路径由「文档」判断（task=清理）；返回给父对话的一段说明，没有就是空串
 */
export async function goneModulesNote(projectPath: string, agents: Agent[]) {
  const { root, branch } = await docInfoOf(projectPath, agents)
  // 别的分支写的模块文档：本分支没有这些源码不代表模块删了（可能只在那个分支上有），不让「文档」去删（ADR 0052）
  const gone = (await readModuleDocs(root)).filter(
    (d) =>
      !otherBranch(d, branch) && d.sources.length && d.sources.every((src) => !existsSync(path.join(projectPath, src))),
  )
  if (!gone.length) return ''
  return `模块文档对不上了：${gone.map((d) => `「${d.name}」（源码 ${d.sources.join('、')}）`).join('、')}的源码已经不在了。用 spawn_agents 派「文档」，params 写 {"task": "清理"}，instructions 写这几个模块和这次合回的改动：真删了就删模块文档目录，移走、改名的改路径。`
}

/**
 * 协调器每轮看到的「已有模块文档」（ADR 0048）：从各模块 README 的元数据现读，一个模块一行。
 * 用户的项目里面板不改写 MODULE-MAP.md：父对话目录里留下没人提交的改动会挡住子对话合回，几个子对话各自重新生成同一张表还会互相冲突。
 * 模块 README 是唯一来源，这一段只是它的索引；没有模块文档时说清楚，协调器就按目录判断
 */
export async function moduleIndexText(projectPath: string, agents: Agent[]) {
  const { root, branch, conflicts } = await docInfoOf(projectPath, agents)
  const docs = (await readModuleDocs(root)).sort((a, b) => (a.name < b.name ? -1 : 1))
  const rel = (f: string) => path.relative(projectPath, f).split(path.sep).join('/') || f
  const merge = mergeNote(conflicts)
  if (!docs.length)
    return `## 已有模块文档\n文档根 \`${rel(root)}\` 下还没有模块文档：定位时看一、二级目录判断模块，开子对话前面板会让「文档」先把要用的模块分析好。${merge}`
  const shown = docs.slice(0, 80)
  // 别的分支写的：标出来源分支，本分支没有它的源码时也说一声，协调器照常引用、不重新分析
  const from = (d: ModuleDoc) => {
    if (!otherBranch(d, branch)) return ''
    const missing = d.sources.length > 0 && d.sources.every((src) => !existsSync(path.join(projectPath, src)))
    return `（来自 ${d.branch} 分支${missing ? '，本分支没有这些源码' : ''}）`
  }
  return `## 已有模块文档（模块名｜职责｜源码｜关键词）\n按关键词、职责对上模块后读 \`${rel(root)}/modules/<模块>/README.md\`；这里没有的模块还没写文档。${
    branch
      ? `各分支共用这些文档，当前分支是「${branch}」；标了来自别的分支的照常引用，用到的部分以本分支代码为准。`
      : ''
  }\n${shown
    .map(
      (d) =>
        `- ${d.name}｜${d.role || d.title}｜${d.sources.join('、')}｜${d.keywords.slice(0, 12).join('、')}${d.status === 'stale' ? '（文档可能过期）' : ''}${from(d)}`,
    )
    .join(
      '\n',
    )}${docs.length > shown.length ? `\n（另有 ${docs.length - shown.length} 个模块没列出，看 modules/ 目录）` : ''}${merge}`
}

/**
 * 合并各分支旧文档时另存的冲突文件：让协调器派「文档」合并（task=合并），合完删掉 .from- 文件就不再提
 */
function mergeNote(conflicts: string[] | undefined) {
  if (!conflicts?.length) return ''
  const list = conflicts
    .slice(0, 20)
    .map((f) => `\`${f}\``)
    .join('、')
  return `\n\n各分支的旧文档合到共用文档根时有 ${conflicts.length} 个文件内容不同，另存成了 .from-<分支>：${list}${conflicts.length > 20 ? ' 等' : ''}。空闲时用 spawn_agents 派「文档」，params 写 {"task": "合并"}，instructions 贴上这份清单：按本分支代码把每对文件合成一份，合完删掉 .from- 文件。`
}
