import { z } from 'zod'
import { t } from './i18n.ts'
import { DATA_PROPS, WIDGETS, deepMerge, mapWidget, walk, type Component, type Widget, type WidgetType } from './umg.ts'

/**
 * 画板预览用的运行时假数据（mock data）。
 *
 * 列表控件（UniformGridPanel、ListView、TileView、DynamicEntryBox）在设计文档里绑定一个数据集合：
 * 集合有字段定义和若干示例行，画板按这些行渲染出背包里真的有物品、选中态、锁定态的样子。
 * 这份数据只是画板预览用的，**不导出**（UMG / HTML / 网页导出都剔除），也不进 UE。
 *
 * 绑定规则（都写在控件的 Properties 里，导出时整组去掉）：
 * - 列表控件：DataSet = "<集合 id 或名字>"，条目数就是集合的行数（没有绑定时沿用设计器预览条数）
 * - 控件显示数据：DataField = "<字段 key>"，按控件类型取值（见 DATA_BINDING）
 * - 状态：States = [{ Name, When?: { Field, Equals }, Properties }]，按顺序取第一个匹配的
 *   状态，把 Properties 深合并到控件属性上；When 不写就是默认状态
 *
 * 条目子控件里的控件都能读到当前行的字段，所以同一个格子子控件可以按
 * 「selected / locked / empty」这些字段显示不同图片、不同高亮框。
 */

export const DATA_TYPES = ['string', 'number', 'boolean', 'image', 'color'] as const
export type DataType = (typeof DATA_TYPES)[number]

export const DataValue = z.union([z.string(), z.number(), z.boolean()])
export type DataValue = z.infer<typeof DataValue>
export type DataRow = Record<string, DataValue>

export const DataField = z.object({
  /** 字段名，写在控件的 DataField 里 */
  key: z.string().trim().min(1).max(40),
  /** 面板上显示的中文名 */
  label: z.string().trim().max(40).default(''),
  type: z.enum(DATA_TYPES).catch('string'),
  /** 新建一行时的默认值 */
  example: DataValue.optional(),
  /** 这个字段对应条目子控件里的哪个控件（面板显示用，不影响渲染） */
  widget: z.string().trim().max(80).default(''),
  note: z.string().trim().max(200).default(''),
})
export type DataField = z.infer<typeof DataField>

export const DataSet = z.object({
  id: z.string().trim().min(1).max(60),
  /** 集合名（英文标识，绑定和 AI 都按它找） */
  name: z.string().trim().min(1).max(40),
  label: z.string().trim().max(60).default(''),
  fields: z.array(DataField).max(40).default([]),
  rows: z.array(z.record(z.string(), DataValue)).max(100).default([]),
})
export type DataSet = z.infer<typeof DataSet>

export const DesignData = z.object({
  sets: z.array(DataSet).max(20).default([]),
})
export type DesignData = z.infer<typeof DesignData>

export const emptyData = (): DesignData => ({ sets: [] })

export const WidgetState = z.object({
  Name: z.string().trim().min(1).max(40),
  /** 数据里 Field 等于 Equals 时用这个状态；不写就是默认状态 */
  When: z.object({ Field: z.string().trim().min(1), Equals: DataValue }).optional(),
  /** 覆盖到控件属性上的字段，和原来的深合并 */
  Properties: z.record(z.string(), z.any()).default({}),
})
export type WidgetState = z.infer<typeof WidgetState>

/** 列表控件绑定哪个集合 */
export const DATA_SET_PROP = 'DataSet'
/** 控件显示哪个字段 */
export const DATA_FIELD_PROP = 'DataField'
/** 状态覆盖 */
export const STATES_PROP = 'States'
export { DATA_PROPS }

/** 按 id 或名字找集合（AI 写名字、面板按 id 存都认） */
export const findDataSet = (data: DesignData | undefined, key: string) =>
  data?.sets.find((s) => s.id === key || s.name === key)

/** 控件上定义的状态 */
export function stateList(w: Widget): WidgetState[] {
  const v = w.Properties?.[STATES_PROP]
  return Array.isArray(v) ? (v as WidgetState[]) : []
}

/** 比较时不挑类型：数据面板里填的是文本，AI 写的是布尔/数字，都要能对上 */
const same = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  return String(a) === String(b)
}

/** 控件在当前数据行下的属性：第一个匹配的状态深合并到基准属性上 */
export function propsForRow(w: Widget, row?: DataRow): Record<string, any> {
  const base = w.Properties ?? {}
  const hit = stateList(w).find((s) => !s.When || (!!row && same(row[s.When.Field], s.When.Equals)))
  if (!hit || !hit.Properties) return base
  return deepMerge(base, hit.Properties)
}

/** 控件绑定的字段在当前行里的值 */
export function boundValue(w: Widget, row?: DataRow): DataValue | undefined {
  const key = String(w.Properties?.[DATA_FIELD_PROP] ?? '')
  return key && row ? row[key] : undefined
}

