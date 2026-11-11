/** 版本记录：在真的 git 仓库里列出提交、取出旧版本解析成工作表；那一版里还没有的文件当空表 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tableAt, tableHistory } from './history.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir })

test('git：两次提交，最新的在前；取出旧版本的内容', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-history-'))
  git(dir, 'init', '-q')
  mkdirSync(path.join(dir, 'Config'))
  writeFileSync(path.join(dir, 'Config/Item.csv'), 'ID,Name\n1,木剑\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', '加道具表')
  writeFileSync(path.join(dir, 'Config/Item.csv'), 'ID,Name\n1,铁剑\n')
  git(dir, 'commit', '-q', '-am', '改名')
  const h = await tableHistory(dir, 'Config/Item.csv')
  assert.equal(h.vcs, 'git')
  assert.equal(h.base, 'HEAD')
  assert.deepEqual(
    h.revs.map((r) => r.message),
    ['改名', '加道具表'],
  )
  const first = await tableAt(dir, 'Config/Item.csv', h.revs[1].id)
  assert.deepEqual(first[0].rows, [
    ['ID', 'Name'],
    ['1', '木剑'],
  ])
  assert.deepEqual(await tableAt(dir, 'Config/New.csv', 'HEAD'), [])
  await assert.rejects(tableAt(dir, 'Config/Item.csv', '--output=x'), /版本号格式不对/)
})

test('没有版本控制：空列表', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-history-none-'))
  const h = await tableHistory(dir, 'a.csv')
  assert.equal(h.vcs, 'none')
  assert.deepEqual(h.revs, [])
})
