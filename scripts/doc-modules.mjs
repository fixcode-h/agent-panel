// 按 docs/modules/<模块>/README.md 的元数据重新生成 docs/MODULE-MAP.md 的模块表（ADR 0048）。
// 默认改写地图；`--check` 只判定（给 npm run lint 用），地图里的表和模块文档对不上就退出码 1；
// `--migrate`：一次性把旧格式（status / source_paths / entry / analyzed_at）的头改成新格式，职责从旧地图那一行补上。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docRoot = path.join(root, 'docs')
const md = await tsImport('../shared/module-docs.ts', import.meta.url)
const mapFile = path.join(docRoot, 'MODULE-MAP.md')
const mapText = existsSync(mapFile) ? readFileSync(mapFile, 'utf8') : ''

if (process.argv.includes('--migrate')) {
  const roles = new Map(md.legacyRows(mapText).map((r) => [r.name, r.role]))
  for (const d of readdirSync(path.join(docRoot, 'modules'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const f = path.join(docRoot, 'modules', d.name, 'README.md')
    if (!existsSync(f)) continue
    const before = readFileSync(f, 'utf8')
    const after = md.migrateModuleHead(before, roles.get(d.name) ?? '')
    if (after !== before) {
      writeFileSync(f, after)
      console.log(`改写了 ${path.relative(root, f)} 的元数据头`)
    }
  }
}

const docs = []
const modulesDir = path.join(docRoot, 'modules')
if (existsSync(modulesDir))
  for (const d of readdirSync(modulesDir, { withFileTypes: true })) {
    const f = path.join(modulesDir, d.name, 'README.md')
    if (!d.isDirectory() || !existsSync(f)) continue
    const doc = md.parseModuleDoc(d.name, readFileSync(f, 'utf8'))
    if (doc) docs.push(doc)
  }
// 本仓库的 Markdown 过 Prettier（表格会被对齐）：生成后按同一份配置格式化，--check 和 npm run lint 才比得上
const prettier = await import('prettier')
const options = (await prettier.resolveConfig(mapFile, { config: path.join(root, 'config/.prettierrc.json') })) ?? {}
const next = await prettier.format(md.withModuleTable(mapText, docs), { ...options, filepath: mapFile })
const same = next === mapText.replace(/\r\n/g, '\n')
if (process.argv.includes('--check')) {
  if (!same) {
    console.error(
      'docs/MODULE-MAP.md 的模块表和各模块 README 的元数据对不上：改模块 README 的元数据头，再跑 npm run docs:modules 重新生成，不要手改表格',
    )
    process.exitCode = 1
  } else console.log('模块表和模块文档一致')
} else if (same) console.log('模块表已是最新，没有改写')
else {
  writeFileSync(mapFile, next)
  console.log(`已重新生成 docs/MODULE-MAP.md 的模块表（${docs.length} 个模块）`)
}
