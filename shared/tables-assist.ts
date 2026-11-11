/**
 * AI 分析表格风格：给 CLI 一份挑出来的几张表的清单，它一张一张用 table.sample 读表头和前几行，
 * 让它总结出表头规则、主键、列表分隔符、基础类型、例外文件、枚举和列的引用 / 范围，输出一个 JSON。
 * 页面上逐项勾选后才写进项目的表格结构文件；表格文件本身不动。
 */
import { z } from 'zod'
import { promptLangWord } from './prompt-lang.ts'
import type { AssistMessage } from './assist.ts'
import { SHEET_ROLES } from './sheet-header.ts'
import { TableColumn, TableEnum, type TableSchema } from './tables.ts'

const Header = z.object({
  start: z.number().int().min(0).max(1000),
  roles: z.array(z.enum(SHEET_ROLES)).max(20),
  labels: z.array(z.string().trim().max(20)).max(20).optional(),
})
type Header = z.infer<typeof Header>

/** CLI 输出的 JSON；每一部分都可以没有 */
export const TablesDraft = z.object({
  summary: z.string().max(4000).default(''),
  style: z
    .object({
      /** 旧格式：只有一套表头。解析时并进 headers */
      header: Header.optional(),
      /** 几套表头：各表表头行数不一样时有多套，最常见的排第一 */
      headers: z.array(Header).max(20).optional(),
      key: z.string().max(100).optional(),
      listSep: z.string().min(1).max(4).optional(),
      primitives: z.array(z.string().max(40)).max(80).optional(),
      arrayMarks: z.array(z.string().trim().max(40)).max(20).optional(),
      roleEnums: z.partialRecord(z.enum(SHEET_ROLES), z.string().max(200)).optional(),
      exceptions: z
        .array(z.object({ glob: z.string().max(300), header: Header, why: z.string().max(300).optional() }))
        .max(50)
        .optional(),
    })
    .default({}),
  enums: z.record(z.string().max(200), TableEnum).default({}),
  columns: z.record(z.string().max(700), TableColumn).default({}),
})
export type TablesDraft = z.infer<typeof TablesDraft>

/** 任务提示词的上限（shared/schema.ts 里任务的 prompt） */
const PROMPT_MAX = 20000

