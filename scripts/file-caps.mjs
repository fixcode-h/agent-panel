// 大文件行数上限（rules-check 第 15 条读 scripts/file-caps.json）。
// node scripts/file-caps.mjs          列出超过默认上限的文件、函数和它们的上限
// node scripts/file-caps.mjs --update 把变小了的文件的上限跟着降下来（只降不升）
//
// 为什么要有：server/tasks.ts 拆分前四天涨了 1000 行，大文件越长越难拆、并行改时越容易冲突。
// 上限只拦「继续变大」，不逼着一次拆完；要加功能就把新代码放进拆出来的模块（见 server/tasks/）。
// 确实要放宽某个文件时，手改 file-caps.json 里那一项，提交说明里写为什么。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capOf, capsPath, fnCapOf, linesOf, sourceFiles } from './lib/file-caps.mjs'
import { longFunctions } from './lib/fn-caps.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const caps = JSON.parse(readFileSync(capsPath(root), 'utf8'))
if (process.argv.includes('--update')) {
  let changed = 0
  for (const [file, cap] of Object.entries(caps.files)) {
    let lines
    try {
      lines = linesOf(root, file)
    } catch {
      delete caps.files[file]
      changed++
      continue
    }
    const next = capOf(lines)
    if (next < cap) {
      caps.files[file] = next
      changed++
    }
    if (next <= caps.default) {
      delete caps.files[file]
      changed++
    }
  }
  // 函数上限同样只降不升：变短了跟着降，降到默认上限以内（或函数没了、改了名）就从列表里删掉
  const now = new Map(longFunctions(root, caps.functionDefault).map((f) => [f.key, f.lines]))
  for (const [key, cap] of Object.entries(caps.functions)) {
    const lines = now.get(key)
    if (lines === undefined) {
      delete caps.functions[key]
      changed++
    } else if (fnCapOf(lines) < cap) {
      caps.functions[key] = fnCapOf(lines)
      changed++
    }
  }
  writeFileSync(capsPath(root), `${JSON.stringify(caps, null, 2)}\n`)
  console.log(changed ? `上限已更新 ${changed} 项` : '没有可以降的上限')
} else {
  for (const f of sourceFiles(root)) {
    const lines = linesOf(root, f)
    const cap = caps.files[f] ?? caps.default
    if (lines > caps.default || caps.files[f]) console.log(`${String(lines).padStart(5)} / ${cap}  ${f}`)
  }
  for (const fn of longFunctions(root, caps.functionDefault))
    console.log(
      `${String(fn.lines).padStart(5)} / ${caps.functions[fn.key] ?? caps.functionDefault}  ${fn.key}（函数）`,
    )
}
