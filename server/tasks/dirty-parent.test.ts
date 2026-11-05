/**
 * 独立分支模式下派要改代码的子对话：父对话目录里有没提交的改动时先不开，把清单交回（server/tasks/dirty-parent.ts）。
 * 起因：2026-11-05 实测，父对话写了模块文档没提交就开了三个独立分支的子对话，它们都找不到派单里要更新的文档
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dirtyParentBlock, dirtyParentNote, uncommittedFiles } from './dirty-parent.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dirty-parent-'))
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, 'a.ts'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const parent = { id: 'p1', messages: [], placedAttachments: [] } as never

test('列出改过的、没跟踪的文件；面板放进来的附件不算；不是 git 仓库返回 null', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(await uncommittedFiles(dir), [])
  writeFileSync(path.join(dir, 'a.ts'), 'b\n')
  mkdirSync(path.join(dir, 'docs/modules/x'), { recursive: true })
  writeFileSync(path.join(dir, 'docs/modules/x/README.md'), '# x\n')
  writeFileSync(path.join(dir, 'shot.png'), '')
  assert.deepEqual((await uncommittedFiles(dir, ['shot.png']))?.sort(), ['a.ts', 'docs/modules/x/README.md'])
  const plain = mkdtempSync(path.join(tmpdir(), 'dirty-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  assert.equal(await uncommittedFiles(plain), null)
})

test('只在独立分支模式下拦；干净的目录不拦；没写 edits 的只提醒', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sc = { taskDir: async () => dir }
  const wt = { path: dir, childIsolation: 'worktree' } as never
  assert.equal(await dirtyParentBlock(sc, parent, wt), '')
  writeFileSync(path.join(dir, 'new.md'), 'x\n')
  const block = await dirtyParentBlock(sc, parent, wt)
  assert.match(block, /1 个没提交的改动/)
  assert.match(block, /- new\.md/)
  assert.match(block, /ignore_uncommitted: true/)
  assert.match(await dirtyParentNote(sc, parent, wt), /new\.md/)
  // 共用目录模式：子对话就在父对话目录里做，看得到这些改动
  assert.equal(await dirtyParentBlock(sc, parent, { path: dir, childIsolation: 'claim' } as never), '')
})
