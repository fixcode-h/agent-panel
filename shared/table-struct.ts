/**
 * 结构化表格：从表头（字段名、类型、修饰行）和项目的表格结构文件算出每一列是什么——
 * 整数、小数、布尔、文字、枚举、引用别的表、repeated 列表、取值范围——再按它检查格子。
 * 页面（改格子时的下拉、标红）和服务端（全表检查）用同一份。
 */
import { t } from './i18n.ts'
import { detectSheetHeader, validHeader, type SheetHeader, type SheetRole } from './sheet-header.ts'
import { TYPE_NAMES, globHit, schemaColumn, schemaHeader, type TableEnum, type TableSchema } from './tables.ts'
import type { SheetData } from './files.ts'

export type ColKind = 'int' | 'uint' | 'float' | 'bool' | 'string' | 'enum' | 'other'

export interface ColInfo {
  col: number
  /** 字段名（字段名行的字）；没有表头时是空 */
  field: string
  /** 类型：结构文件里改过的优先，否则是类型行的字 */
  type: string
  /** 表头里这一列的每一行（修饰、导出端、类型、字段名、注释……），列结构里照着显示 */
  head: { role: SheetRole; text: string }[]
  kind: ColKind
  list: boolean
  /** 数组的分隔符（列结构里设的 > 项目的） */
  sep: string
  /** 没有字段名的列：备注列，灰字显示、不检查 */
  remark: boolean
  enumName?: string
  ref?: string
  min?: number
  max?: number
  allow?: string[]
  /** 正则（整格匹配） */
  pattern?: string
  required?: boolean
  requiredWhen?: { field: string; values: string[] }
  note?: string
  /** 这一列在结构文件里单独设过 */
  custom: boolean
}

const INT = /^(s?int(8|16|32|64)?|sfixed(32|64)|long|short|byte)$/i
const UINT = /^(uint(8|16|32|64)?|fixed(32|64)|ulong|ushort)$/i
const FLOAT = /^(float|double|number|real|decimal)$/i
const BOOL = /^(bool|boolean)$/i
const STRING = /^(string|bytes|text|str|fstring|fname|ftext)$/i

/** 表头里某种角色那一行（没有就是空数组） */
function roleRow(rows: string[][], header: SheetHeader, role: string) {
  const i = header.roles.indexOf(role as never)
  return i < 0 ? [] : (rows[header.start + i] ?? [])
}

/** 一张表每一列的结构 */
export function columnInfos(
  schema: TableSchema,
  rows: string[][],
  header: SheetHeader,
  file: string,
  sheet: string,
  cols: number,
): ColInfo[] {
  const names = roleRow(rows, header, 'name')
  const types = roleRow(rows, header, 'type')
  const mods = roleRow(rows, header, 'modifier')
  const out: ColInfo[] = []
  for (let c = 0; c < cols; c++) {
    const field = (names[c] ?? '').trim()
    const own = field ? schemaColumn(schema, file, sheet, field) : undefined
    const rawType = own?.type || (types[c] ?? '').trim()
    // 类型里写了数组：int[]、list<int>、array<ItemId>、TArray<…>、vector<…>；按元素类型检查
    const arr = /^(.+?)\s*\[\]$/.exec(rawType) ?? /^(?:list|array|vector|tarray|set)\s*<\s*(.+?)\s*>$/i.exec(rawType)
    const type = arr ? arr[1].trim() : rawType
    const mod = (mods[c] ?? '').trim().toLowerCase()
    const marks = (schema.style.arrayMarks ?? ['repeated']).map((m) => m.toLowerCase())
    const enumName = own?.enum ?? (schema.enums[type] ? type : undefined)
    const kind: ColKind = enumName
      ? 'enum'
      : INT.test(type)
        ? 'int'
        : UINT.test(type)
          ? 'uint'
          : FLOAT.test(type)
            ? 'float'
            : BOOL.test(type)
              ? 'bool'
              : STRING.test(type) || schema.style.primitives.includes(type)
                ? 'string'
                : 'other'
    out.push({
      col: c,
      field,
      type,
      head: header.roles.map((role, i) => ({ role, text: (rows[header.start + i]?.[c] ?? '').trim() })),
      kind,
      list: own?.list ?? (!!arr || (!!mod && marks.includes(mod))),
      sep: own?.sep || schema.style.listSep || ';',
      remark: !field && names.length > 0,
      enumName,
      ref: own?.ref,
      min: own?.min,
      max: own?.max,
      allow: own?.allow,
      pattern: own?.pattern || undefined,
      required: own?.required,
      requiredWhen: own?.requiredWhen?.field ? own.requiredWhen : undefined,
      note: own?.note,
      custom: !!own,
    })
  }
  return out
}

