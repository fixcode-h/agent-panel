/**
 * `docs/modules/<模块>/bugs.md` 的索引由 `bugs/<bug-id>.md` 的元数据生成，不再手工维护。
 * 多个子对话同时收尾时各自新增一个详情文件即可，不用都往同一张表末尾追加一行（那样必冲突）。
 * 解析、生成和判定都放在这里，`scripts/doc-bugs.mjs` 负责读写文件，`scripts/rules-check.mjs` 用 `--check` 判定。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 详情文件元数据头的字段名 → 解析结果的键；顺序也是索引表的列顺序 */
const FIELDS = [
  ['症状', 'symptom'],
  ['关键词', 'keywords'],
  ['入口', 'entry'],
  ['根因类型', 'rootType'],
  ['状态', 'status'],
]

/** 缺了就没法检索的字段（症状可以回落到标题，不在此列） */
const REQUIRED = ['keywords', 'entry', 'rootType', 'status']

const LABEL = Object.fromEntries(FIELDS.map(([label, key]) => [key, label]))

/** 索引表的列：表头 → 取值 */
const COLUMNS = [
  ['ID', (bug) => bug.id],
  ['症状', (bug) => bug.symptom],
  ['关键词', (bug) => bug.keywords],
  ['入口', (bug) => bug.entry],
  ['根因类型', (bug) => bug.rootType],
  ['状态', (bug) => bug.status],
  ['文档', (bug) => `[详情](bugs/${bug.id}.md)`],
]

const metaRe = new RegExp(`^- (${FIELDS.map(([label]) => label).join('|')})：(.*)$`)

/**
 * 解析一份详情文件：`# 标题` 之后到第一个 `## ` 之前是元数据头。
 * 正文里出现的 `- 状态：…` 只是举例，不算元数据。
 */
export function parseBugDoc(text, id) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const title = /^#\s+(.+?)\s*$/.exec(lines.find((l) => l.startsWith('# ')) ?? '')?.[1] ?? ''
  const bug = { id, title, status: '', symptom: '', entry: '', rootType: '', keywords: '', problems: [] }
  for (const line of lines) {
    if (/^##\s/.test(line)) break
    const m = metaRe.exec(line)
    if (!m) continue
    bug[FIELDS.find(([label]) => label === m[1])[1]] = m[2].trim()
  }
  // 症状没写时用标题顶上：标题本来就该说清表现，新 Bug 可以少写一行
  if (!bug.symptom) bug.symptom = title
  // 症状之外都缺不了，缺了索引那一列就是空的，检索不到
  for (const key of REQUIRED) if (!bug[key]) bug.problems.push(`缺「- ${LABEL[key]}：」`)
  if (!title) bug.problems.push('缺「# 标题」')
  return bug
}

/** 显示宽度：中日韩文字和全角符号在等宽字体里占两列，表格对齐要按它算 */
const width = (s) =>
  [...s].reduce(
    (n, c) =>
      n +
      (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1),
    0,
  )
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)))

/** 表格单元格：竖线和换行都会破表，换行统一压成空格 */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()

/**
 * 按 ID 字母序排：顺序不依赖 readdir 返回序，并行新增的行也落在不同位置而不是都挤在末尾。
 * 排序放在生成函数里，调用方不用记得排。
 */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 生成索引表（不含标题和说明）；没有条目时返回空串 */
export function bugTable(bugs) {
  if (!bugs.length) return ''
  const rows = [...bugs].sort(byId).map((bug) => COLUMNS.map(([, get]) => cell(get(bug))))
  const heads = COLUMNS.map(([name]) => name)
  // 列宽取表头和所有单元格的最大显示宽度，至少 3 个字符（跟 prettier 对表格的处理一致）
  const widths = heads.map((h, i) => Math.max(3, width(h), ...rows.map((r) => width(r[i]))))
  const line = (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(' | ')} |`
  return [line(heads), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n')
}

/** 完整的 `bugs.md` 内容：标题 + 生成说明 + 表格 */
export function bugIndexFile(module, bugs) {
  const table = bugTable(bugs)
  return [
    `# ${module} · Bug 索引`,
    '',
    '<!-- 由 node scripts/doc-bugs.mjs 按本目录 bugs/<bug-id>.md 生成，不要手工编辑；改完详情文件跑一次脚本即可 -->',
    '',
    table,
    '',
  ].join('\n')
}

