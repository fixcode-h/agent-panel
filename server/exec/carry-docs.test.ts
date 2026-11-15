/**
 * 模块文档不先提交（摸底报告第 7 条）：开独立分支时把父对话目录里没提交的模块 README 带过去，
 * 合回时父对话目录那份一样的未跟踪副本不挡合并；合并没成时副本原样写回。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
// 工具包先把数据目录指到临时目录、清掉外面的 GIT_DIR，再加载 worktree.ts
import { createWorktree, git, project, removeWorktree, tid } from './worktree-test-kit.ts'

const { carryModuleDocs } = await import('./carry-docs.ts')
const { commitWorktree } = await import('./worktree.ts')
const { integrateBranch } = await import('./worktree-integrate.ts')

const DOC = 'docs/modules/calc/README.md'
const write = (dir: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), text)
}

test('没提交的模块文档带进子对话分支，合回时一起进来，父对话目录不挡路', async () => {
  const repo = project()
  write(repo, DOC, '# calc\n')
  // 别的没提交的文件不带
  write(repo, 'notes.txt', '草稿\n')
  const wt = await createWorktree(repo, tid(), '改计算')
  try {
    assert.deepEqual(await carryModuleDocs(repo, wt.path), [DOC])
    assert.equal(readFileSync(path.join(wt.path, DOC), 'utf8'), '# calc\n')
    assert.ok(!existsSync(path.join(wt.path, 'notes.txt')))
    write(wt.path, 'src/calc.ts', 'export const add = (a: number, b: number) => a + b\n')
    await commitWorktree(wt, '改计算')
    const r = await integrateBranch(repo, wt, '改计算')
    assert.equal(r.ok, true, r.info)
    assert.equal(readFileSync(path.join(repo, DOC), 'utf8'), '# calc\n')
    assert.equal(git(repo, 'ls-files', DOC).toString().trim(), DOC, '合回后文档进了版本控制')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('合并没成（冲突）时，挪开的文档副本原样写回', async () => {
  const repo = project()
  write(repo, DOC, '# calc\n')
  write(repo, 'src/x.ts', 'a\n')
  git(repo, 'add', 'src/x.ts')
  git(repo, 'commit', '-qm', 'x')
  const wt = await createWorktree(repo, tid(), '改 x')
  try {
    await carryModuleDocs(repo, wt.path)
    write(wt.path, 'src/x.ts', 'b\n')
    await commitWorktree(wt, '改 x')
    // 父对话这边也改了同一行并提交：冲突
    write(repo, 'src/x.ts', 'c\n')
    git(repo, 'commit', '-qam', '父对话改 x')
    const r = await integrateBranch(repo, wt, '改 x')
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'conflict')
    assert.equal(readFileSync(path.join(repo, DOC), 'utf8'), '# calc\n', '副本写回了')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})