/** 一个枚举能选的值：结构文件里记的 + 枚举表里的（同名的以结构文件为准） */
export interface EnumOption {
  name: string
  value?: string
  desc?: string
}
export function enumOptions(e: TableEnum | undefined, fromSource: EnumOption[] = []): EnumOption[] {
  const own = e?.values ?? []
  const seen = new Set(own.map((v) => v.name))
  return [...own, ...fromSource.filter((v) => !seen.has(v.name))]
}

/** 「相对路径#字段名」或「相对路径#工作表#字段名」 */
export function parseRef(ref: string): { file: string; sheet?: string; field: string } | null {
  const parts = ref.split('#')
  if (parts.length === 2 && parts[0] && parts[1]) return { file: parts[0], field: parts[1] }
  if (parts.length === 3 && parts[0] && parts[2])
    return { file: parts[0], sheet: parts[1] || undefined, field: parts[2] }
  return null
}

export interface CheckCtx {
  listSep: string
  /** 枚举名 → 能填的字（名字和值都算） */
  enums: Map<string, Set<string>>
  /** 引用写法 → 那一列有的值；还没读到的不检查 */
  refs: Map<string, Set<string>>
}

const isInt = (v: string) => /^[-+]?\d+$/.test(v)

/** 编好的正则：同一个写法只编一次；写错的记成 null（不查，列结构里会提示写错了） */
const RE_CACHE = new Map<string, RegExp | null>()
export function patternRe(p: string): RegExp | null {
  let re = RE_CACHE.get(p)
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${p})$`, 'u')
    } catch {
      re = null
    }
    if (RE_CACHE.size > 500) RE_CACHE.clear()
    RE_CACHE.set(p, re)
  }
  return re
}

/**
 * 不合规的种类：检查结果按「字段 + 种类」分组（同一列「引用的表里没有 X」「……没有 Y」算一组），
 * 也决定能给哪些批量修法（超出范围改成边界值……）
 */
export type ProblemRule =
  'type' | 'min' | 'max' | 'pattern' | 'enum' | 'ref' | 'required' | 'requiredWhen' | 'key' | 'unique' | 'header'

/** 一格不合规：原因 + 种类 */
export interface CellBad {
  rule: ProblemRule
  msg: string
}

/** 一个值对不对：对就返回 undefined，不对返回原因和种类 */
function checkOne(info: ColInfo, v: string, ctx: CheckCtx): CellBad | undefined {
  if (info.allow?.includes(v)) return undefined
  if (info.kind === 'int' && !isInt(v)) return { rule: 'type', msg: t('应为整数') }
  if (info.kind === 'uint' && !/^\+?\d+$/.test(v)) return { rule: 'type', msg: t('应为不小于 0 的整数') }
  if (info.kind === 'float' && !Number.isFinite(Number(v))) return { rule: 'type', msg: t('应为数字') }
  if (info.kind === 'bool' && !/^(true|false|0|1)$/i.test(v)) return { rule: 'type', msg: t('应为 TRUE / FALSE') }
  if (info.min !== undefined || info.max !== undefined) {
    const n = Number(v)
    if (Number.isFinite(n)) {
      if (info.min !== undefined && n < info.min) return { rule: 'min', msg: t('不能小于 {n}', { n: info.min }) }
      if (info.max !== undefined && n > info.max) return { rule: 'max', msg: t('不能大于 {n}', { n: info.max }) }
    }
  }
  if (info.pattern) {
    const re = patternRe(info.pattern)
    if (re && !re.test(v)) return { rule: 'pattern', msg: t('不符合格式 {p}', { p: info.pattern }) }
  }
  if (info.enumName) {
    const set = ctx.enums.get(info.enumName)
    if (set && set.size && !set.has(v))
      return { rule: 'enum', msg: t('「{v}」不是 {e} 里的值', { v, e: info.enumName }) }
  }
  if (info.ref) {
    const set = ctx.refs.get(info.ref)
    if (set && !set.has(v)) return { rule: 'ref', msg: t('引用的表里没有「{v}」', { v }) }
  }
  return undefined
}

/** 一格对不对（带种类）；空格子不查（可以不填） */
export function cellBad(info: ColInfo | undefined, value: string, ctx: CheckCtx): CellBad | undefined {
  if (!info || !value || info.remark) return undefined
  if (info.list) {
    for (const item of value.split(info.sep || ctx.listSep).map((x) => x.trim())) {
      if (!item) continue
      const bad = checkOne(info, item, ctx)
      if (bad) return bad
    }
    return undefined
  }
  return checkOne(info, value.trim(), ctx)
}

/** 一格对不对；空格子不查（可以不填） */
export function checkCell(info: ColInfo | undefined, value: string, ctx: CheckCtx): string | undefined {
  return cellBad(info, value, ctx)?.msg
}

export interface Problem {
  r: number
  c: number
  msg: string
  /** 种类（分组、批量修用）；老数据没有 */
  rule?: ProblemRule
}

/** 一行里不合规的格子（列号 + 原因 + 种类） */
export type RowProblems = { c: number; msg: string; rule: ProblemRule }[]

/**
 * 整张表：每格按列的结构查，主键列查重复。
 * cache 按「行数组」记每行查出来的问题：表格页改格子时只复制改到的行，没改的行还是同一个数组，
 * 直接用上次的结果，一万行的表改一格只重查那一行（主键重复每次全表数一遍，只是查表很快）。
 * 列的结构、枚举变了时调用方换一个新的 cache
 */
export function checkSheet(
  rows: string[][],
  from: number,
  infos: ColInfo[],
  key: string,
  ctx: CheckCtx,
  limit = 2000,
  cache?: WeakMap<string[], RowProblems>,
  /** 组合唯一：每组几个字段名（uniquesFor 取） */
  uniques: string[][] = [],
) {
  const out: Problem[] = []
  const keyCol = infos.find((i) => i.field && i.field === key)?.col ?? -1
  const seen = new Map<string, number>()
  const colOf = new Map(infos.filter((i) => i.field).map((i) => [i.field, i.col]))
  // 组合唯一：字段都找得到的组才查；重复记在这组的第一列上
  const groups = uniques
    .map((fields) => ({ fields, cols: fields.map((f) => colOf.get(f) ?? -1), seen: new Map<string, number>() }))
    .filter((g) => g.cols.every((c) => c >= 0))
  const needs = infos.filter((i) => !i.remark && (i.required || i.requiredWhen))
  for (let r = from; r < rows.length && out.length < limit; r++) {
    const row = rows[r] ?? []
    let own = cache?.get(row)
    if (!own) {
      own = []
      for (const info of infos) {
        const bad = cellBad(info, row[info.col] ?? '', ctx)
        if (bad) own.push({ c: info.col, ...bad })
      }
      // 必填、条件必填：只看这一行，和上面一起按行缓存
      for (const info of needs) {
        if ((row[info.col] ?? '').trim()) continue
        if (info.required) own.push({ c: info.col, msg: t('必填'), rule: 'required' })
        else if (info.requiredWhen) {
          const at = colOf.get(info.requiredWhen.field)
          const v = at === undefined ? '' : (row[at] ?? '').trim()
          if (v && info.requiredWhen.values.includes(v))
            own.push({
              c: info.col,
              msg: t('{field} 是「{v}」时必填', { field: info.requiredWhen.field, v }),
              rule: 'requiredWhen',
            })
        }
      }
      if (cache && rows[r]) cache.set(rows[r], own)
    }
    for (const p of own) out.push({ r, ...p })
    if (keyCol >= 0) {
      const k = (row[keyCol] ?? '').trim()
      if (!k) continue
      const dup = seen.get(k)
      if (dup !== undefined)
        out.push({ r, c: keyCol, msg: t('主键重复：第 {n} 行也是「{k}」', { n: dup + 1, k }), rule: 'key' })
      else seen.set(k, r)
    }
    for (const g of groups) {
      const vals = g.cols.map((c) => (row[c] ?? '').trim())
      // 全空的行不算（还没填）
      if (vals.every((v) => !v)) continue
      const k = vals.join('\u0000')
      const dup = g.seen.get(k)
      if (dup !== undefined)
        out.push({
          r,
          c: g.cols[0],
          msg: t('{fields} 组合重复：和第 {n} 行一样', { fields: g.fields.join(' + '), n: dup + 1 }),
          rule: 'unique',
        })
      else g.seen.set(k, r)
    }
  }
  return out
}

/** 这个文件要查的组合唯一（结构文件 style.uniques 按通配匹配） */
export const uniquesFor = (schema: TableSchema, file: string) =>
  (schema.style.uniques ?? []).filter((u) => globHit(file, [u.glob])).map((u) => u.fields)

/**
 * 表头行按设置里定的取值查（修饰行只能 optional / repeated 这类）：只查有字段名的列，
 * 没字段名的是备注列，随便写
 */
export function checkHeader(
  rows: string[][],
  header: SheetHeader,
  infos: ColInfo[],
  schema: TableSchema,
  ctx: CheckCtx,
): Problem[] {
  const out: Problem[] = []
  const roleEnums = schema.style.roleEnums ?? {}
  header.roles.forEach((role, i) => {
    const name = roleEnums[role]
    const set = name ? ctx.enums.get(name) : undefined
    if (!name || !set?.size) return
    const r = header.start + i
    for (const info of infos) {
      if (!info.field) continue
      const v = (rows[r]?.[info.col] ?? '').trim()
      if (v && !set.has(v))
        out.push({
          r,
          c: info.col,
          msg:
            name === TYPE_NAMES
              ? t('「{v}」不是基础类型，也不是通用枚举', { v })
              : t('「{v}」不是 {e} 里的值', { v, e: name }),
          rule: 'header',
        })
    }
  })
  return out
}

/** 一张表用哪套表头：结构文件里的（单文件 > 例外 > 项目风格），没有就自动识别 */
export function headerOf(schema: TableSchema, file: string, sheet: SheetData): SheetHeader {
  const own = schemaHeader(schema, file, sheet.name, sheet.rows)
  if (own && validHeader(own, sheet.rows.length)) return own
  const d = detectSheetHeader(sheet.rows)
  return { start: d.start, roles: d.roles }
}

/** 枚举表里的值：按「名字列 / 值列 / 说明列」取，多个枚举放在一张表里时按 match 筛 */
export function enumSourceOptions(
  src: NonNullable<TableEnum['source']>,
  sheets: SheetData[] | undefined,
  schema: TableSchema,
): EnumOption[] {
  const sheet = sheets?.find((s) => !src.sheet || s.name === src.sheet)
  if (!sheet) return []
  const header = headerOf(schema, src.file, sheet)
  const names = roleRow(sheet.rows, header, 'name').map((x) => x.trim())
  const col = (f?: string) => (f ? names.indexOf(f) : -1)
  const nc = col(src.nameCol)
  if (nc < 0) return []
  const vc = col(src.valueCol)
  const dc = col(src.descCol)
  const mc = col(src.match?.col)
  const out: EnumOption[] = []
  const seen = new Set<string>()
  for (let r = header.start + header.roles.length; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? []
    if (mc >= 0 && (row[mc] ?? '').trim() !== src.match!.value) continue
    const name = (row[nc] ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      ...(vc >= 0 && row[vc] ? { value: row[vc].trim() } : {}),
      ...(dc >= 0 && row[dc] ? { desc: row[dc].trim() } : {}),
    })
  }
  return out
}

/** 引用列能填的值：被引用的表那一列的值（第二个是同一行里看得懂的名字，下拉里一起显示） */
export function refOptions(ref: string, sheets: SheetData[] | undefined, schema: TableSchema): EnumOption[] {
  const p = parseRef(ref)
  const sheet = p && sheets?.find((s) => !p.sheet || s.name === p.sheet)
  if (!p || !sheet) return []
  const header = headerOf(schema, p.file, sheet)
  const names = roleRow(sheet.rows, header, 'name').map((x) => x.trim())
  const c = names.indexOf(p.field)
  if (c < 0) return []
  // 同一行里找一个「名字」列当说明：Name / DisplayName / 名称……
  const lc = names.findIndex((n, i) => i !== c && /name|名/i.test(n))
  const seen = new Set<string>()
  const out: EnumOption[] = []
  for (let r = header.start + header.roles.length; r < sheet.rows.length; r++) {
    const v = (sheet.rows[r]?.[c] ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    const desc = lc >= 0 ? (sheet.rows[r]?.[lc] ?? '').trim() : ''
    out.push(desc ? { name: v, desc } : { name: v })
  }
  return out
}

/** 这些列要用到哪些别的文件（枚举表、被引用的表） */
export function neededFiles(schema: TableSchema, infos: ColInfo[]) {
  const files = new Set<string>()
  for (const i of infos) {
    const src = i.enumName ? schema.enums[i.enumName]?.source : undefined
    if (src?.file) files.add(src.file)
    const p = i.ref ? parseRef(i.ref) : null
    if (p) files.add(p.file)
  }
  return [...files]
}

/** 下拉的选项和检查用的集合：sheetsOf 给出已经读到的别的文件（没读到的引用先不查） */
export function columnOptions(
  schema: TableSchema,
  infos: ColInfo[],
  sheetsOf: (file: string) => SheetData[] | undefined,
) {
  const enumOpts = new Map<string, EnumOption[]>()
  const refOpts = new Map<string, EnumOption[]>()
  const ctx: CheckCtx = { listSep: schema.style.listSep || ';', enums: new Map(), refs: new Map() }
  // 表头行的取值（设置里给每种表头行选的通用枚举）也一起准备好
  for (const name of Object.values(schema.style.roleEnums ?? {})) {
    if (!name || enumOpts.has(name)) continue
    const opts: EnumOption[] =
      name === TYPE_NAMES
        ? [
            ...schema.style.primitives.map((p) => ({ name: p })),
            ...Object.keys(schema.enums).map((e) => ({ name: e, desc: t('枚举') })),
          ]
        : enumOptions(schema.enums[name])
    enumOpts.set(name, opts)
    ctx.enums.set(name, new Set(opts.flatMap((o) => (o.value ? [o.name, o.value] : [o.name]))))
  }
  for (const i of infos) {
    if (i.enumName && !enumOpts.has(i.enumName)) {
      const e = schema.enums[i.enumName]
      const src = e?.source ? enumSourceOptions(e.source, sheetsOf(e.source.file), schema) : []
      const opts = enumOptions(e, src)
      enumOpts.set(i.enumName, opts)
      ctx.enums.set(i.enumName, new Set(opts.flatMap((o) => (o.value ? [o.name, o.value] : [o.name]))))
    }
    if (i.ref && !refOpts.has(i.ref)) {
      const p = parseRef(i.ref)
      const sheets = p ? sheetsOf(p.file) : undefined
      const opts = refOptions(i.ref, sheets, schema)
      refOpts.set(i.ref, opts)
      if (sheets) ctx.refs.set(i.ref, new Set(opts.map((o) => o.name)))
    }
  }
  return { enumOpts, refOpts, ctx }
}

/** 一张工作表的检查结果（全项目检查用）：前几处问题带字段名，点了能跳过去 */
export interface SheetProblems {
  path: string
  sheet: string
  /** 第几张工作表（跳转用） */
  index: number
  count: number
  first: (Problem & { field: string })[]
}

/**
 * 一个文件的所有工作表按结构查一遍。sheetsOf 给别的文件（枚举表、被引用的表），调用方先把
 * workbookNeeds 列出的文件读好；读不到的引用不查（和页面上一样）
 */
export function checkWorkbook(
  schema: TableSchema,
  file: string,
  sheets: SheetData[],
  sheetsOf: (file: string) => SheetData[] | undefined,
  first = 20,
): SheetProblems[] {
  const out: SheetProblems[] = []
  sheets.forEach((sheet, index) => {
    const { header, infos } = sheetInfos(schema, file, sheet)
    if (!infos.some((i) => i.field)) return
    const { ctx } = columnOptions(schema, infos, (f) => (f === file ? sheets : sheetsOf(f)))
    const problems = [
      ...checkHeader(sheet.rows, header, infos, schema, ctx),
      ...checkSheet(
        sheet.rows,
        header.start + header.roles.length,
        infos,
        schema.style.key,
        ctx,
        2000,
        undefined,
        uniquesFor(schema, file),
      ),
    ]
    if (problems.length)
      out.push({
        path: file,
        sheet: sheet.name,
        index,
        count: problems.length,
        first: problems.slice(0, first).map((p) => ({ ...p, field: infos[p.c]?.field ?? '' })),
      })
  })
  return out
}

/** 一个文件检查时要先读好的别的文件 */
export function workbookNeeds(schema: TableSchema, file: string, sheets: SheetData[]) {
  const files = new Set<string>()
  for (const sheet of sheets)
    for (const f of neededFiles(schema, sheetInfos(schema, file, sheet).infos)) if (f !== file) files.add(f)
  return [...files]
}

function sheetInfos(schema: TableSchema, file: string, sheet: SheetData) {
  const header = headerOf(schema, file, sheet)
  const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  return { header, infos: columnInfos(schema, sheet.rows, header, file, sheet.name, cols) }
}

/**
 * 只查改到的格子（Agent 改表格、跨项目拷行之前用）：整张表按结构查一遍，留下落在这些格子上的问题，
 * 主键列的重复也算（新加的行可能和已有的撞）
 */
export function checkTouched(
  schema: TableSchema,
  file: string,
  sheet: SheetData,
  touched: { r: number; c: number }[],
  sheetsOf: (file: string) => SheetData[] | undefined,
): (Problem & { field: string })[] {
  const { header, infos } = sheetInfos(schema, file, sheet)
  const { ctx } = columnOptions(schema, infos, sheetsOf)
  const key = schema.style.key
  const keyCol = infos.find((i) => i.field && i.field === key)?.col ?? -1
  const cells = new Set(touched.map((x) => `${x.r}:${x.c}`))
  const rows = new Set(touched.map((x) => x.r))
  return checkSheet(
    sheet.rows,
    header.start + header.roles.length,
    infos,
    key,
    ctx,
    100_000,
    undefined,
    uniquesFor(schema, file),
  )
    .filter((p) => cells.has(`${p.r}:${p.c}`) || (p.c === keyCol && rows.has(p.r)))
    .map((p) => ({ ...p, field: infos[p.c]?.field ?? '' }))
}
