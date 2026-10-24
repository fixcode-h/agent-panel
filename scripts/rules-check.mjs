// 把 docs/lessons/ 里能机器判断的教训变成检查，`npm run lint` 会跑。
// 1. 不按 CLI 的名字写分支：CLI 的差异写进定义（shared/clis*），代码按字段走
// 2. 文档里写的仓库路径必须存在，避免改名、删文件后文档还指着旧路径
// 3. 教训分片的格式和大小：有 paths、每条有「规则」、单个分片不超过 6 KB、paths 至少命中一个文件
// 4. 已跟踪文本文件的换行和编码：仓库里统一 LF、UTF-8 无 BOM（见 .gitattributes）
// 5. 附件的原路径和 placed；6. 清掉任务字段写 undefined，不用 delete
// 7. 模块文档和 MODULE-MAP 的模块表双向对得上：缺文档、模块删了文档目录还留着
// 确实需要按名字区分时（例如内置适配器内部），在这一行或上一行写 `cli-id-ok: 原因`。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp, readShards } from './lessons.mjs'
import { checkModuleDocsInRoot } from './lib/doc-modules.mjs'

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

// 4. 换行和编码：Windows 上 core.autocrlf 会把工作区转成 CRLF，编辑器存成带 BOM 的文字
// 在 WSL / Linux 里跑会报 bad interpreter，所以已跟踪的文本文件一律 LF、UTF-8 无 BOM
const attrs = existsSync(path.join(root, '.gitattributes'))
  ? readFileSync(path.join(root, '.gitattributes'), 'utf8').split('\n')
  : []
// .gitattributes 里标成 binary 或 -text 的按二进制处理；不带目录的模式匹配任意层
const attrBinary = attrs
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/))
  .filter(([, ...a]) => a.includes('binary') || a.includes('-text'))
  .map(([pattern]) => globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`))
const tracked = execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(path.join(root, f)))
const crlf = []
const bom = []
for (const f of tracked) {
  if (attrBinary.some((re) => re.test(f))) continue
  const buf = readFileSync(path.join(root, f))
  // 和 git 一样：前 8 KB 里有 0 字节就当二进制，不检查换行和 BOM
  if (buf.subarray(0, 8000).includes(0)) continue
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(f)
  if (buf.includes('\r\n')) crlf.push(f)
}
const list = (a) => [...a.slice(0, 10).map((f) => `  ${f}`), ...(a.length > 10 ? [`  ……还有 ${a.length - 10} 个`] : [])]
if (crlf.length)
  errors.push(
    [
      `${crlf.length} 个已跟踪的文件含 CRLF 换行，仓库统一存 LF：`,
      ...list(crlf),
      '修复：git config core.autocrlf false，然后 git add --renormalize . 重新入库；工作区的文件用编辑器或 dos2unix 转成 LF',
    ].join('\n'),
  )
if (bom.length)
  errors.push(
    [
      `${bom.length} 个已跟踪的文件带 UTF-8 BOM，仓库统一用无 BOM：`,
      ...list(bom),
      '修复：把文件另存为 UTF-8 无 BOM（PowerShell 5.1 的 -Encoding UTF8 会写 BOM，改用 [System.IO.File]::WriteAllText）',
    ].join('\n'),
  )

// 5. 附件的两个路径：记进对话的用上传目录的原路径，拷进任务目录的 placed 只给 CLI
// （见 docs/lessons/data.md「附件有两个路径」）
for (const f of files) {
  if (!/^server\/.+\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue
  if (/attachments:\s*placed\b/.test(read(f)))
    errors.push(`${f} 把拷进任务目录的附件（placed）记进了对话：对话里要存上传目录的原路径，placed 只给 CLI`)
}

// 6. 清掉任务字段写 undefined：store.update 把传入的字段盖到旧记录上，delete 掉的键盖不掉旧值
// （见 docs/lessons/data.md「清掉任务上的字段写 undefined」）
for (const f of files) {
  if (!/^server\/.+\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/\bdelete\s+(?:tk|task|next|cur|child|parent)\.\w+\s*$/.test(l) && !/delete-ok/.test(l))
        errors.push(`${f}:${i + 1} 用 delete 清任务字段，落盘后旧值还在，改成写 undefined：${l.trim()}`)
    })
}

// 7. 模块文档和模块地图双向对得上（见 skills/docs/project-documentation「模块文档」）；root 必须是仓库根，传错会因为找不到 docs/MODULE-MAP.md 而静默通过
errors.push(...checkModuleDocsInRoot(root))

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('规则检查通过')
