/**
 * 模块地图的读写（ADR 0048）：扫 `<DOC_ROOT>/modules/<模块>/README.md` 的元数据头，重写 `<DOC_ROOT>/MODULE-MAP.md` 里的模块表。
 * 纯逻辑在 shared/module-docs.ts；这里只管文件。用户的项目不需要自带生成脚本：「文档」写完模块文档后由面板调它。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Agent } from '../shared/schema.ts'
import { projectDocRoot } from './doc-root.ts'
import { MAP_BEGIN, parseModuleDoc, withModuleTable, type ModuleDoc } from '../shared/module-docs.ts'

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
 * 每轮结束时调（server/tasks/run.ts）：模块文档改了就把地图跟上。只管「已经是生成格式」的地图，
 * 旧的手写地图（没有生成区标记）不自动改：那会在用户的项目里冒出一大段没人要的改动，迁移交给「文档」或 npm run docs:modules。
 * 没有地图、但已经有模块文档时建一个
 */
export async function syncManagedModuleMap(docRoot: string) {
  const before = await readFile(path.join(docRoot, 'MODULE-MAP.md'), 'utf8').catch(() => '')
  if (before && !before.includes(MAP_BEGIN)) return { changed: false, skipped: 'legacy' as const }
  return syncModuleMap(docRoot)
}

/**
 * 协调器建子对话前查模块文档（shared/docs-first.ts）：每个模块看 `<DOC_ROOT>/modules/<模块>/README.md` 在不在。
 * 只做文件检查，不建索引、不搜代码（用户 2026-11-03 定）；路径写成相对项目根的样子，子对话照着读
 */
export async function lookupModuleDocs(projectPath: string, agents: Agent[], modules: string[]) {
  const doc = await projectDocRoot(projectPath, agents)
  const root = doc?.root ?? path.join(projectPath, 'docs')
  const found: Record<string, string> = {}
  const missing: string[] = []
  for (const m of modules) {
    const file = path.join(root, 'modules', m, 'README.md')
    if (existsSync(file)) found[m] = path.relative(projectPath, file).split(path.sep).join('/') || file
    else missing.push(m)
  }
  return { root, found, missing }
}
