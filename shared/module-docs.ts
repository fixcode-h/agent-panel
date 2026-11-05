/**
 * 模块文档（ADR 0048）：每个模块一份 `<DOC_ROOT>/modules/<模块>/README.md`，开头几行元数据是唯一来源，
 * `<DOC_ROOT>/MODULE-MAP.md` 里的模块表由它生成（和 bugs/<id>.md → bugs.md 同一个做法），
 * 几个子对话并行写模块文档时各改各的文件，不会都去改同一张表而冲突。
 *
 * 元数据头是标题之后、第一个 `## ` 之前的列表行，形如 `- 状态：documented`。
 * 旧格式的英文字段（status / source_paths / entry / analyzed_at）照读，旧状态值都读成 documented。
 * 这里只放纯逻辑（解析、生成表格、替换地图里的表格），读写文件在 server/module-map.ts 和 scripts/doc-modules.mjs。
 */

/** 模块文档的状态：分析过、有简要文档（documented），或者代码变了不少、文档可能过期（stale） */
export type ModuleDocStatus = 'documented' | 'stale'

export interface ModuleDoc {
  /** 模块名：modules/ 下的目录名 */
  name: string
  /** 标题里冒号后面的部分（「web：React 前端」里的「React 前端」） */
  title: string
  status: ModuleDocStatus
  /** 一句话职责 */
  role: string
  /** 源码路径（相对项目根，原样保留反引号外的写法） */
  sources: string[]
  entry: string[]
  keywords: string[]
  deps: string[]
  /** 最近一次更新：日期 · 提交号，原样保留 */
  updated: string
  /**
   * 最近一次更新这份文档的分支（P4 / SVN 各分支共用一个文档根时写，见 server/doc-group.ts）；
   * 没写时为空串，按当前分支写的处理
   */
  branch: string
}

/** 字段名 → 键：新格式中文、旧格式英文都认 */
const FIELDS: Record<string, keyof ModuleDoc> = {
  状态: 'status',
  status: 'status',
  职责: 'role',
  源码: 'sources',
  source_paths: 'sources',
  入口: 'entry',
  entry: 'entry',
  关键词: 'keywords',
  keywords: 'keywords',
  依赖: 'deps',
  更新: 'updated',
  analyzed_at: 'updated',
  分支: 'branch',
  branch: 'branch',
}

