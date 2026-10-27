/**
 * 开发者模式的「元素抓取」：把选中的界面元素写成一段给 AI 看的引用，放进输入框（引用卡片，见 quote.ts）。
 *
 * 位置来自构建时写进 DOM 的 data-src="相对 web/src 的路径:行号:组件名"（scripts/lib/source-loc.mjs），
 * 组件层级是抓取时沿 React fiber 往上收集的各层 data-src。这里只放纯逻辑（解析、去重、拼文字），
 * 读 DOM 的部分在 components/chat/ElementPicker.tsx
 */
import { chipMarker } from '@shared/composer'
import { clip } from '@shared/text'

/** data-src 里的一处位置 */
export interface SourceLoc {
  /** 仓库根目录下的路径，如 web/src/components/chat/ChatComposer.tsx */
  file: string
  line: number
  /** 所在组件（或 hook）的名字；顶层代码里的标签没有 */
  component?: string
}

/** 抓取到的元素信息：ElementPicker 从 DOM 读出来交给 formatElementRef */
export interface ElementInfo {
  tag: string
  /** 值得写出来的属性（id、role、aria-label、title、placeholder、type、name、href…） */
  attrs: [string, string][]
  className: string
  text: string
  width: number
  height: number
  /** 元素自己或最近外层原生标签的位置；inherited 表示元素本身没有（第三方组件渲染的），取的是外层 */
  source?: SourceLoc & { inherited?: boolean }
  /** 由内到外经过的组件，每个组件只留最里面那处位置 */
  chain: SourceLoc[]
  selector: string
  /** 关键计算样式，已去掉默认值 */
  styles: [string, string][]
  /** 页面地址里 # 之后的部分（或路径） */
  page: string
  /** 在 UI 设计画布里时：控件 id 和类型 */
  widget?: { id: string; type?: string }
}

const SRC_ROOT = 'web/src/'

/** 解析 data-src；格式不对返回 undefined */
export function parseLoc(raw: string | null | undefined): SourceLoc | undefined {
  const m = raw ? /^(.+?\.tsx):(\d+)(?::([\w$]+))?$/.exec(raw) : null
  if (!m) return undefined
  return { file: SRC_ROOT + m[1], line: Number(m[2]), component: m[3] || undefined }
}

/**
 * 组件层级：由内到外的各层位置里，同一个组件连着出现只留最里面那处（离元素最近、最能定位），
 * 没有组件名的（文件顶层的标签）不进层级。最多留 max 层，再往外是路由、布局，对定位没用
 */
export function componentChain(locs: readonly SourceLoc[], max = 6): SourceLoc[] {
  const out: SourceLoc[] = []
  for (const l of locs) {
    if (!l.component) continue
    const last = out[out.length - 1]
    if (last && last.component === l.component && last.file === l.file) continue
    out.push(l)
    if (out.length >= max) break
  }
  return out
}

const at = (l: SourceLoc) => `${l.file}:${l.line}`
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 卡片摘要用的一句话：标签、文字、组件 */
function headline(info: ElementInfo) {
  const text = oneLine(info.text)
  const label = text
    ? `「${clip(text, 16)}」`
    : (info.attrs.find(([k]) => k === 'aria-label' || k === 'title' || k === 'placeholder')?.[1] ?? '')
  const comp = info.widget ? info.widget.type : (info.source?.component ?? info.chain[0]?.component)
  // 组件名放最前面：卡片上只显示前 40 个字，组件名比标签名更能看出是哪里
  return [comp ? `${comp} ·` : '', `<${info.tag}>`, label].filter(Boolean).join(' ')
}

/**
 * 拼成给 AI 的引用文字。第一行是摘要（引用卡片上显示它）；面板自己的界面写清源码位置和组件层级，
 * UI 设计画布里的控件写控件 id，让 AI 用设计工具改，不去动面板源码
 */
