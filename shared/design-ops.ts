import {
  WIDGETS,
  type SlotType,
  allNames,
  cloneWidget,
  deepMerge,
  findParent,
  insertWidget,
  mapWidget,
  moveWidget,
  normalizeTree,
  pathTo,
  removeWidget,
  walk,
  wrapWidget,
  type Component,
  type Widget,
  type WidgetType,
} from './umg.ts'
import { looseAnimation, renameInAnimations, type UiAnimation } from './anim.ts'

/**
 * AI 改设计用的操作：不用每次重写整棵控件树，像在控件树和属性面板里点一样，一步步改：
 * 改属性、加控件、删控件、移动、改名、整个替换，以及子控件（Widget Blueprint）的增删。
 * 控件用名字指定（同一棵树里名字不重复）；in 是在哪个子控件里改，不写就是主界面。
 *
 * 好处：输出短、改得准（不会顺手把没提到的地方改坏），服务端可以边收边应用，页面上实时看到变化。
 */
export type DesignOp =
  | { op: 'set'; in?: string; target: string; path: string; value: unknown }
  | { op: 'add'; in?: string; parent: string; index?: number; widget: unknown }
  | { op: 'remove'; in?: string; target: string }
  | { op: 'move'; in?: string; target: string; parent: string; index?: number }
  | { op: 'rename'; in?: string; target: string; name: string }
  | { op: 'replace'; in?: string; target: string; widget: unknown }
  | { op: 'duplicate'; in?: string; target: string; name?: string; parent?: string; index?: number }
  | { op: 'wrap'; in?: string; target: string; type: string; name?: string }
  | { op: 'addComponent'; component: { Name: string; DesignSize?: { X: number; Y: number }; Root: unknown } }
  | { op: 'removeComponent'; name: string }
  | { op: 'resizeComponent'; name: string; size: { X: number; Y: number } }
  | { op: 'setAnimation'; animation: unknown }
  | { op: 'removeAnimation'; in?: string; name: string }

export interface OpsState {
  root: Widget
  components: Component[]
  /** 动画（见 anim.ts）：in 是属于哪棵树 */
  animations?: UiAnimation[]
}

const byName = (root: Widget, name: string) => {
  let hit: Widget | undefined
  walk(root, (w) => {
    if (w.Name === name) hit = w
  })
  return hit
}

/** 按路径设值：对象和原来的值深合并（只写要改的字段就行），其他直接替换 */
function setPath(obj: any, path: string[], value: unknown): any {
  if (!path.length) {
    if (value && typeof value === 'object' && !Array.isArray(value) && obj && typeof obj === 'object')
      return deepMerge(obj, value)
    return value
  }
  const [k, ...rest] = path
  const base = obj && typeof obj === 'object' ? obj : {}
  return { ...base, [k]: setPath(base[k], rest, value) }
}

const ANCHORS: Record<string, [number, number]> = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
}
// AI 有时把数字写成字符串（"40"、"40px"），也认
const num = (v: unknown, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : d
}
const box = (v: unknown) =>
  typeof v === 'number'
    ? { Left: v, Top: v, Right: v, Bottom: v }
    : Array.isArray(v)
      ? v.length === 2
        ? { Left: num(v[0]), Top: num(v[1]), Right: num(v[0]), Bottom: num(v[1]) }
        : { Left: num(v[0]), Top: num(v[1]), Right: num(v[2]), Bottom: num(v[3]) }
      : v
const ALIGN = (prefix: 'HAlign' | 'VAlign', v: unknown) =>
  typeof v === 'string' && !v.includes('_') ? `${prefix}_${v[0].toUpperCase()}${v.slice(1).toLowerCase()}` : v

/** 画布插槽简写的键：大小写和常见别名都认 */
const CANVAS_KEYS: Record<string, string> = {
  anchor: 'anchor',
  x: 'x',
  y: 'y',
  w: 'w',
  h: 'h',
  z: 'z',
  margin: 'margin',
  width: 'w',
  height: 'h',
  left: 'x',
  top: 'y',
  zorder: 'z',
  margins: 'margin',
  pos: 'pos',
  position: 'pos',
  size: 'size',
}
const SHORT = ['anchor', 'x', 'y', 'w', 'h', 'z', 'margin']

