// 按要改的文件取出相关的项目教训（docs/lessons/*.md），只输出命中的分片，省得每次通读。
// 用法：node scripts/lessons.mjs                 按 git 里未提交的改动取
//       node scripts/lessons.mjs <文件> [...]     按给出的文件取（还没动手时用）
//       node scripts/lessons.mjs --list           只列每个分片的标题
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'docs/lessons')

/** 分片开头 `paths: a, b/**` 写的范围转成正则；`**` 跨目录，`*` 不跨 */
export const globToRegExp = (g) =>
  new RegExp(
    '^' +
      g
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*') +
      '$',
  )

export function readShards() {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .map((n) => {
      const text = readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n')
      const m = text.match(/^---\npaths:\s*(.+)\n---\n/)
      const globs = m
        ? m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      return { name: n, text, body: m ? text.slice(m[0].length).trim() : text.trim(), globs }
    })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const shards = readShards()

  if (args.includes('--list')) {
    for (const s of shards) {
      const titles = [...s.body.matchAll(/^## (.+)$/gm)].map((x) => x[1])
      console.log(`docs/lessons/${s.name}`)
      for (const t of titles) console.log(`  - ${t}`)
    }
    process.exit(0)
  }

  let files = args.map((f) => path.relative(root, path.resolve(f)).replaceAll('\\', '/'))
  if (!files.length) {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
    files = out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).split(' -> ').pop())
  }
  if (!files.length) {
    console.log('没有改动的文件。给出要改的文件，或用 --list 看全部标题。')
    process.exit(0)
  }

  const hit = shards.filter((s) => s.globs.some((g) => files.some((f) => globToRegExp(g).test(f))))
  if (!hit.length) {
    console.log(`这些文件没有对应的教训（${files.length} 个文件）。`)
    process.exit(0)
  }
  for (const s of hit) console.log(`<!-- docs/lessons/${s.name} -->\n${s.body}\n`)
}
