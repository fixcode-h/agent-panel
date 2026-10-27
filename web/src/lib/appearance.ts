import { Appearance } from '@shared/schema'

const CJK = {
  noto: ["'Noto Sans SC'", "'PingFang SC'", "'Microsoft YaHei'"],
  // 系统字体不列思源黑体：它的 @font-face 只在选了 noto 时才加载（见 ensureCjkFont），
  // 列在这里只会让浏览器去匹配一个没加载的字体；本机真没有中文字体时交给 system-ui 兜底
  system: ["'PingFang SC'", "'Microsoft YaHei'", "'Hiragino Sans GB'"],
}
const UI = {
  maple: ["'Maple Mono NL'"],
  plex: ["'IBM Plex Sans'"],
  system: ['-apple-system', "'Segoe UI'"],
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
  }
}

let cjkLoad: Promise<unknown> | null = null

/** 中文字体选的是思源黑体时，才需要它的 @font-face */
export const needsCjkFont = (cjkFont: Appearance['cjkFont']) => cjkFont === 'noto'

/**
 * 思源黑体的 @font-face 在 fonts-cjk.css 里（每档 101 个 unicode-range 分片）：只有中文字体选了它才加载。
 * 判定看设置里的 cjkFont 字段，**不从生成的字体列表里搜字体名**：
 * 那样会在选「系统字体」时也命中（不加载就等于白下载 202 条声明）。
 */
export function ensureCjkFont(cjkFont: Appearance['cjkFont']) {
  if (cjkLoad || !needsCjkFont(cjkFont)) return
  // 加载失败（产物里少了这个 CSS）就退回字体列表里的系统中文，不报错：这是纯性能优化，退化只影响字形
  cjkLoad = import('../fonts-cjk.css').catch(() => null)
}

/** 记下的中文字体选择：index.html 存的那份是 CSS 变量，取不出这个字段，单独记一个 */
const CJK_KEY = 'appearance-cjk'

/** 设置还没取回来时先按上次的选择判一次，免得设置回来才换字体、闪一下 */
export function primeCjkFont() {
  try {
    const cjk = localStorage.getItem(CJK_KEY)
    if (cjk === 'noto' || cjk === 'system') ensureCjkFont(cjk)
  } catch {
    // 浏览器不让读就算了，设置取回来后 applyAppearance 会再判一次
  }
}

/** 应用到页面，并记在浏览器里：index.html 加载时先用记下的，免得设置取回来前闪一下默认字体 */
export function applyAppearance(a: Appearance | undefined) {
  const parsed = Appearance.parse(a ?? {})
  const vars = appearanceVars(parsed)
  // 中文字体选了思源黑体时才去加载它的分片
  ensureCjkFont(parsed.cjkFont)
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
  try {
    localStorage.setItem('appearance', JSON.stringify(vars))
    localStorage.setItem(CJK_KEY, parsed.cjkFont)
  } catch {
    // 浏览器不让存就算了，只是加载时会闪一下
  }
}