/**
 * 插槽的简写，写起来短、不容易错：
 * 画布里 {"anchor":"top-right","x":-24,"y":24,"w":200,"h":60}——锚点和自身对齐点都是右上角，x、y 是离那个角的距离；
 * {"anchor":"stretch","margin":[左,上,右,下]} 铺满父控件留边距。
 * 横排、竖排等 {"padding":8 或 [左,上,右,下],"fill":1,"h":"center","v":"center"}
 */
function looseSlot(slot: any, parentSlot: SlotType | undefined, prev?: any): any {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot
  const out: any = { ...slot }
  if (parentSlot === 'CanvasPanelSlot') {
    // 键名大小写、别名都认（X、Width、left、size:[w,h]…）：认不出来就会悄悄变成默认的 100×40
    for (const [k, v] of Object.entries(slot)) {
      const key = CANVAS_KEYS[k.toLowerCase()]
      if (!key || k === key) continue
      delete out[k]
      if (out[key] === undefined) out[key] = v
    }
    // pos:[x,y]、size:[w,h]（也可以是 {x,y}）
    for (const key of ['pos', 'size'] as const) {
      if (out[key] === undefined) continue
      const v = out[key]
      delete out[key]
      const [a, b] = Array.isArray(v) ? v : [v?.x ?? v?.X, v?.y ?? v?.Y]
      const [ka, kb] = key === 'pos' ? ['x', 'y'] : ['w', 'h']
      if (a !== undefined && out[ka] === undefined) out[ka] = a
      if (b !== undefined && out[kb] === undefined) out[kb] = b
    }
  }
  if (parentSlot === 'CanvasPanelSlot' && SHORT.some((k) => k in out)) {
    // 只改了一部分（例如只写 x、y 挪位置）：没写的沿用原来的锚点、位置和大小，不要重置成默认值
    const was = prev?.LayoutData
    const wasMin = was?.Anchors?.Minimum
    const wasMax = was?.Anchors?.Maximum
    const wasStretch = !!wasMin && !!wasMax && (wasMin.X !== wasMax.X || wasMin.Y !== wasMax.Y)
    const wasAnchor =
      wasMin && !wasStretch
        ? Object.keys(ANCHORS).find((k) => ANCHORS[k][0] === wasMin.X && ANCHORS[k][1] === wasMin.Y)
        : undefined
    const o = was?.Offsets ?? {}
    const a = String(
      out.anchor ?? (wasStretch && !('x' in out || 'w' in out) ? 'stretch' : wasAnchor) ?? 'top-left',
    ).toLowerCase()
    if (a === 'stretch' || a === 'fill') {
      const m = box(out.margin ?? (wasStretch ? [o.Left, o.Top, o.Right, o.Bottom] : 0)) as any
      out.LayoutData = {
        Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } },
        Alignment: { X: 0, Y: 0 },
        Offsets: { Left: num(m?.Left), Top: num(m?.Top), Right: num(m?.Right), Bottom: num(m?.Bottom) },
      }
    } else {
      const [ax, ay] = ANCHORS[a] ?? [0, 0]
      const keep = !wasStretch && !!was
      out.LayoutData = {
        Anchors: { Minimum: { X: ax, Y: ay }, Maximum: { X: ax, Y: ay } },
        Alignment: { X: ax, Y: ay },
        Offsets: {
          Left: num(out.x, keep ? num(o.Left) : 0),
          Top: num(out.y, keep ? num(o.Top) : 0),
          Right: num(out.w, keep ? num(o.Right, 100) : 100),
          Bottom: num(out.h, keep ? num(o.Bottom, 40) : 40),
        },
      }
    }
    if ('z' in out) out.ZOrder = num(out.z)
    for (const k of SHORT) delete out[k]
    return out
  }
  if ('padding' in out) out.Padding = box(out.padding)
  if ('Padding' in out) out.Padding = box(out.Padding)
  if ('fill' in out) out.Size = { SizeRule: out.fill === false ? 'Automatic' : 'Fill', Value: num(out.fill, 1) }
  if ('h' in out) out.HorizontalAlignment = out.h
  if ('v' in out) out.VerticalAlignment = out.v
  if (out.HorizontalAlignment) out.HorizontalAlignment = ALIGN('HAlign', out.HorizontalAlignment)
  if (out.VerticalAlignment) out.VerticalAlignment = ALIGN('VAlign', out.VerticalAlignment)
  for (const k of ['padding', 'fill', 'h', 'v']) delete out[k]
  return out
}

const KEYS: Record<string, string> = {
  type: 'Type',
  name: 'Name',
  slot: 'Slot',
  children: 'Children',
  properties: 'Properties',
  props: 'Properties',
  class: 'Class',
}

