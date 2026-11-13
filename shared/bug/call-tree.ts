/**
 * 调用栈树（设计稿 2026-11-13「诊断报告：关键调用栈」）：档案里扁平的 stack（parent 连成树）和 Markdown 里的
 * `calltree` 代码块之间互转。诊断报告、对话里的回复都写成 `calltree` 代码块，界面只有一条渲染路径
 * （web/src/lib/markdown/call-tree.ts）；导出成 Markdown、贴进 Issue 时就是这段缩进文本，没装面板也读得懂。
 *
 * 文本格式（一行一跳，缩进表示层级）：
 *   onDelete  web/src/cart/CartPage.tsx:88  — 点删除  {L1+}
 *     ! if (left === 0) return  web/src/cart/store.ts:51  — 剩 0 件提前返回  <left === 0 → 真>  [left=0 => 1]  {H1}
 *       |>51 if (left === 0) return
 *     ~ emit('cart:change')  web/src/cart/store.ts:52  — 没走到  {L3-}
 *       => 事件 cart:change
 *       ? 现象：角标停在 1  web/src/cart/Badge.tsx:15
 *   --- 断在这里：L3 之后没有 L4
 * 行首记号：> 入口、! 出错点、~ 没走到、? 现象、- 旁支（不写就是路过）；=> 下一跳前面的边界说明；
 * | / |> 挂在上一跳下面的代码（|> 是出错那一行）；--- 一条分隔说明；% 开头的是树上方的说明。两个以上空格隔开的尾巴：
 * `— 说明`、`<条件 → 走了哪边>`、`[名字=实际 => 期望]`、`{编号}`（L1+ 打出来了、L3- 该打没打、L4? 还没复现）、
 * `#fix:A`（选定的方案 A 改这里）、`#alt:B`（没选的方案 B 改这里）、`#nomatch`（位置没对上代码）、`#frame`（对上了报错堆栈的一帧）
 */
import type { BugHop } from './diagnosis-schema.ts'

export type CallRole = BugHop['role']
export type CallRef = { id: string; hit?: boolean; wait?: boolean }
export type CallValue = { name: string; actual: string; expected: string }
export type CallCode = { line?: number; text: string; mark: boolean }

/** 解析出来的一跳 */
export interface CallNode {
  role: CallRole
  fn: string
  file: string
  line?: number
  note: string
  edge: string
  cond?: { text: string; took: string }
  values: CallValue[]
  refs: CallRef[]
  tags: string[]
  code: CallCode[]
  children: CallItem[]
}
/** 树上的一项：一跳，或者一条分隔说明（「断在这里」） */
export type CallItem = { kind: 'node'; node: CallNode } | { kind: 'cut'; text: string }

const MARK: Record<string, CallRole> = { '>': 'entry', '!': 'fault', '~': 'missed', '?': 'symptom', '-': 'side' }
const MARK_OF: Partial<Record<CallRole, string>> = { entry: '>', fault: '!', missed: '~', symptom: '?', side: '-' }

/** 位置：带扩展名或目录的路径，可选 :行号（:列号丢掉） */
const LOC = /^([^\s()]*?(?:\/|\\|\.[A-Za-z0-9]{1,8})[^\s()]*?)(?::(\d+))?(?::\d+)?$/

const indentOf = (s: string) => s.length - s.trimStart().length

function splitValue(v: string): CallValue {
  const [left, expected = ''] = v.split(/\s*=>\s*/, 2)
  const eq = left.indexOf('=')
  return eq > 0
    ? { name: left.slice(0, eq).trim(), actual: left.slice(eq + 1).trim(), expected: expected.trim() }
    : { name: '', actual: left.trim(), expected: expected.trim() }
}

function parseRef(r: string): CallRef {
  const m = /^(.*?)([+\-?])?$/.exec(r.trim())!
  const s = m[2]
  return { id: m[1], ...(s === '+' ? { hit: true } : s === '-' ? { hit: false } : s === '?' ? { wait: true } : {}) }
}