export function formatElementRef(info: ElementInfo): string {
  const lines: string[] = []
  const attrs = info.attrs.map(([k, v]) => ` ${k}="${clip(oneLine(v), 80)}"`).join('')
  const element = `<${info.tag}${attrs}>，${Math.round(info.width)}×${Math.round(info.height)}`
  const text = clip(oneLine(info.text), 200)
  if (info.widget) {
    lines.push(`UI 设计控件 ${headline(info)}`)
    lines.push('这是 UI 设计画布里的控件，请用 UI 设计工具修改这个控件，不要改面板源码：')
    lines.push(`- 控件 id：${info.widget.id}${info.widget.type ? `（类型 ${info.widget.type}）` : ''}`)
  } else {
    lines.push(`界面元素 ${headline(info)}`)
    lines.push('这是 Agent 面板（agent-panel）自己的界面，路径相对仓库根目录：')
    if (info.source) {
      const comp = info.source.component ? `，组件 ${info.source.component}` : ''
      const note = info.source.inherited ? '，元素由第三方组件渲染，这是外层最近的标签' : ''
      lines.push(`- 源码：${at(info.source)}${comp}${note}`)
    } else {
      lines.push('- 源码：没找到位置标记（可能是第三方组件或浏览器自带的元素），按下面的文字和 class 搜索')
    }
    if (info.chain.length) {
      lines.push(`- 组件层级（由内到外）：${info.chain.map((l) => `${l.component} ${at(l)}`).join(' ← ')}`)
    }
  }
  lines.push(`- 元素：${element}`)
  if (text) lines.push(`- 文字：${text}`)
  if (info.className.trim()) lines.push(`- class：${clip(oneLine(info.className), 300)}`)
  if (info.selector) lines.push(`- 选择器：${info.selector}`)
  if (info.styles.length) lines.push(`- 计算样式：${info.styles.map(([k, v]) => `${k} ${v}`).join('；')}`)
  if (info.page) lines.push(`- 页面：${info.page}`)
  return lines.join('\n')
}

/** 计算样式里默认值的那些不写，免得一长串 0px、normal 淹没真正有用的 */
const BORING = new Set(['0px', 'none', 'normal', 'auto', 'rgba(0, 0, 0, 0)', 'transparent', 'static', 'visible'])

/** 要写给 AI 的样式：字号同时给 rem（项目约定字号写 rem），其余去掉默认值 */
export function pickStyles(get: (prop: string) => string, rootPx: number): [string, string][] {
  const out: [string, string][] = []
  const add = (k: string, v: string) => {
    if (v && !BORING.has(v)) out.push([k, v])
  }
  add('display', get('display'))
  add('position', get('position'))
  const fs = get('font-size')
  const px = parseFloat(fs)
  if (px && rootPx) out.push(['font-size', `${fs}（${+(px / rootPx).toFixed(4)}rem）`])
  add('font-weight', get('font-weight') === '400' ? '' : get('font-weight'))
  add('line-height', get('line-height'))
  add('color', get('color'))
  add('background-color', get('background-color'))
  for (const k of ['padding', 'margin', 'gap', 'border-radius', 'border', 'opacity']) {
    const v = get(k)
    // border 默认是「0px none rgb(…)」，透明度默认是 1
    if (k === 'border' && /^0px/.test(v)) continue
    if (k === 'opacity' && v === '1') continue
    add(k, v)
  }
  return out
}

/**
 * 元素引用的包装标记：复制出去时在引用前后各加一行（头标记和正文同一行，尾标记独占一行），
 * 粘回任何对话输入框时认出来还原成引用卡片。标记本身人眼可读，去掉标记后和原文一模一样，
 * 所以粘到记事本、微信里也还是一段正常的说明文字
 */
export const ELEMENT_REF_MARK = { head: '[元素引用]', tail: '[/元素引用]' } as const

