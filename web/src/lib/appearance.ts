import { Appearance } from '@shared/schema'

const CJK = {
  noto: ["'Noto Sans SC'", "'PingFang SC'", "'Microsoft YaHei'"],
  system: ["'PingFang SC'", "'Microsoft YaHei'", "'Hiragino Sans GB'", "'Noto Sans SC'"],
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

/** 应用到页面，并记在浏览器里：index.html 加载时先用记下的，免得设置取回来前闪一下默认字体 */
export function applyAppearance(a: Appearance | undefined) {
  const vars = appearanceVars(Appearance.parse(a ?? {}))
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
  try {
    localStorage.setItem('appearance', JSON.stringify(vars))
  } catch {
    // 浏览器不让存就算了，只是加载时会闪一下
  }
}
