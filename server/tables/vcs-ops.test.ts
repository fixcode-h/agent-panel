/** 表格页的版本操作（git）：只提交这一个文件；CSV 冲突时取三方、工作区换回干净的我这边、标记解决；一格的历史 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emptySchema } from '../../shared/tables.ts'
import { mergeSources, markResolved, submitTable, vcsStatus } from './vcs-ops.ts'
import { cellHistory } from './cell-history.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-vcs-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@example.com')
  writeFileSync(path.join(dir, 'Item.csv'), 'ID,Name,HP\r\n1,a,10\r\n2,b,20\r\n')
  writeFileSync(path.join(dir, 'Other.csv'), 'ID\r\n1\r\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

test('只提交这一个文件，别的改动留着', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'Item.csv'), 'ID,Name,HP\r\n1,a,11\r\n2,b,20\r\n')
  writeFileSync(path.join(dir, 'Other.csv'), 'ID\r\n2\r\n')
  assert.deepEqual(await vcsStatus(dir, 'Item.csv'), { vcs: 'git', changed: true, conflict: false })
  await assert.rejects(submitTable(dir, 'Item.csv', ' '), /提交说明|commit message/)
  await submitTable(dir, 'Item.csv', '改血量')
  assert.match(git(dir, 'log', '-1', '--format=%s'), /改血量/)
  assert.equal((await vcsStatus(dir, 'Item.csv')).changed, false)
  assert.equal((await vcsStatus(dir, 'Other.csv')).changed, true)
  await assert.rejects(submitTable(dir, 'Item.csv', 'x'), /没有改动|no changes/)
  // 一格的历史：1 号的 HP 在两次提交里各是一个值
  const h = await cellHistory(dir, 'Item.csv', emptySchema(), 'Item.csv', {
    sheet: 'Item',
    field: 'HP',
    keyField: 'ID',
    key: '1',
    row: 1,
  })
  assert.deepEqual(
    h.changes.map((c) => [c.from, c.to]),
    [
      ['10', '11'],
      [null, '10'],
    ],
  )
})

test('CSV 冲突：取出祖先和对方，工作区换回干净的我这边，标记解决', async () => {
  const dir = repo()
  git(dir, 'checkout', '-q', '-b', 'other')
  writeFileSync(path.join(dir, 'Item.csv'), 'ID,Name,HP\r\n1,a,12\r\n2,b,20\r\n')
  git(dir, 'commit', '-q', '-am', 'theirs')
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(path.join(dir, 'Item.csv'), 'ID,Name,HP\r\n1,a,11\r\n2,b,20\r\n')
  git(dir, 'commit', '-q', '-am', 'ours')
  assert.throws(() => git(dir, 'merge', '-q', 'other'))
  assert.equal((await vcsStatus(dir, 'Item.csv')).conflict, true)
  assert.match(readFileSync(path.join(dir, 'Item.csv'), 'utf8'), /<<<<<<</)
  let backedUp = false
  const src = await mergeSources(dir, 'Item.csv', async () => {
    backedUp = true
  })
  assert.equal(src.replaced, true)
  assert.equal(backedUp, true)
  assert.equal(readFileSync(path.join(dir, 'Item.csv'), 'utf8'), 'ID,Name,HP\r\n1,a,11\r\n2,b,20\r\n')
  assert.equal(src.base[0].rows[1][2], '10')
  assert.equal(src.theirs[0].rows[1][2], '12')
  await assert.rejects(submitTable(dir, 'Item.csv', 'x'), /冲突|conflict/)
  const st = await markResolved(dir, 'Item.csv')
  assert.equal(st.conflict, false)
})
