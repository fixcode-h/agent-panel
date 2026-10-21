// 把 docs/lessons/ 里能机器判断的教训变成检查，`npm run lint` 会跑。
// 1. 不按 CLI 的名字写分支：CLI 的差异写进定义（shared/clis*），代码按字段走
// 2. 文档里写的仓库路径必须存在，避免改名、删文件后文档还指着旧路径
// 3. 教训分片的格式和大小：有 paths、每条有「规则」、单个分片不超过 6 KB、paths 至少命中一个文件
// 确实需要按名字区分时（例如内置适配器内部），在这一行或上一行写 `cli-id-ok: 原因`。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp, readShards } from './lessons.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && existsSync(path.join(root, f)))
const read = (f) => readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')
const errors = []

// 1. CLI 名字分支
const ids = [
  'claude',
  'codex',
  ...files
    .filter((f) => /^shared\/clis\/[^/]+\.json$/.test(f))
    .map((f) => JSON.parse(read(f)).id)
    .filter(Boolean),
]
const q = `['"](?:${ids.join('|')})['"]`
const subject = String.raw`\b(?:id|cli|cliId|cliKey)\b`
const branch = new RegExp(`${subject}\\s*[!=]==?\\s*${q}|${q}\\s*[!=]==?\\s*(?:\\w+\\.)?${subject}`)
const SKIP = /\.test\.tsx?$|\/demo-|\/locales\/|^shared\/clis\.ts$/
for (const f of files) {
  if (!/^(shared|server|web\/src)\/.+\.tsx?$/.test(f) || SKIP.test(f)) continue
  const lines = read(f).split('\n')
  lines.forEach((l, i) => {
    if (!branch.test(l) || /cli-id-ok/.test(l) || /cli-id-ok/.test(lines[i - 1] ?? '')) return
    errors.push(`${f}:${i + 1} 按 CLI 名字写了分支，改成 CLI 定义里的字段（见 docs/lessons/cli.md）：${l.trim()}`)
  })
}

// 2. 文档里的路径
const docs = files.filter((f) => /^(AGENTS|CLAUDE|README)\.md$|^docs\/.+\.md$|\/README\.md$/.test(f))
const TOP = /^(shared|server|web|scripts|docs|skills|extension|\.github)\//
for (const f of docs) {
  const text = read(f)
  const refs = new Set()
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/:\d+$/, '').replace(/\/$/, '')
    if (TOP.test(p) && !/[<>{}*|…]/.test(p)) refs.add(p)
  }
  for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
    refs.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])))
  }
  for (const p of refs) if (!existsSync(path.join(root, p))) errors.push(`${f} 引用的 ${p} 不存在`)
}

// 3. 教训分片
for (const s of readShards()) {
  const f = `docs/lessons/${s.name}`
  if (!s.globs.length) errors.push(`${f} 开头缺少 paths`)
  if (Buffer.byteLength(s.text) > 6144) errors.push(`${f} 超过 6 KB，合并同类项或把能检查的改成检查`)
  for (const g of s.globs) {
    const re = globToRegExp(g)
    if (!files.some((x) => re.test(x))) errors.push(`${f} 的 paths 里 ${g} 一个文件都没命中`)
  }
  for (const sec of s.body.split(/^## /m).slice(1)) {
    const title = sec.split('\n')[0]
    if (!/^- 规则：/m.test(sec)) errors.push(`${f}「${title}」缺少「- 规则：」`)
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('规则检查通过')
