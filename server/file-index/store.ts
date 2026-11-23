/**
 * 文件索引落盘（设计稿 3.4）：<数据目录>/file-index/<键>.idx.gz，gzip 的文本，第一行是 JSON 头，之后一行一个目录。
 * 读回来比重扫快一个数量级（19.5 万文件 50 毫秒）；格式简单，坏了直接丢掉重建。先写临时文件再改名替换
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { NameTable } from '../../shared/file-index/table.ts'
import { DATA_DIR } from '../store.ts'

/** 落盘格式的版本：改了旧的直接不认，重建 */
export const FORMAT = 1
export const INDEX_DIR = path.join(DATA_DIR, 'file-index')
const gz = promisify(gzip)
const gunz = promisify(gunzip)

export interface IndexHead {
  format: number
  root: string
  vcs: string
  rules: string
  builtAt: number
  buildMs?: number
  changedAt?: number
  verifiedAt?: number
  files: number
  dirs: number
  /** P4：上次核对时工作区 sync 到的 changelist */
  p4Change?: string
}

/** 一个根目录 + 一套规则 = 一份索引 */
export const indexKey = (root: string, rules: string) =>
  createHash('sha1')
    .update(`${path.resolve(root)}\n${rules}`)
    .digest('hex')
    .slice(0, 16)

const fileOf = (key: string) => path.join(INDEX_DIR, `${key}.idx.gz`)
/** 头单独存一份：数据页列清单只读这个小文件，不用解压整份（引擎那份解压出来几十兆，会拖慢整个面板） */
const headOf = (key: string) => path.join(INDEX_DIR, `${key}.head.json`)

export async function saveIndex(key: string, head: IndexHead, table: NameTable): Promise<number> {
  await mkdir(INDEX_DIR, { recursive: true })
  const text = [JSON.stringify(head), ...table.toLines()].join('\n')
  const buf = await gz(text, { level: 1 })
  const file = fileOf(key)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, buf)
  await rename(tmp, file)
  await writeFile(headOf(key), JSON.stringify(head)).catch(() => {})
  return buf.length
}

export async function loadIndex(
  key: string,
  want: { root: string; rules: string },
): Promise<{ head: IndexHead; table: NameTable; bytes: number } | undefined> {
  const file = fileOf(key)
  const buf = await readFile(file).catch(() => null)
  if (!buf) return undefined
  try {
    const lines = (await gunz(buf)).toString('utf8').split('\n')
    const head = JSON.parse(lines[0]) as IndexHead
    if (head.format !== FORMAT || head.rules !== want.rules || path.resolve(head.root) !== path.resolve(want.root))
      return undefined
    return { head, table: NameTable.fromLines(lines.slice(1)), bytes: buf.length }
  } catch {
    // 读坏了（写到一半断电）：丢掉，调用方重建
    await rm(file, { force: true }).catch(() => {})
    return undefined
  }
}

export async function dropIndex(key: string) {
  await rm(fileOf(key), { force: true })
  await rm(headOf(key), { force: true })
}

/** 数据页列出所有落盘的索引：只读旁边的头文件；没有头文件的（旧版写的）才解压整份取头 */
export async function listIndexFiles(): Promise<{ key: string; head?: IndexHead; bytes: number }[]> {
  const names = await readdir(INDEX_DIR).catch(() => [] as string[])
  const out: { key: string; head?: IndexHead; bytes: number }[] = []
  for (const n of names) {
    if (!n.endsWith('.idx.gz')) continue
    const key = n.slice(0, -'.idx.gz'.length)
    const file = path.join(INDEX_DIR, n)
    const st = await stat(file).catch(() => null)
    let head = await readFile(headOf(key), 'utf8')
      .then((x) => JSON.parse(x) as IndexHead)
      .catch(() => undefined)
    if (!head) {
      const buf = await readFile(file).catch(() => null)
      try {
        if (buf) {
          const text = (await gunz(buf)).toString('utf8')
          head = JSON.parse(text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : undefined)) as IndexHead
        }
      } catch {
        head = undefined
      }
    }
    out.push({ key, head, bytes: st?.size ?? 0 })
  }
  return out
}

export async function dropAllIndexes() {
  await rm(INDEX_DIR, { recursive: true, force: true })
}
