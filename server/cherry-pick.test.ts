import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '../shared/schema.ts'
import { cherryPickGit, cherryPickP4, userAsked } from './cherry-pick.ts'
import type { P4Run } from './p4-split.ts'

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(path.join(cwd, file), text)
  sh(cwd, 'add', '-A')
  sh(cwd, 'commit', '-q', '-m', msg)
  return sh(cwd, 'rev-parse', 'HEAD')
}
/** 这个对话改过哪些文件：按改文件的工具调用记 */
const taskOf = (files: string[], createdAt = new Date(Date.now() - 3600_000).toISOString()) =>
  ({
    createdAt,
    changes: [],
    messages: [{ role: 'agent', tools: files.map((f) => ({ kind: 'edit', label: f })) }],
  }) as unknown as Task

test('cherry-pick（Git）：只收这个对话自己的提交，混了别的文件、合并提交的整次拒绝，目标分支原有内容不动', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-pick-test-'))
  try {
    sh(dir, 'init', '-q', '-b', 'main')
    // 面板执行 cherry-pick 时用的是仓库自己的提交身份：CI 机器上没有全局配置，这里给仓库设上
    sh(dir, 'config', 'user.name', 't')
    sh(dir, 'config', 'user.email', 't@t')
    commit(dir, 'a.txt', 'a\n', 'base')
    sh(dir, 'branch', 'release')
    // 目标分支上本来就有、当前分支没有的内容：搬完要原样留着
    sh(dir, 'checkout', '-q', 'release')
    commit(dir, 'only-release.txt', 'r\n', 'release only')
    sh(dir, 'checkout', '-q', 'main')
    // 当前分支上别人的提交（不是这个对话改的文件）
    const foreign = commit(dir, 'other.txt', 'x\n', 'someone else')
    const mine = commit(dir, 'a.txt', 'a\nmine\n', 'my fix')
    const task = taskOf(['a.txt'])

    // 执不执行由用户说了算：用户这条消息里提了 cherry-pick / 合到目标才算，面板自己推的消息不算
    const said = (text: string, extra = {}) => ({ messages: [{ role: 'user', text, ...extra }] }) as unknown as Task
    assert.equal(userAsked(said('把这次的修复 cherry-pick 到 release'), 'release'), true)
    assert.equal(userAsked(said('这个也合到 release/1.2 上'), 'release/1.2'), true)
    assert.equal(userAsked(said('修一下跑测图标'), 'release'), false)
    assert.equal(userAsked(said('cherry-pick 过去', { panel: 'build' }), 'release'), false)

    const mixed = await cherryPickGit(dir, 'release', task, [foreign, mine])
    assert.equal(mixed.ok, false)
    assert.match(mixed.info, /other\.txt[\s\S]*不是只含这次修改的提交/)
    assert.equal(sh(dir, 'log', '--format=%s', '-1', 'release'), 'release only', '有一个不合格整次都不做')

    const ok = await cherryPickGit(dir, 'release', task, [mine])
    assert.equal(ok.ok, true, ok.info)
    assert.equal(sh(dir, 'show', 'release:a.txt'), 'a\nmine')
    assert.equal(sh(dir, 'show', 'release:only-release.txt'), 'r', '目标分支原有的内容不动')
    assert.throws(() => sh(dir, 'show', 'release:other.txt'), '别人的提交没被带过去')
    assert.equal(sh(dir, 'branch', '--show-current'), 'main', '不动当前目录')

    // 对话开始前的提交不算这个对话的
    const old = await cherryPickGit(dir, 'release', taskOf(['a.txt'], new Date(Date.now() + 3600_000).toISOString()), [
      mine,
    ])
    assert.match(old.info, /在这个对话开始之前就提交了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cherry-pick（P4）：只搬这个对话改的文件、三方合并进目标，在目标建对应的 pending，不 submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-pick-src-'))
  const target = mkdtempSync(path.join(tmpdir(), 'ap-pick-dst-'))
  try {
    mkdirSync(path.join(root, 'src'))
    mkdirSync(path.join(target, 'src'))
    // 这次改完的样子：第五行改成 FIVE（have 版本见下面的 print）
    writeFileSync(path.join(root, 'src/a.lua'), 'one\ntwo\nthree\nfour\nFIVE\n')
    // 打开了但没改的文件：和 have 一样，跳过
    writeFileSync(path.join(root, 'src/b.lua'), 'one\ntwo\nthree\n')
    writeFileSync(path.join(target, 'src/b.lua'), 'x\n')
    // 目标分支本来就和这里不同的行（第一行）：不是这次的修改，要原样留着
    writeFileSync(path.join(target, 'src/a.lua'), 'ONE\ntwo\nthree\nfour\nfive\n')
    const calls: string[][] = []
    const p4 =
      (cwd: string): P4Run =>
      async (args, stdin) => {
        calls.push([cwd === target ? 'dst' : 'src', ...args, ...(stdin ? [stdin] : [])])
        const [cmd] = args.filter((x) => x !== '-ztag')
        if (cmd === 'opened')
          return {
            ok: true,
            out: [
              '... depotFile //d/src/a.lua',
              '... action edit',
              '',
              '... depotFile //d/src/b.lua',
              '... action edit',
            ].join('\n'),
            err: '',
          }
        if (cmd === 'where') {
          const f = args.at(-1)!.replace('//d/', '')
          return { ok: true, out: `... path ${path.join(root, f)}`, err: '' }
        }
        if (cmd === 'print') {
          // have 版本：打开前的内容
          writeFileSync(
            args[args.indexOf('-o') + 1],
            args.at(-1)!.includes('a.lua') ? 'one\ntwo\nthree\nfour\nfive\n' : 'one\ntwo\nthree\n',
          )
          return { ok: true, out: '', err: '' }
        }
        if (cmd === 'describe') return { ok: true, out: '... desc 修复跑测图标', err: '' }
        if (cmd === 'change') return { ok: true, out: 'Change 42 created.', err: '' }
        return { ok: true, out: '', err: '' }
      }
    const rejected = await cherryPickP4(root, target, taskOf([path.join(root, 'src/a.lua')]), '7', p4)
    assert.equal(rejected.ok, false)
    assert.match(rejected.info, /src\/b\.lua：这个对话没有改过它/)
    assert.equal(calls.filter((c) => c[0] === 'dst').length, 0, '不合格时目标工作区一点没动')

    const ok = await cherryPickP4(root, target, taskOf(['src/a.lua', 'src/b.lua']), '7', p4)
    assert.equal(ok.ok, true, ok.info)
    assert.equal(
      readFileSync(path.join(target, 'src/a.lua'), 'utf8'),
      'ONE\ntwo\nthree\nfour\nFIVE\n',
      '只改这次改的行，目标原有的差异保留',
    )
    assert.equal(readFileSync(path.join(target, 'src/b.lua'), 'utf8'), 'x\n', '打开了没改的文件不搬')
    assert.match(ok.info, /changelist 42[\s\S]*没有 submit/)
    const made = calls.find((c) => c[0] === 'dst' && c[1] === 'change')
    assert.match(made?.at(-1) ?? '', /修复跑测图标（cherry-pick 自 7）/, '对应的 pending 沿用来源的描述')
    assert.ok(!calls.some((c) => c.includes('submit')), '不 submit')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
