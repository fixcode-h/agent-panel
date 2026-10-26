/**
 * 开发者模式的「元素抓取」要告诉 AI 选中的界面在哪个源文件哪一行：React 19 不再给 fiber 记 _debugSource，
 * 正式包里组件名也被压缩掉了，只能在构建时把位置写进 DOM。
 *
 * 做法：给 web/src 里每个 .tsx 的原生标签（小写开头的 <div>、<button>…）加 data-src="相对路径:行号:组件名"，
 * 组件标签（<Button>）不加——属性会被组件透传或吞掉，位置靠抓取时沿 fiber 往上找外层原生标签的 data-src 补上。
 * 只在原文里插入属性、不换行，行号和 source map 都不受影响
 */
import { parseSync } from 'vite'

/** 组件和 hook 的名字：大写开头或 useXxx；其他变量（cls、onClick）不算 */
const COMPONENT = /^(?:[A-Z]|use[A-Z])/

/** 声明出来的名字：function Foo / const Foo = …（memo、forwardRef 包着的也算这个名字） */
function declName(node) {
  if (node.type === 'FunctionDeclaration') return node.id?.name
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') return node.id.name
  return undefined
}

/**
 * 给一个 .tsx 的原生标签加 data-src。rel 是相对 web/src 的路径（正斜杠）。
 * 返回新代码；没有要加的返回 null
 */
export function addSourceLoc(code, rel, filename = rel) {
  const { program, errors } = parseSync(filename, code, { lang: 'tsx' })
  // 解析不了就原样交给后面的编译，让它报出真正的语法错误
  if (errors.length) return null
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const lineOf = (pos) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const inserts = []
  const names = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (typeof node.type !== 'string') return
    const name = declName(node)
    const pushed = !!name && COMPONENT.test(name)
    if (pushed) names.push(name)
    if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name)) {
      const has = node.attributes.some((a) => a.type === 'JSXAttribute' && a.name?.name === 'data-src')
      if (!has) {
        const comp = names[names.length - 1]
        const loc = `${rel}:${lineOf(node.start)}${comp ? `:${comp}` : ''}`
        inserts.push({ at: node.name.end, text: ` data-src="${loc}"` })
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (v && typeof v === 'object') walk(v)
    }
    if (pushed) names.pop()
  }
  walk(program)
  if (!inserts.length) return null
  // 从后往前插，前面的位置不受影响
  inserts.sort((a, b) => b.at - a.at)
  let out = code
  for (const { at, text } of inserts) out = out.slice(0, at) + text + out.slice(at)
  return out
}

/** Vite 插件：web/src 下的 .tsx 都加上位置（开发和构建都加，开发者模式随时能开） */
export function sourceLoc(srcDir) {
  const root = srcDir.replace(/\\/g, '/').replace(/\/?$/, '/')
  return {
    name: 'source-loc',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/')
      if (!file.startsWith(root) || !file.endsWith('.tsx') || file.endsWith('.test.tsx')) return null
      const out = addSourceLoc(code, file.slice(root.length), file)
      return out === null ? null : { code: out, map: null }
    },
  }
}