/**
 * 每种控件按数据字段改哪个属性。不在表里的控件只套用状态，不显示数据。
 * image 类型的字段值是 "img:<图片 id>"；值为空字符串时把控件隐藏（格子是空的）。
 */
export const DATA_BINDING: Partial<Record<WidgetType, string>> = {
  TextBlock: 'Text',
  Text: 'Text',
  EditableTextBox: 'Text',
  WebButton: 'Text',
  Input: 'Value',
  Image: 'Brush.ResourceObject',
  Picture: 'Src',
  ProgressBar: 'Percent',
  CheckBox: 'CheckedState',
}

const NONE = Symbol('none')

/** 字段值换成控件属性；返回 NONE 表示这个值不适用这个控件 */
function valueProp(w: Widget, value: DataValue | undefined): unknown {
  if (value === undefined) return NONE
  const prop = DATA_BINDING[w.Type]
  if (!prop) return NONE
  if (w.Type === 'Image') {
    // 图片控件：字段是图片引用（"img:<id>"）时换图，空字符串隐藏；布尔当「显示/隐藏」
    if (typeof value === 'boolean') return value ? NONE : 'Hidden'
    const v = String(value)
    return v ? v : 'Hidden'
  }
  if (w.Type === 'Picture') {
    if (typeof value === 'boolean') return value ? NONE : 'Hidden'
    return String(value)
  }
  if (w.Type === 'ProgressBar') return Math.max(0, Math.min(1, Number(value) || 0))
  if (w.Type === 'CheckBox') return value === true || value === 'true' || value === 1 ? 'Checked' : 'Unchecked'
  if (w.Type === 'Input') return String(value)
  return String(value)
}

/**
 * 渲染时的控件：先套数据行匹配到的状态，再按 DataField 换上数据。
 * 不改原来的树（返回新的控件），设计器的编辑和保存都不受影响。
 */
export function withRow(w: Widget, row?: DataRow): Widget {
  let props = propsForRow(w, row)
  const value = boundValue({ ...w, Properties: props }, row)
  const out = valueProp(w, value)
  const next = { ...props }
  if (out === NONE) {
    // 没有绑定，或者这个控件不支持显示这种值
  } else if (w.Type === 'Image') {
    if (out === 'Hidden') next.Visibility = 'Hidden'
    else next.Brush = { ...(props.Brush ?? {}), ResourceObject: String(out) }
  } else if (w.Type === 'Picture') {
    if (out === 'Hidden') next.Visibility = 'Hidden'
    else next.Src = String(out)
  } else {
    next[DATA_BINDING[w.Type]!] = out
  }
  return props === w.Properties && next === props ? w : { ...w, Properties: next }
}

/**
 * 列表控件当前的数据行：绑定了集合并且集合有行时返回行（条目数就是行数）；
 * 否则返回 undefined，按设计器的预览条数显示。
 */
export function dataRows(data: DesignData | undefined, w: Widget): DataRow[] | undefined {
  const key = String(w.Properties?.[DATA_SET_PROP] ?? '')
  if (!key) return undefined
  const set = findDataSet(data, key)
  return set ? set.rows : undefined
}

/** 设计里的列表控件和它绑定的集合：面板按它给每个控件换绑 */
export type DataListWidget = {
  /** 所在的树：主界面是空字符串，子控件是名字 */
  tree: string
  /** 控件的 id，改绑定用 */
  id: string
  name: string
  /** 面板显示用的完整名字 */
  label: string
  /** Properties.DataSet 原样（可能是集合 id、名字，或者指向不存在的集合） */
  set: string
}

export function listWidgets(root: Widget, components: Component[]): DataListWidget[] {
  const out: DataListWidget[] = []
  const trees = [{ in: '', root }, ...components.map((c) => ({ in: c.Name, root: c.Root }))]
  for (const tr of trees)
    walk(tr.root, (w) => {
      if (!WIDGETS[w.Type]?.entries) return
      out.push({
        tree: tr.in,
        id: w.id,
        name: w.Name,
        label: `${tr.in ? `${tr.in} / ` : ''}${w.Name}`,
        set: String(w.Properties?.[DATA_SET_PROP] ?? ''),
      })
    })
  return out
}

/** 把列表控件的 DataSet 换个集合（空字符串是解绑），返回新的控件树，不改原来的 */
export function bindDataSet(
  root: Widget,
  components: Component[],
  where: { tree: string; id: string },
  key: string,
): { root: Widget; components: Component[] } {
  const bind = (w: Widget) => ({ ...w, Properties: { ...w.Properties, [DATA_SET_PROP]: key } })
  if (!where.tree) return { root: mapWidget(root, where.id, bind), components }
  return {
    root,
    components: components.map((c) => (c.Name === where.tree ? { ...c, Root: mapWidget(c.Root, where.id, bind) } : c)),
  }
}