/**
 * AI 写的控件宽松一点也认：键名大小写随意（type、children…），Type、Name、Slot、Children、Class 以外的键都当作属性
 * （{"Type":"TextBlock","Name":"Txt_Title","Text":"背包"}），插槽可以用简写（见 looseSlot）。少写错、少返工
 */
export function looseWidget(w: any, parentSlot?: SlotType): any {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return w
  const out: any = { Properties: {} }
  for (const [k, v] of Object.entries(w)) {
    const key = KEYS[k.toLowerCase()] ?? k
    if (key === 'Properties' && v && typeof v === 'object') Object.assign(out.Properties, v)
    else if (['Type', 'Name', 'Slot', 'Children', 'Class', 'id'].includes(key)) out[key] = v
    else out.Properties[key] = v
  }
  const def = WIDGETS[out.Type as keyof typeof WIDGETS]
  // 画布里的位置写在了控件上而不是 Slot 里（{"Type":"Image","x":40,"y":32,"w":320,"h":72}）：挪进 Slot
  if (parentSlot === 'CanvasPanelSlot') {
    for (const k of ['anchor', 'x', 'y', 'w', 'h', 'margin']) {
      if (!(k in out.Properties)) continue
      out.Slot = { ...(out.Slot && typeof out.Slot === 'object' ? out.Slot : {}), [k]: out.Properties[k] }
      delete out.Properties[k]
    }
  }
  out.Slot = looseSlot(out.Slot, parentSlot)
  if (Array.isArray(out.Children)) out.Children = out.Children.map((c: any) => looseWidget(c, def?.slot))
  return out
}

/** 新加的控件里写错的地方：不认识的类型、列表控件下预先放的子控件（normalizeTree 会悄悄换掉或丢掉，先告诉 AI） */
function badWidgets(w: any, out: string[] = []): string[] {
  if (w && typeof w === 'object') {
    if (w.Type && !WIDGETS[w.Type as keyof typeof WIDGETS]) out.push(`未知的控件类型 ${w.Type}（${w.Name ?? ''}）`)
    else if (WIDGETS[w.Type as keyof typeof WIDGETS]?.entries && Array.isArray(w.Children) && w.Children.length)
      out.push(
        `${w.Type} 的条目是运行时生成的，不能预先放子控件（${w.Name ?? ''}）：把条目做成子控件，写在 Properties.EntryWidgetClass 里`,
      )
    for (const c of Array.isArray(w.Children) ? w.Children : []) badWidgets(c, out)
  }
  return out
}

const subtreeNames = (w: any, out: string[] = []) => {
  if (w && typeof w === 'object') {
    if (w.Name) out.push(String(w.Name))
    for (const c of Array.isArray(w.Children) ? w.Children : []) subtreeNames(c, out)
  }
  return out
}

/**
 * 应用一个操作；不合法时返回错误（写给 AI 看的），状态不变。
 * 加进来的控件用 normalizeTree 补齐默认属性和插槽，名字不能和树里已有的重复
 */
