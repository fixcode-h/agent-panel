/**
 * 开发者模式的「元素抓取」：把选中的界面元素写成一段给 AI 看的引用，放进输入框（引用卡片，见 quote.ts）。
 *
 * 位置来自构建时写进 DOM 的 data-src="相对 web/src 的路径:行号:组件名"（scripts/lib/source-loc.mjs），
 * 组件层级是抓取时沿 React fiber 往上收集的各层 data-src。这里只放纯逻辑（解析、去重、拼文字），
 * 读 DOM 的部分在 components/chat/ElementPicker.tsx
 */

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
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
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
 * 元素引用的包装标记：抓取到的引用复制出去（剪贴板、写文件）时前后各加一行，
 * 粘回任何对话输入框时认出来还原成引用卡片。标记本身人眼可读，去掉标记后和原文一模一样，
 * 所以粘到记事本、微信里也还是一段正常的说明文字。
 *
 * 这一段的归属是「元素引用可复制粘贴到其他对话」那个改动（parseElementRef / pasteElementRefs 也在那边），
 * 这里只先补上抓取后写剪贴板要用到的两个；合并时以那边的实现为准，不要各留一份
 */
export const ELEMENT_REF_MARK = { head: '[元素引用]', tail: '[/元素引用]' } as const

const isWrapped = (text: string) =>
  text.startsWith(ELEMENT_REF_MARK.head) && text.trimEnd().endsWith(ELEMENT_REF_MARK.tail)

/** 把引用包成可还原的形式；已经包过的、空的不重复包 */
export function wrapElementRef(text: string): string {
  if (!text.trim() || isWrapped(text)) return text
  return `${ELEMENT_REF_MARK.head}${text}\n${ELEMENT_REF_MARK.tail}`
}
