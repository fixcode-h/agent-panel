/** 文件的版本记录：在真的 git 仓库里列出提交、取出旧版本的字节；那一版里还没有的文件给 null */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileAt, fileHistory, VcsInputError } from './vcs-history.ts'

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
