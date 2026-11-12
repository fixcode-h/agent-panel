import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
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

const project = { id: 'p1', path: '/proj' }

test('评审语义差异（git）：没有认领的二进制文件时不出这一节', async () => {
  const { dir, base } = repo({ 'a.bin': Buffer.from([0, 1, 2]) })
  writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0, 1, 3]))
  const d = (await reviewDiff(dir, base))!
  assert.equal(await gitSemantic(dir, d.from, d.snapshot, undefined, project), '')
})

test('评审语义差异（git）：插件认领的扩展名按插件转出的文本逐行比、或用插件自己写的差异，出错如实写', async () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'ap-plugin-'))
  // 假插件：把字节转成每行一个数字；内容里有 99 时报错
  writeFileSync(
    path.join(pkg, 'server.mjs'),
    `export default () => ({ textify: { exts: ['uasset'], text: ({ data, side }) => {
      if (data.includes(99)) throw new Error('读不了 ' + side)
      return [...data].join('\\n')
    } } })`,
  )
  // 另一个假插件自己写差异（插件接口 6，表格插件按格子比就是这样）：面板不再逐行比，项目原样传过去
  writeFileSync(
    path.join(pkg, 'diff.mjs'),
    `export default () => ({ textify: { exts: ['sheet'], how: '按格子比较', text: () => '',
      diff: (f, a, b) => f.project.id + '：' + (a ? a[0] : '无') + ' → ' + (b ? b[0] : '无') } })`,
  )
  const inst = (id: string, server: string) =>
    ({
      manifest: { id, name: id, version: '1.0.0', server },
      dir: pkg,
      installedAt: 'now',
      source: { kind: 'dir', ref: pkg },
      skills: [],
    }) as unknown as Installed
  await syncRuntime(
    [inst('fake-ue', 'server.mjs'), inst('fake-sheet', 'diff.mjs')],
    () => true,
    () => ({}),
  )
  try {
    const { dir, base } = repo({
      'BP.uasset': Buffer.from([0, 1, 2]),
      'Bad.uasset': Buffer.from([0, 1]),
      'Item.sheet': Buffer.from([5]),
    })
    writeFileSync(path.join(dir, 'BP.uasset'), Buffer.from([0, 7, 2]))
    writeFileSync(path.join(dir, 'Item.sheet'), Buffer.from([6]))
    writeFileSync(path.join(dir, 'Bad.uasset'), Buffer.from([0, 99]))
    const d = (await reviewDiff(dir, base))!
    const s = await gitSemantic(dir, d.from, d.snapshot, undefined, project)
    assert.match(s, /### BP\.uasset（插件 fake-ue 转成文本后逐行比较）/)
    assert.match(s, /^-1$/m)
    assert.match(s, /^\+7$/m)
    assert.match(s, /读不出语义差异：读不了 new/)
    assert.match(s, /### Item\.sheet（按格子比较）\n```\np1：5 → 6\n```/)
  } finally {
    await stopPlugin('fake-ue')
    await stopPlugin('fake-sheet')
  }
})
