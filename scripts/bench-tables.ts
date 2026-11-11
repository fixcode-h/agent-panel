/**
 * 表格页的性能基准：生成一批假表格（默认 5000 个文件、一张 1 万行 × 80 列的大表），量列表、解析、检查、差异的耗时，
 * 超过目标就以非 0 退出。跑法：npm run bench:tables（可加 -- --files 20000 --rows 50000）。临时文件写在 .tmp/ 下，跑完删掉。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { TableSchema, TablesConfig } from '../shared/tables.ts'
import { checkSheet, columnInfos, columnOptions } from '../shared/table-struct.ts'
import { diffSheet } from '../shared/sheet-diff.ts'
import { listTables, parseTable } from '../server/tables/files.ts'

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : def
}
const FILES = arg('files', 5000)
const ROWS = arg('rows', 10000)
const COLS = arg('cols', 80)

/** 目标（毫秒）：见 designs/表格功能-待办与性能设计.md 第四节 */
const BUDGET = { list: 1500, parse: 1500, check: 400, recheck: 30, diff: 1500 }

const dir = path.resolve('.tmp', `bench-tables-${process.pid}`)
const fails: string[] = []
const time = async <T>(name: keyof typeof BUDGET, f: () => T | Promise<T>) => {
  const t0 = performance.now()
  const out = await f()
  const ms = performance.now() - t0
  const ok = ms <= BUDGET[name]
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(8)} ${ms.toFixed(0).padStart(6)} ms（目标 ${BUDGET[name]}）`)
  if (!ok) fails.push(name)
  return out
}

try {
  // 很多小表：按 50 个一个目录分开
  for (let i = 0; i < FILES; i++) {
    const sub = path.join(dir, 'Excel', `G${Math.floor(i / 50)}`)
    if (i % 50 === 0) mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, `T${i}.csv`), 'ID,Name\nuint32,string\n1,a\n')
  }
  // 一张大表：两行表头（类型、字段名）+ 数据
  const head = [
    Array.from({ length: COLS }, (_, c) => (c % 3 ? 'string' : 'uint32')),
    Array.from({ length: COLS }, (_, c) => (c ? `F${c}` : 'ID')),
  ]
  const lines = [...head.map((r) => r.join(','))]
  for (let r = 0; r < ROWS; r++)
    lines.push(Array.from({ length: COLS }, (_, c) => (c % 3 ? `v${r}_${c}` : String(r + c))).join(','))
  writeFileSync(path.join(dir, 'Big.csv'), lines.join('\n'))

  const cfg = TablesConfig.parse({ dirs: ['Excel'] })
  const index = await time('list', () => listTables(dir, cfg, true))
  console.log(`  列出 ${index.files.length} 个文件`)
  const { sheets } = await time('parse', () => parseTable(path.join(dir, 'Big.csv')))
  const rows = sheets[0].rows
  const schema = TableSchema.parse({})
  const header = { start: 0, roles: ['type', 'name'] as ('type' | 'name')[] }
  const infos = columnInfos(schema, rows, header, 'Big.csv', 'Big', COLS)
  const { ctx } = columnOptions(schema, infos, () => undefined)
  const cache = new WeakMap<string[], { c: number; msg: string }[]>()
  await time('check', () => checkSheet(rows, 2, infos, 'ID', ctx, 2000, cache))
  // 改一格：只复制那一行，其余行用缓存
  const next = [...rows]
  next[500] = [...rows[500]]
  next[500][1] = 'changed'
  await time('recheck', () => checkSheet(next, 2, infos, 'ID', ctx, 2000, cache))
  // 差异：没有唯一主键时走 LCS / 贪心；中间删一行、改几格
  const b = rows.filter((_, i) => i !== 3000).map((r, i) => (i % 997 === 0 ? [...r.slice(0, -1), 'x'] : r))
  await time('diff', () => diffSheet({ rows, from: 2, names: head[1] }, { rows: b, from: 2, names: head[1] }, ''))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
if (fails.length) {
  console.error(`超过目标：${fails.join('、')}`)
  process.exit(1)
}
