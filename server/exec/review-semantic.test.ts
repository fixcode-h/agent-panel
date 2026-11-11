import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TableSchema } from '../../shared/tables.ts'
import { gameBook } from '../tables/xlsx-fixture.ts'
import { editXlsx } from '../tables/xlsx-write.ts'
import { syncRuntime, stopPlugin } from '../plugins/runtime.ts'
import type { Installed } from '../plugins/store.ts'
import { reviewDiff } from './git.ts'
import { gitSemantic } from './review-semantic.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo(files: Record<string, Buffer | string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-semantic-'))
  git(dir, 'init', '-q')
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(dir, f), v)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() }
}

const schema = TableSchema.parse({})

test('评审语义差异（git）：改了 xlsx 的格子，评审看到哪一格从什么改成什么', async () => {
  const { dir, base } = repo({ 'Item.xlsx': gameBook(), 'a.ts': 'x\n' })
  writeFileSync(
    path.join(dir, 'Item.xlsx'),
    editXlsx(gameBook(), [{ name: '道具', rows: [], cells: [{ r: 4, c: 1, v: '银剑' }] }]),
  )
  writeFileSync(path.join(dir, 'a.ts'), 'y\n')
  const d = (await reviewDiff(dir, base))!
  const s = await gitSemantic(dir, d.from, d.snapshot, undefined, schema)
  assert.match(s, /## 二进制文件的语义差异/)
  assert.match(s, /### Item\.xlsx（表格，按格子比较）/)
  assert.match(s, /铁剑 → 银剑/)
  assert.doesNotMatch(s, /a\.ts/, '文本文件照旧走 diff，不进这一节')
})

test('评审语义差异（git）：没有认领的二进制文件时不出这一节', async () => {
  const { dir, base } = repo({ 'a.bin': Buffer.from([0, 1, 2]) })
  writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0, 1, 3]))
  const d = (await reviewDiff(dir, base))!
  assert.equal(await gitSemantic(dir, d.from, d.snapshot, undefined, schema), '')
})

test('评审语义差异（git）：插件认领的扩展名按插件转出的文本逐行比，出错如实写', async () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'ap-plugin-'))
  // 假插件：把字节转成每行一个数字；内容里有 99 时报错
  writeFileSync(
    path.join(pkg, 'server.mjs'),
    `export default () => ({ textify: { exts: ['uasset'], text: ({ data, side }) => {
      if (data.includes(99)) throw new Error('读不了 ' + side)
      return [...data].join('\\n')
    } } })`,
  )
  const p = {
    manifest: { id: 'fake-ue', name: 'fake', version: '1.0.0', server: 'server.mjs' },
    dir: pkg,
    installedAt: 'now',
    source: { kind: 'dir', ref: pkg },
    skills: [],
  } as unknown as Installed
  await syncRuntime(
    [p],
    () => true,
    () => ({}),
  )
  try {
    const { dir, base } = repo({ 'BP.uasset': Buffer.from([0, 1, 2]), 'Bad.uasset': Buffer.from([0, 1]) })
    writeFileSync(path.join(dir, 'BP.uasset'), Buffer.from([0, 7, 2]))
    writeFileSync(path.join(dir, 'Bad.uasset'), Buffer.from([0, 99]))
    const d = (await reviewDiff(dir, base))!
    const s = await gitSemantic(dir, d.from, d.snapshot, undefined, schema)
    assert.match(s, /### BP\.uasset（插件 fake-ue 转成文本后逐行比较）/)
    assert.match(s, /^-1$/m)
    assert.match(s, /^\+7$/m)
    assert.match(s, /读不出语义差异：读不了 new/)
  } finally {
    await stopPlugin('fake-ue')
  }
})