/** 集合用在哪些控件上（面板显示「用在哪」） */
export function dataUsage(root: Widget, components: Component[], data: DesignData | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const trees = [{ in: '', root }, ...components.map((c) => ({ in: c.Name, root: c.Root }))]
  for (const tr of trees)
    walk(tr.root, (w) => {
      const key = String(w.Properties?.[DATA_SET_PROP] ?? '')
      const set = key ? findDataSet(data, key) : undefined
      if (!set) return
      const name = `${tr.in ? `${tr.in} / ` : ''}${w.Name}`
      out.set(set.id, [...(out.get(set.id) ?? []), name])
    })
  return out
}

const slug = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

/** 把 AI 或面板写的数据集补齐 id、字段默认值；id 冲突时加序号 */
export function normalizeData(input: unknown, existing: DesignData = emptyData()): DesignData {
  // AI 常常只写 name 不写 id：先按 name 补上再校验
  const raw = Array.isArray((input as any)?.sets) ? (input as any).sets : undefined
  if (!raw) return existing
  const p = DesignData.safeParse({
    ...(input as object),
    sets: raw.map((s: any) => ({ ...s, id: slug(s?.id) || slug(s?.name) || 'data' })),
  })
  if (!p.success) return existing
  const ids = new Set<string>()
  const sets = p.data.sets.map((s) => {
    let id = s.id || 'data'
    const base = id
    for (let k = 2; ids.has(id); k++) id = `${base}_${k}`
    ids.add(id)
    return { ...s, id }
  })
  return { sets }
}

/** 数据有没有问题：集合 id / 名字重复、字段重复、行里的图片引用不存在 */
export function checkData(
  data: DesignData | undefined,
  o: { imageIds?: Set<string>; root?: Widget; components?: Component[] } = {},
): string[] {
  const out: string[] = []
  // 没有任何集合时也要继续查下面的悬空绑定（删掉最后一个集合后列表还指着它）
  if (!data) return out
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const s of data.sets) {
    if (ids.has(s.id)) out.push(t('数据集合 id 重复：{id}', { id: s.id }))
    if (names.has(s.name)) out.push(t('数据集合名字重复：{name}', { name: s.name }))
    ids.add(s.id)
    names.add(s.name)
    const keys = new Set<string>()
    for (const f of s.fields) {
      if (keys.has(f.key)) out.push(t('集合 {name} 的字段重复：{key}', { name: s.name, key: f.key }))
      keys.add(f.key)
    }
    for (const [i, row] of s.rows.entries())
      for (const f of s.fields) {
        if (f.type !== 'image') continue
        const v = row[f.key]
        if (typeof v !== 'string' || !v) continue
        if (!v.startsWith('img:'))
          out.push(
            t('集合 {name} 第 {row} 行的 {key} 不是 "img:<图片 id>"：{value}', {
              name: s.name,
              row: i + 1,
              key: f.key,
              value: v,
            }),
          )
        else if (o.imageIds && !o.imageIds.has(v.slice(4)))
          out.push(
            t('集合 {name} 第 {row} 行的 {key} 引用了不存在的图片 {image}', {
              name: s.name,
              row: i + 1,
              key: f.key,
              image: v.slice(4),
            }),
          )
      }
  }
  // 列表控件绑定了不存在的集合
  if (o.root) {
    const trees = [{ in: '', root: o.root }, ...(o.components ?? []).map((c) => ({ in: c.Name, root: c.Root }))]
    for (const tr of trees)
      walk(tr.root, (w) => {
        const key = String(w.Properties?.[DATA_SET_PROP] ?? '')
        if (!key || findDataSet(data, key)) return
        out.push(
          t('{widget} 的 DataSet 指向不存在的集合 {key}：把控件改成已有的集合，或让 AI 用 set_data 补一个同名集合', {
            widget: `${tr.in ? `${tr.in} / ` : ''}${w.Name}`,
            key,
          }),
        )
      })
  }
  return out
}

/**
 * 给 AI 的数据结构说明：面板据此生成表单，AI 照着它产出行。
 * 只列设计里真正用到的集合，避免把整个设计数据塞进提示词。
 */
export function dataBrief(data: DesignData | undefined) {
  if (!data?.sets.length) return ''
  return data.sets
    .map((s) => {
      const fields = s.fields
        .map(
          (f) =>
            `  - ${f.key}（${f.type}${f.label ? `，${f.label}` : ''}${f.widget ? `，对应控件 ${f.widget}` : ''}${f.example !== undefined ? `，示例 ${JSON.stringify(f.example)}` : ''}）`,
        )
        .join('\n')
      return `- ${s.name}（${s.id}）${s.label ? `：${s.label}` : ''}，${s.rows.length} 行\n${fields || '  （没有字段）'}`
    })
    .join('\n')
}
