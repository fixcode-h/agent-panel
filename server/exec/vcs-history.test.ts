/** 文件的版本记录：在真的 git 仓库里列出提交、取出旧版本的字节；那一版里还没有的文件给 null */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { changedFiles, fileAt, fileHistory, VcsInputError } from './vcs-history.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir })

test('git：两次提交，最新的在前；取出旧版本的字节', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-vcs-history-'))
  git(dir, 'init', '-q')
  mkdirSync(path.join(dir, 'Content'))
  writeFileSync(path.join(dir, 'Content/BP_Box.uasset'), Buffer.from([1, 2, 3]))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', '加木箱')
  writeFileSync(path.join(dir, 'Content/BP_Box.uasset'), Buffer.from([1, 2, 4]))
  git(dir, 'commit', '-q', '-am', '改木箱')
  const h = await fileHistory(dir, 'Content/BP_Box.uasset')
  assert.equal(h.vcs, 'git')
  assert.equal(h.base, 'HEAD')
  assert.deepEqual(
    h.revs.map((r) => r.message),
    ['改木箱', '加木箱'],
  )
  assert.deepEqual([...((await fileAt(dir, 'Content/BP_Box.uasset', h.revs[1].id)) ?? [])], [1, 2, 3])
  assert.equal(await fileAt(dir, 'Content/New.uasset', 'HEAD'), null)
  await assert.rejects(fileAt(dir, 'Content/BP_Box.uasset', '--output=x'), VcsInputError)
})

test('没有版本控制：空列表，取内容报错', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-vcs-history-none-'))
  const h = await fileHistory(dir, 'a.uasset')
  assert.equal(h.vcs, 'none')
  assert.deepEqual(h.revs, [])
  await assert.rejects(fileAt(dir, 'a.uasset', 'HEAD'), VcsInputError)
})

test('git：一次提交里改了哪些文件，路径相对传入的目录', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-vcs-changed-'))
  git(root, 'init', '-q')
  const dir = path.join(root, 'Game')
  mkdirSync(path.join(dir, 'Content'), { recursive: true })
  writeFileSync(path.join(dir, 'Content/A.uasset'), 'a')
  writeFileSync(path.join(dir, 'Content/B.uasset'), 'b')
  writeFileSync(path.join(root, 'outside.txt'), 'x')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', '一起改')
  const h = await fileHistory(dir, 'Content/A.uasset')
  assert.equal(h.revs[0].change, h.revs[0].id)
  assert.deepEqual((await changedFiles(dir, h.revs[0].id)).sort(), ['Content/A.uasset', 'Content/B.uasset'])
  await assert.rejects(changedFiles(dir, '--output=x'), VcsInputError)
})