/**
 * 判定单个模块的索引。`docs` 是 `[{ id, text }]`，`indexText` 是现有 bugs.md 的内容（不存在给 null）。
 * 返回错误文案，空数组表示一致。
 */
export function checkBugIndex({ module, docs, indexText }) {
  const errors = []
  const bugs = docs.map((d) => parseBugDoc(d.text, d.id))
  const file = `docs/modules/${module}/bugs.md`
  const fix = `改完详情文件跑 node scripts/doc-bugs.mjs 重新生成 ${file}`
  for (const bug of bugs) {
    const doc = `docs/modules/${module}/bugs/${bug.id}.md`
    for (const problem of bug.problems) errors.push(`${doc} ${problem}：索引的这一列取不到值`)
  }
  if (!indexText) {
    // 有详情文件就必须有索引；没有 bugs/ 目录的模块根本不会走到这里
    errors.push(`${file} 不存在：${fix}`)
    return errors
  }
  const expected = bugIndexFile(module, bugs)
  const actual = indexText.replace(/\r\n/g, '\n')
  if (expected === actual) return errors
  // 报出到底哪几条对不上：只看「有几行不一致」没法判断是漏了一条还是某列写错了
  const rowOf = (text, id) => text.split('\n').find((l) => l.startsWith(`| ${id} `)) ?? null
  const ids = bugs.map((bug) => bug.id)
  const indexIds = actual
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|')[1]?.trim() ?? '')
    .filter((id) => id && id !== 'ID' && !/^-+$/.test(id))
  const missing = ids.filter((id) => !indexIds.includes(id))
  const extra = indexIds.filter((id) => !ids.includes(id))
  const differ = ids.filter((id) => {
    const row = rowOf(actual, id)
    return row !== null && row.trim() !== rowOf(expected, id)?.trim()
  })
  const detail = [
    missing.length ? `缺 ${missing.join('、')}` : '',
    extra.length ? `多出 ${extra.join('、')}` : '',
    differ.length ? `内容不一致 ${differ.join('、')}` : '',
  ].filter(Boolean)
  errors.push(`${file} 和 bugs/ 下的详情文件对不上（${detail.join('；')}）：不要手工编辑索引，${fix}`)
  return errors
}

/** 列出 docs/modules 下有 bugs/ 目录的模块 */
const modulesWithBugs = (root) => {
  const modulesDir = path.join(root, 'docs/modules')
  if (!existsSync(modulesDir)) return []
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(modulesDir, d.name, 'bugs')))
    .map((d) => d.name)
    .sort()
}

/** 读一个模块的详情文件，`id` 取文件名（不含 .md） */
const readModuleDocs = (root, module) => {
  const dir = path.join(root, 'docs/modules', module, 'bugs')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ id: f.slice(0, -'.md'.length), text: readFileSync(path.join(dir, f), 'utf8') }))
}

/** 在项目根上判定所有模块的索引；没有 bugs/ 目录、或目录里还没有详情文件时返回空（不建空文件） */
export function checkBugIndexesInRoot(root) {
  const errors = []
  for (const module of modulesWithBugs(root)) {
    const docs = readModuleDocs(root, module)
    // 空目录不算错：项目规定没有内容依据不建空文件，生成器也不会为它建 bugs.md
    if (!docs.length) continue
    const file = path.join(root, 'docs/modules', module, 'bugs.md')
    errors.push(
      ...checkBugIndex({
        module,
        docs,
        indexText: existsSync(file) ? readFileSync(file, 'utf8') : null,
      }),
    )
  }
  return errors
}

/** 在项目根上重新生成所有不为空的索引，返回真正写了内容的模块名 */
export function syncBugIndexesInRoot(root) {
  const written = []
  for (const module of modulesWithBugs(root)) {
    const docs = readModuleDocs(root, module)
    if (!docs.length) continue
    const file = path.join(root, 'docs/modules', module, 'bugs.md')
    const text = bugIndexFile(
      module,
      docs.map((d) => parseBugDoc(d.text, d.id)),
    )
    if (existsSync(file) && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text) continue
    writeFileSync(file, text, 'utf8')
    written.push(module)
  }
  return written
}