/** 这条文字是不是 formatElementRef 的输出：第一行是摘要，并且有一行「- 元素：」 */
export function isElementRefText(text: string): boolean {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return false
  if (!/^(界面元素|UI 设计控件) /.test(lines[0])) return false
  return lines.some((l) => /^- 元素：<[^\s>]+/.test(l))
}

/** 把引用包成可还原的形式；已经包过的、空的不重复包 */
export function wrapElementRef(text: string): string {
  if (!text.trim() || isWrapped(text)) return text
  return `${ELEMENT_REF_MARK.head}${text}\n${ELEMENT_REF_MARK.tail}`
}

const isWrapped = (text: string) =>
  text.startsWith(ELEMENT_REF_MARK.head) && text.trimEnd().endsWith(ELEMENT_REF_MARK.tail)

/** 一段文字里的一条元素引用：位置是它在原文里的 [起, 止)，text 是去掉标记后的原文 */
export interface ElementRefHit {
  start: number
  end: number
  text: string
}

/**
 * 找出文字里所有带标记的元素引用。标记要成对、内部确实是元素引用（isElementRefText）才算，
 * 只复制了一半、或者只是讲这个标记写法时按普通文字处理，不会被吃掉
 */
export function parseElementRef(value: string): ElementRefHit[] {
  const out: ElementRefHit[] = []
  const head = ELEMENT_REF_MARK.head
  const tail = ELEMENT_REF_MARK.tail
  let at = 0
  for (;;) {
    const h = value.indexOf(head, at)
    if (h < 0) break
    const t = value.indexOf(tail, h + head.length)
    if (t < 0) break
    const text = value.slice(h + head.length, t).replace(/\n$/, '')
    // 这一段不是引用（例如前面先粘了半截头标记、或者是讲标记写法）：只跳过这个头标记，
    // 不能直接跳到这里的尾标记——那会把紧跟在后面真的成对的引用整段吞掉
    if (!isElementRefText(text)) {
      at = h + head.length
      continue
    }
    at = t + tail.length
    out.push({ start: h, end: at, text })
  }
  return out
}

/**
 * 粘贴进来的文字里的元素引用换成卡片标记后的结果：text 是要插进输入框的文字，
 * made 是换成卡片的块数，kept 是没换成、原文照旧留在 text 里的块数（超了附件上限、拿不到卡片名）
 */
export interface PasteElementRefsResult {
  text: string
  made: number
  kept: number
}

/**
 * 粘贴进来的文字里有元素引用时，把每块引用换成卡片标记（名字由 quoteOf 给出：它负责存原文、起卡片名），
 * 其余文字原样留在原位。一段引用都没认出来时返回 undefined，交给原来的粘贴流程
 *
 * limit：这次最多换几块（还要留几张卡片的位置）。同一次粘贴里连续建卡片，附件计数不会及时更新，
 * 不在这里卡住就会超过输入框的附件上限，那张消息最后发不出去；超出的引用原文留在输入框里，不丢内容
 */
export function pasteElementRefs(
  value: string,
  quoteOf: (ref: string) => string | undefined,
  limit = Infinity,
): PasteElementRefsResult | undefined {
  const hits = parseElementRef(value)
  if (!hits.length) return undefined
  let out = ''
  let last = 0
  let made = 0
  for (const hit of hits) {
    const name = made < limit ? quoteOf(hit.text) : undefined
    if (!name) continue
    out += value.slice(last, hit.start)
    // 卡片两边留空格，和在输入框里插卡片一样，不跟文字粘在一起
    if (out && !/\s$/.test(out)) out += ' '
    out += chipMarker('quote', name)
    last = hit.end
    // 后面还有文字时才隔一个空格；引用在末尾时不要凭空多一个尾空格
    const rest = value.slice(last)
    if (rest && !/^\s/.test(rest)) out += ' '
    made++
  }
  // made=0 时 text 就是原文，调用方不拦阻粘贴，交给原来的流程（原文不丢，超长/路径还能正常处理）
  return { text: out + value.slice(last), made, kept: hits.length - made }
}