/** 一个字段的值拆成多项：反引号包着的每段算一项，没有反引号时按中文顿号、逗号拆 */
function items(v: string): string[] {
  const quoted = [...v.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
  if (quoted.length) return quoted
  return v
    .split(/[、,，;；]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 旧状态（inferred / analyzed / confirmed / verified）都读成 documented；只有 stale 保留 */
const statusOf = (v: string): ModuleDocStatus => (v.trim().toLowerCase() === 'stale' ? 'stale' : 'documented')

/** 解析一份模块 README；没有标题时返回 null（不是模块文档） */
export function parseModuleDoc(name: string, text: string): ModuleDoc | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const head = lines.findIndex((l) => /^# /.test(l))
  if (head < 0) return null
  const titleLine = lines[head].slice(2).trim()
  const title = titleLine.replace(/^[^：:]+[：:]\s*/, '') || titleLine
  const doc: ModuleDoc = {
    name,
    title,
    status: 'documented',
    role: '',
    sources: [],
    entry: [],
    keywords: [],
    deps: [],
    updated: '',
    branch: '',
  }
  for (const line of lines.slice(head + 1)) {
    if (/^## /.test(line)) break
    const m = /^-\s*([^：:\s]+)\s*[：:]\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = FIELDS[m[1]]
    if (!key) continue
    const v = m[2].trim()
    if (key === 'status') doc.status = statusOf(v)
    else if (key === 'role' || key === 'updated' || key === 'branch') doc[key] = v
    else if (key === 'sources' || key === 'entry' || key === 'keywords' || key === 'deps') doc[key] = items(v)
  }
  return doc
}

/** 表格单元格里的 `|` 要转义，不然列数对不上 */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const code = (xs: string[]) => xs.map((x) => `\`${x}\``).join('、')

/** 地图里生成区的起止标记：生成器只重写这两行之间的内容 */
export const MAP_BEGIN = '<!-- 模块表：由各模块 README 的元数据生成，不要手改 -->'
export const MAP_END = '<!-- /模块表 -->'
/**
 * 认生成区的起始标记只看开头：「文档」照着模板自己写地图时会把标记里的说明换个说法（2026-11-03 真实 API 实测），
 * 按整句比就认不出，地图被当成旧的手写地图、再也不会跟着模块文档更新
 */
const BEGIN_RE = /<!--\s*模块表[^>]*-->/
/** 地图里有没有生成区 */
export const hasGeneratedTable = (mapText: string) => BEGIN_RE.test(mapText) && mapText.includes(MAP_END)

/** 按模块名排序生成模块表（Markdown），文档列是相对 DOC_ROOT 的链接 */
export function renderModuleTable(docs: ModuleDoc[]): string {
  const rows = [...docs]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(
      (d) =>
        `| ${cell(d.name)} | ${cell(code(d.sources))} | ${cell(d.role || d.title)} | ${cell(code(d.entry))} | ${cell(d.keywords.join('、'))} | [modules/${d.name}](modules/${d.name}/README.md) | ${d.status} |`,
    )
  return [
    '| 模块 | 源码 | 职责 | 入口 | 关键词 | 文档 | 状态 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** 旧地图里手写的模块表（表头首列是「模块」、另有一列含「文档」）所在的行号范围；没有返回 null */
function legacyTable(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => {
    const c = l.trim()
    return c.startsWith('|') && /^\|\s*模块\s*\|/.test(c) && c.includes('文档')
  })
  if (start < 0) return null
  let end = start
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end++
  return [start, end]
}

/** 地图正文没有时的骨架：只有标题和生成区 */
const EMPTY_MAP = (table: string) =>
  `# 模块地图\n\n按职责划分的模块。模块表只列已经写了模块文档的模块，第一次用到的模块由「文档」分析后补上。\n\n${MAP_BEGIN}\n\n${table}\n\n${MAP_END}\n`

/**
 * 把模块表写进地图：有生成区标记就只换标记之间的内容；没有标记（旧的手写地图）就把手写的那张模块表换成生成区，
 * 表格外的手写段落（依赖方向、「不容易发现位置的改动」）原样保留；地图为空时建一个骨架
 */
export function withModuleTable(mapText: string, docs: ModuleDoc[]): string {
  const table = renderModuleTable(docs)
  if (!mapText.trim()) return EMPTY_MAP(table)
  const text = mapText.replace(/\r\n/g, '\n')
  const b = BEGIN_RE.exec(text)?.index ?? -1
  const e = text.indexOf(MAP_END)
  if (b >= 0 && e > b) return `${text.slice(0, b)}${MAP_BEGIN}\n\n${table}\n\n${text.slice(e)}`
  const lines = text.split('\n')
  const old = legacyTable(lines)
  if (!old) return `${text.trimEnd()}\n\n${MAP_BEGIN}\n\n${table}\n\n${MAP_END}\n`
  return [...lines.slice(0, old[0]), MAP_BEGIN, '', table, '', MAP_END, ...lines.slice(old[1] + 1)].join('\n')
}

/** 旧的手写模块表里有、模块目录里没有 README 的行：迁移时按表格内容补一个只有元数据头的 README，不丢信息 */
export function legacyRows(mapText: string): { name: string; path: string; role: string; entry: string }[] {
  const lines = mapText.replace(/\r\n/g, '\n').split('\n')
  const old = legacyTable(lines)
  if (!old) return []
  const split = (l: string) =>
    l
      .trim()
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim())
  const header = split(lines[old[0]])
  const col = (want: string[]) => header.findIndex((h) => want.some((w) => h.includes(w)))
  const [name, pathCol, role, entry] = [col(['模块']), col(['路径', '源码']), col(['职责']), col(['入口'])]
  return lines
    .slice(old[0] + 2, old[1] + 1)
    .map(split)
    .filter((c) => c[name])
    .map((c) => ({
      name: c[name].replace(/`/g, ''),
      path: pathCol >= 0 ? c[pathCol] : '',
      role: role >= 0 ? c[role] : '',
      entry: entry >= 0 ? c[entry] : '',
    }))
}

/**
 * 把一份旧格式的 README 头改写成新格式（中文字段）：原来的英文字段换掉，缺的「职责」从旧地图那一行补上；
 * 正文不动。已经是新格式的原样返回
 */
export function migrateModuleHead(text: string, role: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const head = lines.findIndex((l) => /^# /.test(l))
  if (head < 0) return text
  let end = lines.findIndex((l, i) => i > head && /^## /.test(l))
  if (end < 0) end = lines.length
  const block = lines.slice(head + 1, end)
  const fieldAt = (re: RegExp) => block.findIndex((l) => re.test(l.trim()))
  if (fieldAt(/^-\s*状态\s*[：:]/) >= 0) return text
  const doc = parseModuleDoc('x', text)
  if (!doc) return text
  const raw = (re: RegExp) => {
    const i = fieldAt(re)
    return i >= 0 ? block[i].trim().replace(/^-\s*[^：:]+[：:]\s*/, '') : ''
  }
  const fields = [
    `- 状态：${doc.status}`,
    `- 职责：${role.replace(/`/g, '') || doc.title}`,
    `- 源码：${raw(/^-\s*source_paths\s*[：:]/)}`,
    `- 入口：${raw(/^-\s*entry\s*[：:]/)}`,
    ...(doc.updated ? [`- 更新：${doc.updated}`] : []),
  ]
  // 旧字段以外的行（说明、空行）原样留着
  const rest = block.filter((l) => !/^-\s*(status|source_paths|entry|analyzed_at)\s*[：:]/.test(l.trim()))
  const lead = rest.findIndex((l) => l.trim())
  const tail = lead < 0 ? [] : rest.slice(lead)
  return [...lines.slice(0, head + 1), '', ...fields, '', ...tail, ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 给模块 README 的元数据头补上「分支」一行（老项目迁移到共用文档根时用）：已经写了分支的原样返回，
 * 没有元数据头（不是模块文档）的也原样返回。补在「更新」前面，没有「更新」就补在元数据头最后
 */
export function withModuleBranch(text: string, branch: string): string {
  if (!branch) return text
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const head = lines.findIndex((l) => /^# /.test(l))
  if (head < 0) return text
  let end = lines.findIndex((l, i) => i > head && /^## /.test(l))
  if (end < 0) end = lines.length
  const isField = (l: string, re: RegExp) => re.test(l.trim())
  const block = lines.slice(head + 1, end)
  if (block.some((l) => isField(l, /^-\s*(分支|branch)\s*[：:]/))) return text
  const fields = block.map((l, i) => (/^-\s*[^：:\s]+\s*[：:]/.test(l.trim()) ? i : -1)).filter((i) => i >= 0)
  if (!fields.length) return text
  const updated = block.findIndex((l) => isField(l, /^-\s*(更新|analyzed_at)\s*[：:]/))
  const at = head + 1 + (updated >= 0 ? updated : fields[fields.length - 1] + 1)
  lines.splice(at, 0, `- 分支：${branch}`)
  return lines.join(nl)
}
