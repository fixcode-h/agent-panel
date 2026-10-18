import {
  WIDGETS,
  allNames,
  deepMerge,
  findParent,
  insertWidget,
  mapWidget,
  moveWidget,
  normalizeTree,
  pathTo,
  removeWidget,
  walk,
  type Component,
  type Widget,
} from './umg.ts'

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
  | { op: 'addComponent'; component: { Name: string; DesignSize?: { X: number; Y: number }; Root: unknown } }
  | { op: 'removeComponent'; name: string }
  | { op: 'resizeComponent'; name: string; size: { X: number; Y: number } }

export interface OpsState {
  root: Widget
  components: Component[]
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
  const op = raw as DesignOp
  if (!op || typeof op !== 'object' || typeof (op as any).op !== 'string') return { error: '操作要写成 {"op": …}' }
  const comps = s.components
  const bad = badWidgets(
    op.op === 'add' || op.op === 'replace' ? op.widget : op.op === 'addComponent' ? op.component?.Root : undefined,
  )
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
    return { state: { ...s, components: comps.filter((x) => x.Name !== op.name) } }
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
        return done(mapWidget(root, w.id, (x) => setPath(x, parts, op.value)))
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
      const names = allNames(root)
      const dup = subtreeNames(op.widget).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const w = normalizeTree(op.widget, def.slot, new Set(names))
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
      return done(mapWidget(root, w.id, (x) => ({ ...x, Name: name })))
    }
    case 'replace': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const parent = findParent(root, w.id)
      const names = allNames(root)
      // 被替换的这棵子树的名字可以重新用
      walk(w, (x) => names.delete(x.Name))
      const dup = subtreeNames(op.widget).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const raw = op.widget as any
      const next = normalizeTree(
        { ...raw, Slot: raw?.Slot ?? w.Slot },
        parent ? WIDGETS[parent.Type].slot : undefined,
        new Set(names),
      )
      return done(w.id === root.id ? next : mapWidget(root, w.id, () => next))
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
