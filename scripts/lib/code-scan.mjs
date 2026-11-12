// 不依赖编译器的源码扫描（仓库用的 TypeScript 7 没有 JS 版的编译器接口）：
// 先把字符串、注释、正则字面量的内容换成空格（位置和换行不变），再在剩下的代码上配括号、找函数。
// 只给结构检查（scripts/structure-check.mjs）量函数长度用，求的是「够准」，不是完整的语法分析。

const REGEX_BEFORE = /[(,=:[!&|?{;+\-*%~^]$|=>$|^$|\b(?:return|typeof|case|in|of|void|await|yield)$/

/** 字符串、注释、正则的内容换成空格；模板字符串里 `${}` 的表达式照样当代码 */
export function maskCode(src) {
  const out = src.split('')
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '
  }
  // 模板字符串嵌套：每层记下表达式里的 { 深度
  const tmpl = []
  let i = 0
  const n = src.length
  const prevCode = () => {
    let k = i - 1
    while (k >= 0 && /\s/.test(out[k])) k--
    let s = k
    while (s >= 0 && /\w/.test(out[s])) s--
    const word = out.slice(s + 1, k + 1).join('')
    if (out[k] === '>' && out[k - 1] === '=') return '=>'
    return /\w/.test(out[k] ?? '') ? word : (out[k] ?? '')
  }
  const inTemplate = () => {
    // 在模板字符串的文字部分：一直到 ` 或 ${
    const start = i
    while (i < n) {
      const c = src[i]
      if (c === '\\') i += 2
      else if (c === '`') {
        blank(start, i)
        i++
        tmpl.pop()
        return
      } else if (c === '$' && src[i + 1] === '{') {
        blank(start, i)
        tmpl[tmpl.length - 1] = 1
        i += 2
        return
      } else i++
    }
    blank(start, n)
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i)
      blank(i, e < 0 ? n : e)
      i = e < 0 ? n : e
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      blank(i, e < 0 ? n : e + 2)
      i = e < 0 ? n : e + 2
    } else if (c === "'" || c === '"') {
      // 字符串到行尾为止：JSX 文字里的撇号（don't）最多只吃掉这一行
      let k = i + 1
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1
      blank(i + 1, k)
      i = k + 1
    } else if (c === '`') {
      tmpl.push(0)
      i++
      inTemplate()
    } else if (c === '/' && d !== '>' && src[i - 1] !== '<' && REGEX_BEFORE.test(prevCode())) {
      let k = i + 1
      let cls = false
      while (k < n && src[k] !== '\n' && (cls || src[k] !== '/')) {
        if (src[k] === '\\') k++
        else if (src[k] === '[') cls = true
        else if (src[k] === ']') cls = false
        k++
      }
      blank(i + 1, k)
      i = k + 1
    } else if (tmpl.length && c === '{') {
      tmpl[tmpl.length - 1]++
      i++
    } else if (tmpl.length && c === '}') {
      tmpl[tmpl.length - 1]--
      i++
      if (tmpl[tmpl.length - 1] === 0) inTemplate()
    } else i++
  }
  return out.join('')
}

const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function'])

/** 配括号：返回每个开括号位置 → 对应的闭括号位置 */
function pairs(code, open, close) {
  const map = new Map()
  const back = new Map()
  const stack = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] === open) stack.push(i)
    else if (code[i] === close && stack.length) {
      const a = stack.pop()
      map.set(a, i)
      back.set(i, a)
    }
  }
  return { map, back }
}

/** 找出所有函数（声明、方法、箭头函数）：名字、起止行、行数 */
export function functionsOf(src) {
  const code = maskCode(src)
  const braces = pairs(code, '{', '}').map
  const parens = pairs(code, '(', ')').back
  const lineAt = []
  let line = 1
  for (let i = 0; i < code.length; i++) {
    lineAt[i] = line
    if (code[i] === '\n') line++
  }
  const out = []
  const before = (p) => {
    let q = p - 1
    while (q >= 0 && /\s/.test(code[q])) q--
    return q
  }
  const wordBefore = (p) => {
    let q = before(p)
    let s = q
    while (s >= 0 && /[\w$]/.test(code[s])) s--
    return { word: code.slice(s + 1, q + 1), at: s + 1 }
  }
  /** 匿名函数的名字：赋给的变量 / 属性，或者调用它的表达式（带第一个字符串参数，例如 app.post('/tasks')） */
  const contextName = (p) => {
    const head = src.slice(Math.max(0, p - 300), p)
    const assign = head.match(/([\w$]+)\s*(?::[^=;{}]*)?=\s*(?:async\s*)?(?:function\s*)?(?:<[^>]*>)?\s*$/)
    if (assign) return assign[1]
    const prop = head.match(/([\w$]+)\s*:\s*(?:async\s*)?(?:function\s*)?$/)
    if (prop) return prop[1]
    const call = head.match(/([\w$.]+)\(\s*(?:('[^'\n]*'|"[^"\n]*"),\s*)?(?:[\w$]+\s*,\s*)*(?:async\s*)?$/)
    if (call) return `${call[1].slice(-40)}(${call[2] ?? ''})`
    return '(匿名)'
  }
  for (const [a, b] of braces) {
    const q = before(a)
    let name = null
    let start = a
    if (code[q] === '>' && code[q - 1] === '=') {
      // 箭头函数：参数是 (...) 或单个标识符，返回类型写在 ) 和 => 之间
      const r = before(q - 1)
      const scan = code.slice(Math.max(0, r - 300), r + 1)
      const typed = scan.match(/\)\s*:[^{};=()]*$/)
      const at = code[r] === ')' ? r : typed ? r - (typed[0].length - 1) : -1
      if (at >= 0) {
        const open = parens.get(at)
        if (open === undefined) continue
        start = open
      } else start = wordBefore(r + 1).at
      name = contextName(start)
    } else {
      // 普通函数 / 方法：{ 前面是 )，或者 ): 返回类型
      let r = q
      if (code[r] !== ')') {
        const scan = code.slice(Math.max(0, r - 300), r + 1)
        const m = scan.match(/\)\s*:[^{};=]*$/)
        if (!m) continue
        r -= m[0].length - 1
      }
      const open = parens.get(r)
      if (open === undefined) continue
      let o = before(open)
      // 泛型参数 <T>
      if (code[o] === '>') {
        const lt = code.lastIndexOf('<', o)
        if (lt < 0) continue
        o = before(lt)
      }
      const { word, at } = wordBefore(o + 1)
      if (!word) continue
      if (word === 'function') name = contextName(at)
      else if (NOT_FN.has(word)) continue
      else {
        const prev = wordBefore(at).word
        // a.b(...) { 不是函数；function foo( / async foo( / 类和对象里的方法 foo( 是
        if (code[before(at)] === '.') continue
        name = word
        if (prev === 'function' || prev === 'async') start = wordBefore(at).at
      }
      start = Math.min(start, at)
    }
    out.push({ name, start: lineAt[start], end: lineAt[b], lines: lineAt[b] - lineAt[start] + 1 })
  }
  return out
}
