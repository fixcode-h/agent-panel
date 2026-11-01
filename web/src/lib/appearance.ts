import { Appearance, type Palette } from '@shared/schema'
import { applyMarkdownStyle } from './markdown-style'

const CJK = {
  noto: ["'Noto Sans SC'", "'PingFang SC'", "'Microsoft YaHei UI'", "'Microsoft YaHei'"],
  // Maple Mono CN 只打了 400、500 两档（没有更粗的），600 以上的标题浏览器拿 500 加粗画；缺字再落到系统中文
  maple: ["'Maple Mono CN'", "'PingFang SC'", "'Microsoft YaHei UI'", "'Microsoft YaHei'"],
  // 系统字体不列内置中文字体：它们的 @font-face 只在选中时才加载（见 ensureCjkFont），
  // 列在这里只会让浏览器去匹配一个没加载的字体；本机真没有中文字体时交给 system-ui 兜底
  // 雅黑 UI 放在雅黑前：同一套字形，但行距更紧、小字号在低分辨率屏上的 hinting 更清楚
  system: ["'PingFang SC'", "'Microsoft YaHei UI'", "'Microsoft YaHei'", "'Hiragino Sans GB'"],
}
const UI = {
  inter: ["'Inter Variable'", "'Inter'"],
  maple: ["'Maple Mono NL'"],
  plex: ["'IBM Plex Sans'"],
  // 和 Claude Code 桌面版一样用系统界面字体：Windows 是 Segoe UI，macOS 是苹方配 SF
  system: ['-apple-system', 'BlinkMacSystemFont', "'Segoe UI'"],
}
const MONO = {
  maple: ["'Maple Mono NL'", "'JetBrains Mono Variable'"],
  jetbrains: ["'JetBrains Mono Variable'", "'JetBrains Mono'"],
}