export function buildTablesPrompt(sample: string, convo: string, langWord: string) {
  return [
    '你是「Agent 面板」里的表格分析助手，正在帮用户总结**这个项目的游戏配置表的风格**，结果用来让网页上的表格能结构化显示和修改（固定表头、枚举下拉、引用检查）。',
    '面板从项目里挑了下面几张表（不用看全部表）。**一张一张来**：每张表用面板动作 `table.sample`（app_do，参数 `{ "path": 表格路径 }`）读它的表头和前几行，先写一两行这张表的结论（表头从第几行开始、每行是什么、主键、类型名、看到的枚举值），再看下一张；全部看完再汇总。**不要自己写脚本解析 xlsx，不要读其它文件，不要改任何文件。**',
    `## 要看的表\n${sample}`,
    `## 要总结的
- style.headers：这个项目里出现的**几套表头**（数组，最常见的排第一）。各表表头行数不一样时就列多套，面板会按每张表的内容自动挑最合的一套。
  每套写表头从第几行开始（start，从 0 数）、每行是什么（roles，按顺序），可选 labels 给每行起名字（和 roles 一样长，例如「默认值」「导出标记」）。角色只能是：
  modifier（optional / repeated 这类修饰）、side（Client / Server / Editor 这类导出端）、type（uint32、string、枚举类型名）、
  name（字段名）、comment（中文注释）、other（其它表头行，例如分组标题、默认值；用 labels 写清是什么）。
- style.exceptions：内容上分不出来、必须按文件指定表头的（例如某个目录的表都是另一种表头），glob 用相对路径的通配（例如 "Config/Enum/*.xlsx"），why 写一句原因。能靠 headers 里多套自动挑对的就不用写例外。
- style.arrayMarks：修饰行里表示「这一列是数组」的值（例如 repeated、list）。
- style.roleEnums：表头某种行只能填固定几个值时，指向 enums 里的枚举名（例如 { "modifier": "Modifier", "side": "Side" }）；类型行写 "@types"。
- style.key：主键字段名（通常是 ID / Id）。
- style.listSep：repeated 列一格里多个值的分隔符（例如 ; 或 |）。
- style.primitives：类型行里出现的基础类型名（数字、字符串、布尔），其余大驼峰的类型名当枚举或结构。
- enums：样本里看得出取值范围的枚举类型：键是类型名，values 是 [{ "name": 填进表格的字, "value": 数值（看不出就不写）, "desc": 说明（看不出就不写） }]。
  只列样本里确实出现过的值，不要编；值太多（超过 200）或看起来是自由文本的不要当枚举。
- columns：看得出的引用和范围，键是「相对路径#*#字段名」，值是 { "ref": "被引用表的相对路径#字段名", "min": 数, "max": 数, "allow": ["-1"], "note": 说明 }。
  只写有把握的；没有就给空对象。`,
    convo ? `## 对话\n${convo}` : '',
    `## 输出格式
先用两三句${langWord}说明看到的风格。然后输出且只输出一个 \`\`\`json 代码块：
\`\`\`json
{ "summary": "一句话总结", "style": { "headers": [{ "start": 0, "roles": ["modifier", "side", "type", "name", "comment"] }, { "start": 0, "roles": ["type", "name", "comment"] }], "key": "ID", "listSep": ";", "primitives": ["uint32", "int32", "string", "bytes", "bool", "float"], "arrayMarks": ["repeated"], "exceptions": [] }, "enums": {}, "columns": {} }
\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** AI 交回的表格风格：页面上逐项勾选后写进结构文件 */
export type TablesProposal = { kind: 'tables'; draft: TablesDraft }

/** 配置助手的入口（shared/assist.ts 调）：样本由页面先读好放在 subject.sample */
export function buildTablesBody(subject: Record<string, string>, messages: AssistMessage[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  // 清单很短；多轮对话越来越长时只留最近的，整段提示词要在任务提示词上限以内
  const sample = (subject.sample ?? '').slice(0, 3000)
  const room = PROMPT_MAX - 500 - buildTablesPrompt(sample, '', promptLangWord()).length
  return buildTablesPrompt(sample, convo.length > room ? `…\n${convo.slice(-room)}` : convo, promptLangWord())
}

/**
 * 表头里写了不认识的角色（default、export、desc……）不整份作废：改成 other，原来的词留作这行的名字。
 * 只动 header / headers / exceptions[].header 里的 roles，其它照原样交给 zod 检查
 */
function fixRoles(h: unknown): unknown {
  if (!h || typeof h !== 'object' || !Array.isArray((h as { roles?: unknown }).roles)) return h
  const { roles, labels } = h as { roles: unknown[]; labels?: unknown }
  let changed = false
  const names = roles.map((r, i) => (Array.isArray(labels) && typeof labels[i] === 'string' ? labels[i] : ''))
  const next = roles.map((r, i) => {
    if (typeof r === 'string' && (SHEET_ROLES as readonly string[]).includes(r)) return r
    changed = true
    if (!names[i] && typeof r === 'string') names[i] = r.slice(0, 20)
    return 'other'
  })
  if (!changed) return h
  return { ...h, roles: next, labels: names.some(Boolean) ? names : undefined }
}

function normalizeDraft(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json
  const style = (json as { style?: Record<string, unknown> }).style
  if (!style || typeof style !== 'object') return json
  const s: Record<string, unknown> = { ...style }
  if (s.header) s.header = fixRoles(s.header)
  if (Array.isArray(s.headers)) s.headers = s.headers.map(fixRoles)
  if (Array.isArray(s.exceptions))
    s.exceptions = s.exceptions.map((e) =>
      e && typeof e === 'object' ? { ...e, header: fixRoles((e as { header?: unknown }).header) } : e,
    )
  return { ...json, style: s }
}

/** 几套表头去重（同起点同角色算一套），旧格式的单套 header 并在最前面 */
export function draftHeaders(s: TablesDraft['style']): Header[] {
  const out: Header[] = []
  for (const h of [...(s.header ? [s.header] : []), ...(s.headers ?? [])])
    if (h.roles.length && !out.some((x) => x.start === h.start && x.roles.join() === h.roles.join())) out.push(h)
  return out
}

export function resolveTablesProposal(json: unknown): { proposal?: TablesProposal; error?: string } {
  const p = TablesDraft.safeParse(normalizeDraft(json))
  if (!p.success) return { error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const headers = draftHeaders(p.data.style)
  const style = { ...p.data.style }
  delete style.header
  return {
    proposal: { kind: 'tables', draft: { ...p.data, style: { ...style, ...(headers.length ? { headers } : {}) } } },
  }
}

/** 分析结果里能单独勾选的每一项（id 给 applyTablesDraft 用） */
export function draftItemIds(d: TablesDraft): string[] {
  const s = d.style
  return [
    ...(draftHeaders(s).length ? ['headers'] : []),
    ...(s.key ? ['key'] : []),
    ...(s.listSep ? ['listSep'] : []),
    ...(s.primitives?.length ? ['primitives'] : []),
    ...(s.arrayMarks?.length ? ['arrayMarks'] : []),
    ...(s.roleEnums && Object.keys(s.roleEnums).length ? ['roleEnums'] : []),
    ...(s.exceptions ?? []).map((_, i) => `ex:${i}`),
    ...Object.keys(d.enums).map((k) => `enum:${k}`),
    ...Object.keys(d.columns).map((k) => `col:${k}`),
  ]
}

/**
 * 把勾上的几项并进结构文件：表头、主键这类单值直接换；例外按 glob 换掉同名的；枚举、列按名字整项换
 * （手写的从枚举表取值的设置保留）。没勾的不动，记下分析时间
 */
export function applyTablesDraft(schema: TableSchema, d: TablesDraft, picked: Set<string>, at: string): TableSchema {
  const s = d.style
  const style = { ...schema.style }
  const headers = draftHeaders(s)
  // 换成分析出的几套表头；旧字段写第一套，旧版本的面板也认得
  if (picked.has('headers') && headers.length) {
    style.headers = headers
    style.header = headers[0]
  }
  if (picked.has('key') && s.key) style.key = s.key
  if (picked.has('listSep') && s.listSep) style.listSep = s.listSep
  if (picked.has('primitives') && s.primitives) style.primitives = s.primitives
  if (picked.has('arrayMarks') && s.arrayMarks?.length) style.arrayMarks = s.arrayMarks
  if (picked.has('roleEnums') && s.roleEnums) style.roleEnums = { ...style.roleEnums, ...s.roleEnums }
  const ex = (s.exceptions ?? []).filter((_, i) => picked.has(`ex:${i}`))
  if (ex.length)
    style.exceptions = [
      ...style.exceptions.filter((e) => !ex.some((x) => x.glob === e.glob)),
      ...ex.map(({ glob, header }) => ({ glob, header })),
    ]
  const enums = { ...schema.enums }
  for (const [k, e] of Object.entries(d.enums))
    if (picked.has(`enum:${k}`)) enums[k] = { ...e, ...(enums[k]?.source ? { source: enums[k].source } : {}) }
  const columns = { ...schema.columns }
  for (const [k, c] of Object.entries(d.columns)) if (picked.has(`col:${k}`)) columns[k] = c
  return { ...schema, style, enums, columns, analyzedAt: at }
}
