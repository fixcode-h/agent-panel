/** 切换到某一版：本地文件整个换成那一版的字节，再切回 HEAD；只读项目不让切 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TablesConfig } from '../../shared/tables.ts'
import { checkoutTable } from './checkout.ts'
import { tableHistory } from './history.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir })

test('git：切到旧版本再切回最新提交，文件内容逐字节一致', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-checkout-'))
  git(dir, 'init', '-q')
  mkdirSync(path.join(dir, 'Config'))
  const file = path.join(dir, 'Config/Item.csv')
  writeFileSync(file, 'ID,Name\r\n1,木剑\r\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'a')
  writeFileSync(file, 'ID,Name\r\n1,铁剑\r\n')
  git(dir, 'commit', '-q', '-am', 'b')
  const cfg = TablesConfig.parse({ dirs: ['Config'] })
  const vcs = { cwd: dir, rel: 'Config/Item.csv' }
  const old = (await tableHistory(dir, 'Config/Item.csv')).revs[1].id
  const doc = await checkoutTable(dir, 'p', cfg, { path: 'Config/Item.csv', rev: old }, vcs)
  assert.equal(readFileSync(file, 'utf8'), 'ID,Name\r\n1,木剑\r\n')
  assert.equal(doc.sheets[0].rows[1][1], '木剑')
  await checkoutTable(dir, 'p', cfg, { path: 'Config/Item.csv', rev: 'HEAD' }, vcs)
  assert.equal(readFileSync(file, 'utf8'), 'ID,Name\r\n1,铁剑\r\n')
  await assert.rejects(
    checkoutTable(dir, 'p', { ...cfg, readOnly: true }, { path: 'Config/Item.csv', rev: 'HEAD' }, vcs),
    /只读/,
  )
})