/** 字体名里有引号、逗号之类的会把整个字体列表弄坏，只留安全的字符 */
const quote = (name: string) => {
  const n = name.replace(/["'\\;{}<>]/g, '').trim()
  return n ? `'${n}'` : ''
}

/** 设置换成 CSS 变量：Tailwind 的 font-sans / font-mono 读 --app-sans / --app-mono（index.css） */
export function appearanceVars(a: Appearance): Record<string, string> {
  const custom = a.customFont.split(',').map(quote).filter(Boolean)
  // 英文字体在前、中文字体在后：英文字体里没有汉字，浏览器自动用后面的中文字体
  const sans = [...custom, ...UI[a.uiFont], ...CJK[a.cjkFont], 'system-ui', 'sans-serif']
  const mono = [...MONO[a.monoFont], ...CJK[a.cjkFont], 'ui-monospace', 'Consolas', 'monospace']
  return {
    '--app-sans': sans.join(', '),
    '--app-mono': mono.join(', '),
    // 根字号按比例缩放：界面里的字号都是 rem，间距固定用像素（--spacing），所以只有字变大
    'font-size': `${(16 * a.fontSize) / 14}px`,
    '--app-tracking': `${a.letterSpacing}em`,
    '--app-word-spacing': `${a.wordSpacing}em`,
    '--app-leading': String(a.lineHeight),
    '--fg-level': `${a.darkTextLevel}%`,
    '--panel-radius': `${a.panelRadius}px`,
  }
}

const cjkLoad: Partial<Record<Appearance['cjkFont'], Promise<unknown>>> = {}

/** 中文字体选的是内置字体（思源黑体 / Maple Mono CN）时，才需要它的 @font-face */
export const needsCjkFont = (cjkFont: Appearance['cjkFont']) => cjkFont !== 'system'

/**
 * 内置中文字体的 @font-face 各在一个 CSS 里（按 unicode-range 分片）：选了哪个才加载哪个。
 * 思源黑体在 fonts-cjk.css，Maple Mono CN 在 fonts-cjk-maple.css。
 * 判定看设置里的 cjkFont 字段，**不从生成的字体列表里搜字体名**：
 * 那样会在选「系统字体」时也命中（不加载就等于白下载几百条声明）。
 */
export function ensureCjkFont(cjkFont: Appearance['cjkFont']) {
  if (cjkLoad[cjkFont] || !needsCjkFont(cjkFont)) return
  // 加载失败（产物里少了这个 CSS）就退回字体列表里的系统中文，不报错：这是纯性能优化，退化只影响字形
  cjkLoad[cjkFont] = (cjkFont === 'maple' ? import('../fonts-cjk-maple.css') : import('../fonts-cjk.css')).catch(
    () => null,
  )
}

/** 记下的配色：index.html 加载时先套上，免得设置取回来前闪一下默认配色 */
const PALETTE_KEY = 'appearance-palette'

/**
 * 配色挂在 html 的 data-palette 上，index.css 按它选覆盖块。「Claude」配色是 index.css 里 :root 的基础值，不挂属性；
 * 默认的「Claude Code」和其他几套都挂
 */
export function applyPalette(p: Palette) {
  const el = document.documentElement
  if (p === 'claude') delete el.dataset.palette
  else el.dataset.palette = p
}

/** 记下的中文字体选择：index.html 存的那份是 CSS 变量，取不出这个字段，单独记一个 */
const CJK_KEY = 'appearance-cjk'

/** 设置还没取回来时先按上次的选择判一次，免得设置回来才换字体、闪一下 */
export function primeCjkFont() {
  try {
    // 没记过（新装）就按默认的思源黑体先加载
    const cjk = localStorage.getItem(CJK_KEY) ?? Appearance.parse({}).cjkFont
    if (cjk === 'noto' || cjk === 'maple' || cjk === 'system') ensureCjkFont(cjk)
  } catch {
    // 浏览器不让读就算了，设置取回来后 applyAppearance 会再判一次
  }
}

/** 上一次真正写到页面上的各部分：没变的部分不重写（拖滑块时每一格都会调用，重写 Markdown 样式表很贵） */
let applied = { vars: '', palette: '', md: '', all: '' }
/** 设置页里最近一次本地改外观的时间：拖动期间自动保存回来的旧值不能把页面拉回去 */
let localAt = 0

/** 应用到页面，并记在浏览器里：index.html 加载时先用记下的，免得设置取回来前闪一下默认字体 */
export function applyAppearance(a: Appearance | undefined) {
  const parsed = Appearance.parse(a ?? {})
  const all = JSON.stringify(parsed)
  if (all === applied.all) return
  applied.all = all
  const vars = appearanceVars(parsed)
  // 中文字体选了内置字体时才去加载它的分片
  ensureCjkFont(parsed.cjkFont)
  const varsKey = JSON.stringify(vars)
  if (varsKey !== applied.vars) {
    applied.vars = varsKey
    const root = document.documentElement.style
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
  }
  if (parsed.palette !== applied.palette) {
    applied.palette = parsed.palette
    applyPalette(parsed.palette)
  }
  const mdKey = JSON.stringify([parsed.markdown, parsed.components])
  if (mdKey !== applied.md) {
    applied.md = mdKey
    applyMarkdownStyle(parsed.markdown, parsed.components)
  }
  try {
    localStorage.setItem('appearance', varsKey)
    localStorage.setItem(PALETTE_KEY, parsed.palette)
    localStorage.setItem(CJK_KEY, parsed.cjkFont)
  } catch {
    // 浏览器不让存就算了，只是加载时会闪一下
  }
}

/**
 * 设置页里改外观（拖滑块、选配色、开关）：立即应用，并记下时间，见 applySavedAppearance。
 * 拖滑块时的节流在滑块自己那里做（每帧最多交一次），这里不再延后，开关、按钮点完马上就能看到
 */
export function applyLocalAppearance(a: Appearance) {
  localAt = Date.now()
  applyAppearance(a)
}

/**
 * 设置取回来、自动保存返回时应用外观。设置页刚在本地改过（3 秒内）就跳过：拖滑块中途停顿一下会触发自动保存，
 * 保存返回的是那一刻的旧值，套上去页面会先跳回旧值、下一格再跳回来，看着就是闪一下（用户反馈）；
 * 本地最新的值稍后自己会被保存，返回时和页面上的一样，也就不用再套
 */
export function applySavedAppearance(a: Appearance | undefined) {
  if (Date.now() - localAt < 3000) return
  applyAppearance(a)
}
