// 多语言检查：找出代码里所有 t('中文') 的文案，对照英文词典列出漏翻的和多余的。
// 用法：node scripts/i18n-check.mjs          有漏翻时以退出码 1 结束（CI 里跑）
//       node scripts/i18n-check.mjs --missing  只把漏翻的文案按 JSON 数组输出，方便补词典
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['web/src', 'shared', 'server']
// 演示数据、给 Agent 的提示词是内容不是界面，不翻
const SKIP = /demo-|locales\/|shared\/runner\.ts|shared\/assist\.ts/

const files = []
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const f = path.join(d, n)
    if (statSync(f).isDirectory()) walk(f)
    else if (/\.(ts|tsx)$/.test(n) && !SKIP.test(f.replaceAll('\\', '/'))) files.push(f)
  }
}
for (const d of DIRS) walk(path.join(root, d))

const unescape = (s, q) => s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === q || c === '\\' ? c : m))
const keys = new Map()
const re = /\bt\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`)/g
for (const f of files) {
  // 去掉整行的注释，注释里举例的 t('…') 不算
  const src = readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const m of src.matchAll(re)) {
    const k = m[1] !== undefined ? unescape(m[1], "'") : m[2] !== undefined ? unescape(m[2], '"') : unescape(m[3], '`')
    if (!keys.has(k)) keys.set(k, path.relative(root, f))
  }
}

// 词典分在 shared/locales/en/ 下的几个文件里，合起来就是英文词典
const EN = {}
for (const n of readdirSync(path.join(root, 'shared/locales/en'))) {
  const src = readFileSync(path.join(root, 'shared/locales/en', n), 'utf8').replace(/: Record<string, string>/g, '')
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  for (const v of Object.values(mod)) Object.assign(EN, v)
}
const missing = [...keys.keys()].filter((k) => !(k in EN))
const unused = Object.keys(EN).filter((k) => !keys.has(k))

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 1))
  process.exit(0)
}
console.log(`文案 ${keys.size} 条，英文 ${Object.keys(EN).length} 条`)
if (unused.length)
  console.log(`词典里多余的 ${unused.length} 条（代码里已经没有了）：\n  ${unused.slice(0, 20).join('\n  ')}`)
if (missing.length) {
  console.error(`漏翻 ${missing.length} 条：`)
  for (const k of missing.slice(0, 50)) console.error(`  ${JSON.stringify(k)}  ← ${keys.get(k)}`)
  process.exit(1)
}