export function applyOp(s: OpsState, raw: unknown): { state: OpsState } | { error: string } {
  const op = { ...(raw as any) } as DesignOp
  if (!op || typeof op !== 'object' || typeof (op as any).op !== 'string') return { error: '操作要写成 {"op": …}' }
  const comps = s.components
  if (op.op === 'addComponent' && op.component) op.component = { ...op.component, Root: looseWidget(op.component.Root) }
  const bad = badWidgets(op.op === 'addComponent' ? op.component?.Root : undefined)
  if (bad.length) return { error: bad.join('；') }
  if (op.op === 'addComponent') {
    const c = op.component
    if (!c?.Name) return { error: 'addComponent 要写 component.Name' }
    if (comps.some((x) => x.Name === c.Name))
      return { error: `已经有子控件 ${c.Name}，要改它的内容用 "in":"${c.Name}"` }
    return {
      state: {
        ...s,
        components: [
          ...comps,
          { Name: c.Name, DesignSize: c.DesignSize ?? { X: 128, Y: 128 }, Root: normalizeTree(c.Root) },
        ],
      },
    }
  }
  if (op.op === 'removeComponent') {
    if (!comps.some((x) => x.Name === op.name)) return { error: `没有子控件 ${op.name}` }
    // 子控件的动画跟着删
    return {
      state: {
        ...s,
        components: comps.filter((x) => x.Name !== op.name),
        ...(s.animations ? { animations: s.animations.filter((a) => a.in !== op.name) } : {}),
      },
    }
  }
  if (op.op === 'setAnimation') {
    // 同一棵树里同名的动画整个换掉
    const r = looseAnimation(op.animation)
    if ('error' in r) return r
    const a = r.animation
    if (a.in && !comps.some((x) => x.Name === a.in)) return { error: `没有子控件 ${a.in}（in 写子控件名，主界面不写）` }
    const tree = a.in ? comps.find((x) => x.Name === a.in)!.Root : s.root
    const names = allNames(tree)
    const missing = [...new Set(a.tracks.map((t) => t.widget).filter((w) => !names.has(w)))]
    if (missing.length)
      return { error: `${a.in ? `子控件 ${a.in} 里` : '主界面里'}没有这些控件：${missing.join('、')}` }
    if (a.source && !names.has(a.source)) return { error: `触发控件 ${a.source} 不存在` }
    const list = s.animations ?? []
    const i = list.findIndex((x) => x.in === a.in && x.name === a.name)
    return { state: { ...s, animations: i >= 0 ? list.map((x, k) => (k === i ? a : x)) : [...list, a] } }
  }
  if (op.op === 'removeAnimation') {
    const list = s.animations ?? []
    const where = op.in ?? ''
    if (!list.some((x) => x.in === where && x.name === op.name))
      return { error: `${where ? `子控件 ${where} 里` : ''}没有动画 ${op.name}` }
    return { state: { ...s, animations: list.filter((x) => !(x.in === where && x.name === op.name)) } }
  }
  if (op.op === 'resizeComponent') {
    if (!comps.some((x) => x.Name === op.name)) return { error: `没有子控件 ${op.name}` }
    if (!(op.size?.X > 0 && op.size?.Y > 0)) return { error: 'resizeComponent 的 size 要写 {"X","Y"}' }
    return {
      state: { ...s, components: comps.map((x) => (x.Name === op.name ? { ...x, DesignSize: op.size } : x)) },
    }
  }

  // 下面的操作都在一棵树里：主界面或某个子控件
  const where = 'in' in op && op.in ? op.in : ''
  const comp = where ? comps.find((x) => x.Name === where) : undefined
  if (where && !comp) return { error: `没有子控件 ${where}（in 写子控件名，主界面不写 in）` }
  const root = comp ? comp.Root : s.root
  const done = (next: Widget): { state: OpsState } => ({
    state: comp
      ? { ...s, components: comps.map((x) => (x === comp ? { ...x, Root: next } : x)) }
      : { ...s, root: next },
  })
  const inTree = where ? `子控件 ${where} 里` : '主界面里'
  const need = (name: string | undefined) => {
    const w = name ? byName(root, name) : undefined
    return w ?? `${inTree}没有叫 ${name ?? '（空）'} 的控件`
  }

  switch (op.op) {
    case 'set': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const parts = String(op.path ?? '')
        .split('.')
        .filter(Boolean)
      const [head, ...rest] = parts
      // 只写 Properties / Slot 时值是对象，和原来的深合并（工具 update_widget 用）
      const whole = !rest.length && !!op.value && typeof op.value === 'object' && !Array.isArray(op.value)
      if (head === 'Properties' && (rest.length || whole))
        return done(mapWidget(root, w.id, (x) => setPath(x, parts, op.value)))
      if (head === 'Slot' && (rest.length || whole)) {
        if (!w.Slot) return { error: `${w.Name} 是根控件，没有插槽` }
        const parent = findParent(root, w.id)
        const value = whole ? looseSlot(op.value, parent ? WIDGETS[parent.Type].slot : undefined, w.Slot) : op.value
        return done(mapWidget(root, w.id, (x) => setPath(x, parts, value)))
      }
      if (head === 'Class' && w.Type === 'UserWidget')
        return done(mapWidget(root, w.id, (x) => ({ ...x, Class: String(op.value ?? '') })))
      return { error: `set 的 path 要以 Properties. 或 Slot. 开头，例如 "Properties.Text"（${op.target}）` }
    }
    case 'add': {
      const p = need(op.parent)
      if (typeof p === 'string') return { error: p }
      const def = WIDGETS[p.Type]
      if (!def?.slot) return { error: `${p.Type} 不能放子控件（${p.Name}）` }
      const widget = looseWidget(op.widget, def.slot)
      const wrong = badWidgets(widget)
      if (wrong.length) return { error: wrong.join('；') }
      const names = allNames(root)
      const dup = subtreeNames(widget).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const w = normalizeTree(widget, def.slot, new Set(names))
      return done(insertWidget(root, p.id, w, typeof op.index === 'number' ? op.index : undefined))
    }
    case 'remove': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      if (w.id === root.id) return { error: '不能删根控件，要换掉整个界面用 replace' }
      return done(removeWidget(root, w.id))
    }
    case 'move': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const p = need(op.parent)
      if (typeof p === 'string') return { error: p }
      if (w.id === root.id || pathTo(root, p.id).some((x) => x.id === w.id))
        return { error: `不能把 ${w.Name} 移到它自己里面` }
      if (!WIDGETS[p.Type]?.slot) return { error: `${p.Type} 不能放子控件（${p.Name}）` }
      return done(moveWidget(root, w.id, p.id, typeof op.index === 'number' ? op.index : undefined))
    }
    case 'rename': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const name = String(op.name ?? '')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `控件名要用英文、数字和下划线：${name}` }
      if (name !== w.Name && allNames(root).has(name)) return { error: `${inTree}已经有叫 ${name} 的控件` }
      const r = done(mapWidget(root, w.id, (x) => ({ ...x, Name: name })))
      // 动画里引用这个控件的轨道跟着改名
      if (s.animations) r.state.animations = renameInAnimations(s.animations, where, w.Name, name)
      return r
    }
    case 'replace': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const parent = findParent(root, w.id)
      const raw = looseWidget(op.widget, parent ? WIDGETS[parent.Type].slot : undefined)
      const wrong = badWidgets(raw)
      if (wrong.length) return { error: wrong.join('；') }
      const names = allNames(root)
      // 被替换的这棵子树的名字可以重新用
      walk(w, (x) => names.delete(x.Name))
      const dup = subtreeNames(raw).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const next = normalizeTree(
        { ...raw, Slot: raw?.Slot ?? w.Slot },
        parent ? WIDGETS[parent.Type].slot : undefined,
        new Set(names),
      )
      return done(w.id === root.id ? next : mapWidget(root, w.id, () => next))
    }
    case 'duplicate': {
      // 复制一份（连同子控件）：默认放在原来的后面，名字自动加序号；name 给新的根改名
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      if (w.id === root.id) return { error: '不能复制根控件' }
      const p = op.parent ? need(op.parent) : findParent(root, w.id)
      if (typeof p === 'string') return { error: p }
      if (!p || !WIDGETS[p.Type]?.slot) return { error: `${p?.Name ?? ''} 不能放子控件` }
      if (WIDGETS[p.Type].children === 'one' && p.Children?.length) return { error: `${p.Name} 只能放一个子控件` }
      const names = allNames(root)
      if (op.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.name))
        return { error: `控件名要用英文、数字和下划线：${op.name}` }
      if (op.name && names.has(op.name)) return { error: `${inTree}已经有叫 ${op.name} 的控件` }
      const c = cloneWidget(w, names)
      if (op.name) c.Name = op.name
      const at =
        typeof op.index === 'number'
          ? op.index
          : p.id === findParent(root, w.id)?.id
            ? p.Children!.findIndex((x) => x.id === w.id) + 1
            : undefined
      return done(insertWidget(root, p.id, c, at))
    }
    case 'wrap': {
      // 外面套一层面板：新面板接过原来的位置和大小
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const type = String(op.type ?? '') as WidgetType
      if (!WIDGETS[type]?.slot)
        return { error: `wrap 的 type 要是能放子控件的面板（例如 Overlay、SizeBox、Border），不能是 ${type}` }
      const names = allNames(root)
      if (op.name && names.has(op.name)) return { error: `${inTree}已经有叫 ${op.name} 的控件` }
      const r = wrapWidget(root, w.id, type, names)
      if (r.root === root) return { error: `${type} 不能用来包裹控件` }
      return done(op.name ? mapWidget(r.root, r.id, (x) => ({ ...x, Name: op.name! })) : r.root)
    }
    default:
      return { error: `不认识的操作 ${(op as any).op}` }
  }
}

/** 依次应用；出错的操作跳过，错误带上序号 */
export function applyOps(s: OpsState, ops: unknown[]): { state: OpsState; errors: string[] } {
  let cur = s
  const errors: string[] = []
  ops.forEach((op, i) => {
    const r = applyOp(cur, op)
    if ('error' in r) errors.push(`ops[${i}]：${r.error}`)
    else cur = r.state
  })
  return { state: cur, errors }
}
