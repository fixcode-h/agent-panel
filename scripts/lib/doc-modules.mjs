/**
 * 模块文档和 `docs/MODULE-MAP.md` 的模块表必须双向对得上：
 * 表里每一行都要有对应的 `docs/modules/<模块>/README.md`，`docs/modules/` 下也不能留表里没有的目录
 * （模块在代码里删掉了，文档目录要一起删、表格行要一起删）。
 * 解析和判定放在这里，`scripts/rules-check.mjs` 只负责取文件，测试直接调这些函数。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 表格行的单元格；不是表格行返回 null */
const cellsOf = (line) =>
  line.trim().startsWith('|')
    ? line
        .trim()
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
    : null

/** 取 MODULE-MAP 里的模块表（表头含「模块」和「文档」的那张表），返回 { name, doc } */
export function moduleRows(text) {
  const rows = []
  let header = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const cells = cellsOf(line)
    if (!cells) {
      // 模块表之后的表格（「不容易发现位置的改动」）不算模块行
      if (header) break
      continue
    }
    if (!header) {
      // 表头首列是「模块」、另有一列含「文档」就算模块表；列名可能写成「关联文档」
      if (cells[0].startsWith('模块') && cells.some((c) => c.includes('文档'))) header = cells
      continue
    }
    // 列数不一样的是另一张表：地图里模块表后面可能紧跟别的表
    if (cells.length !== header.length) break
    const docIndex = header.findIndex((c) => c.includes('文档'))
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    rows.push({ name: cells[0].replace(/`/g, '').trim(), doc: cells[docIndex] ?? '' })
  }
  return rows
}

/** 表格行的文档列 → 相对 DOC_ROOT 的路径；写成链接或裸路径都认 */
export function moduleDocPath(row) {
  const link = /\]\(([^)\s]+)\)/.exec(row.doc)?.[1] ?? row.doc
  const hit = /modules\/([^/)\s]+)\/README\.md/.exec(link)
  return hit ? `modules/${hit[1]}/README.md` : null
}

/**
 * 双向检查。`mapText` 是 MODULE-MAP.md 的内容，`dirs` 是 docs/modules 下的目录名，
 * `exists` 判断相对 DOC_ROOT 的路径在不在。返回错误文案，空数组表示对得上。
 */
export function checkModuleDocs({ mapText, dirs, exists }) {
  const errors = []
  const rows = moduleRows(mapText)
  // 有地图却解析不出模块行：把表头修对，不然两个方向都查不出东西
  if (!rows.length) {
    errors.push(
      'docs/MODULE-MAP.md 里没找到模块表（地图没解析出模块行）：表头要含「模块」和「文档」两列（列名见 skills/docs/project-documentation/templates.md）',
    )
    return errors
  }
  const names = new Set()
  for (const row of rows) {
    const doc = moduleDocPath(row)
    const name = doc ? /^modules\/([^/]+)\/README\.md$/.exec(doc)?.[1] : null
    if (!doc || !name) {
      errors.push(
        `docs/MODULE-MAP.md 模块表里「${row.name}」的文档列没有指向 modules/<模块>/README.md：补上该模块的文档链接`,
      )
      continue
    }
    names.add(name)
    if (!exists(doc)) errors.push(`docs/MODULE-MAP.md 列出了模块「${row.name}」，但 docs/${doc} 不存在`)
  }
  for (const dir of dirs) {
    if (!names.has(dir))
      errors.push(
        `docs/modules/${dir}/ 不在 docs/MODULE-MAP.md 的模块表里：模块已经删了就连目录一起删掉，新增模块就补一行；也检查模块表单元格里有没有未转义的 \`|\`、列数是否一致`,
      )
  }
  return errors
}

/** 在项目根上真跑一遍：读 docs/MODULE-MAP.md、列 docs/modules、拼路径判存在；没建文档树时返回空 */
export function checkModuleDocsInRoot(root) {
  const mapFile = path.join(root, 'docs/MODULE-MAP.md')
  if (!existsSync(mapFile)) return []
  const modulesDir = path.join(root, 'docs/modules')
  const dirs = existsSync(modulesDir)
    ? readdirSync(modulesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []
  return checkModuleDocs({
    mapText: readFileSync(mapFile, 'utf8'),
    dirs,
    exists: (rel) => existsSync(path.join(root, 'docs', rel)),
  })
}