/** 一跳那一行：先剥掉两个空格以上隔开的尾巴，剩下的「函数  位置」再拆 */
function parseNodeLine(body: string, role: CallRole): CallNode {
  const node: CallNode = {
    role,
    fn: '',
    file: '',
    note: '',
    edge: '',
    values: [],
    refs: [],
    tags: [],
    code: [],
    children: [],
  }
  let rest = body
  // 尾巴都在两个以上空格之后：函数名里的 [0]、{ count } 不受影响
  // 标记（#fix:A）前面一个空格就够
  const tail = /(?:\s{2,}(\{[^{}]*\}|\[[^[\]]*\]|<[^<>]*>)|\s+(#[\w:-]+))\s*$/
  for (let m = tail.exec(rest); m; m = tail.exec(rest)) {
    const t = m[1] ?? m[2]
    rest = rest.slice(0, m.index)
    if (t.startsWith('{'))
      node.refs.unshift(
        ...t
          .slice(1, -1)
          .split(/[\s,，]+/)
          .filter(Boolean)
          .map(parseRef),
      )
    else if (t.startsWith('[')) node.values.unshift(splitValue(t.slice(1, -1)))
    else if (t.startsWith('<')) {
      const [text, took = ''] = t.slice(1, -1).split(/\s*(?:→|->)\s*/, 2)
      node.cond = { text: text.trim(), took: took.trim() }
    } else node.tags.unshift(t.slice(1))
  }
  const dash = /\s+[—–]\s+/.exec(rest)
  if (dash) {
    node.note = rest.slice(dash.index + dash[0].length).trim()
    rest = rest.slice(0, dash.index)
  }
  const parts = rest.trim().split(/\s{2,}/)
  const last = parts.length > 1 ? LOC.exec(parts.at(-1)!) : null
  if (last) {
    parts.pop()
    node.file = last[1]
    node.line = last[2] ? Number(last[2]) : undefined
  }
  node.fn = parts.join('  ').trim()
  return node
}

/** `calltree` 代码块解析的结果：树和树上方的说明（`% ` 开头的行） */
export type CallTree = { items: CallItem[]; caption: string[] }

/** `calltree` 代码块 → 树。认不出的行当成一跳显示，不让整块消失 */
export function parseCallTree(text: string): CallTree {
  const roots: CallItem[] = []
  const caption: string[] = []
  // 栈里是每一层的缩进和它的子项数组
  const stack: { indent: number; items: CallItem[]; node?: CallNode }[] = [{ indent: -1, items: roots }]
  let edge = ''
  let last: CallNode | undefined
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue
    const indent = indentOf(raw)
    const line = raw.trim()
    if (line.startsWith('% ')) {
      caption.push(line.slice(2).trim())
      continue
    }
    if (line.startsWith('|')) {
      if (!last) continue
      const m = /^\|(>?)\s?(\d+)?\s?(.*)$/.exec(line)!
      last.code.push({ mark: m[1] === '>', line: m[2] ? Number(m[2]) : undefined, text: m[3] })
      continue
    }
    if (line.startsWith('=>')) {
      edge = line.slice(2).trim()
      continue
    }
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    if (line.startsWith('---')) {
      stack.at(-1)!.items.push({ kind: 'cut', text: line.replace(/^-+\s*/, '') })
      continue
    }
    const mark = /^([>!~?-])\s+/.exec(line)
    const role = mark ? MARK[mark[1]] : stack.length === 1 ? 'entry' : 'path'
    const node = parseNodeLine(mark ? line.slice(mark[0].length) : line, role)
    node.edge = edge
    edge = ''
    stack.at(-1)!.items.push({ kind: 'node', node })
    stack.push({ indent, items: node.children, node })
    last = node
  }
  return { items: roots, caption }
}

/** 一跳在树里要显示的附加信息（面板算的）：日志命中、方案改这里、对上报错堆栈的帧 */
export interface HopExtra {
  /** 日志点编号 → 打出来了没有（没贴日志时不传） */
  hits?: Map<string, boolean>
  /** 候选方案改在哪几跳：跳的 id → 方案编号；chosen 是选定的那个（画成「改这里」，别的方案画成灰的） */
  fix?: Map<string, string[]>
  chosen?: string
  /** 每跳挂的日志点、假设（按 hop 字段或 file:line 对上的） */
  attach?: Map<string, string[]>
  /** 在哪一跳前面画「断在这里」（日志打到前一跳，这一跳该打没打） */
  cut?: { before: string; text: string }
  /** 树上方的说明（调用栈从哪来、对上了几帧），写成 `% ` 开头的行 */
  caption?: string[]
}

/**
 * 扁平的 stack → 每一跳的子项。旧数据没有 id / parent：按顺序当一条直线（每一跳的父亲是上一跳）。
 * parent 写错（不存在、成环）的挂到根上，不丢
 */
export function hopTree(hops: BugHop[]): { roots: BugHop[]; kids: Map<BugHop, BugHop[]> } {
  const legacy = hops.every((h) => !h.id && !h.parent)
  const byId = new Map(hops.filter((h) => h.id).map((h) => [h.id, h]))
  const kids = new Map<BugHop, BugHop[]>()
  const roots: BugHop[] = []
  hops.forEach((h, i) => {
    let p = legacy ? hops[i - 1] : byId.get(h.parent)
    // 成环：沿 parent 往上走回到自己就当根
    for (let q = p, n = 0; q && n <= hops.length; q = byId.get(q.parent), n++) if (q === h) p = undefined
    if (p && p !== h) kids.set(p, [...(kids.get(p) ?? []), h])
    else roots.push(h)
  })
  return { roots, kids }
}

/** 入口到出错点、再到现象的主路径上的跳（根因页默认只看它，旁支收起） */
export function mainPath(hops: BugHop[]): Set<BugHop> {
  const { roots, kids } = hopTree(hops)
  const parent = new Map<BugHop, BugHop>()
  for (const [p, cs] of kids) for (const c of cs) parent.set(c, p)
  const on = new Set<BugHop>()
  for (const h of hops)
    if (h.role === 'fault' || h.role === 'symptom' || h.role === 'missed')
      for (let q: BugHop | undefined = h; q && !on.has(q); q = parent.get(q)) on.add(q)
  if (!on.size) roots.forEach((r) => on.add(r))
  return on
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
/** 写进尾巴里的文字不能带括号本身，换成全角的 */
const safe = (s: string, open: string, close: string) => clean(s).split(open).join('（').split(close).join('）')
const at = (h: Pick<BugHop, 'file' | 'line'>) =>
  h.file ? `${h.file.replace(/\s/g, '')}${h.line ? `:${h.line}` : ''}` : ''

function hopLine(h: BugHop, x: HopExtra, depth: number): string {
  const refs = [...h.refs, ...(x.attach?.get(h.id) ?? [])]
    .filter((r, i, a) => r && a.indexOf(r) === i)
    .map((r) => {
      const hit = x.hits?.get(r)
      return hit === undefined ? (x.hits && /^L\d/.test(r) ? `${r}?` : r) : `${r}${hit ? '+' : '-'}`
    })
  const tags = [
    ...(x.fix?.get(h.id) ?? []).map((o) => `#${o === x.chosen ? 'fix' : 'alt'}:${o.replace(/[^\w-]/g, '')}`),
    ...(h.check && !h.check.ok ? ['#nomatch'] : []),
    ...(h.check?.frame ? ['#frame'] : []),
  ]
  return [
    // 根上的入口不用写记号（解析时根默认就是入口）
    `${MARK_OF[h.role] && !(depth === 0 && h.role === 'entry') ? `${MARK_OF[h.role]} ` : ''}${clean(h.fn) || '?'}`,
    at(h),
    h.note.trim() ? `— ${clean(h.note)}` : '',
    h.cond?.text.trim()
      ? `<${safe(h.cond.text, '<', '>')}${h.cond.took.trim() ? ` → ${safe(h.cond.took, '<', '>')}` : ''}>`
      : '',
    ...h.values.map(
      (v) =>
        `[${safe(v.name ? `${v.name}=${v.actual}` : v.actual, '[', ']')}${v.expected.trim() ? ` => ${safe(v.expected, '[', ']')}` : ''}]`,
    ),
    refs.length ? `{${refs.join(' ')}}` : '',
    ...tags,
  ]
    .filter(Boolean)
    .join('  ')
}

/** 档案里的 stack → `calltree` 代码块的内容（不带围栏） */
export function hopsToCallTree(hops: BugHop[], x: HopExtra = {}): string {
  const { roots, kids } = hopTree(hops)
  const out: string[] = []
  const walk = (h: BugHop, depth: number) => {
    const pad = '  '.repeat(depth)
    if (x.cut && h.id === x.cut.before) out.push(`${pad}--- ${clean(x.cut.text)}`)
    if (depth && h.edge !== 'call') out.push(`${pad}=> ${clean(h.edgeNote) || EDGE_TEXT[h.edge]}`)
    out.push(pad + hopLine(h, x, depth))
    const c = h.role === 'fault' ? h.check : undefined
    if (c?.code)
      c.code.split('\n').forEach((l, i) => {
        const n = (c.start ?? 0) + i
        out.push(`${pad}  |${c.start && n === h.line ? '>' : ' '}${c.start ? n : ''} ${l}`)
      })
    for (const k of kids.get(h) ?? []) walk(k, depth + 1)
  }
  for (const c of x.caption ?? []) if (c.trim()) out.push(`% ${clean(c)}`)
  roots.forEach((r) => walk(r, 0))
  return out.join('\n')
}

/** 边界没写说明时的默认字样（给 Agent 和导出看的文本，不翻译） */
const EDGE_TEXT: Record<BugHop['edge'], string> = {
  call: '',
  async: '异步',
  event: '事件',
  ipc: '跨进程',
  lib: '库内部',
}
