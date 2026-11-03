import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '../shared/schema.ts'
import type { P4Run } from './p4-split.ts'

// 数据目录换成临时的：目标分支没检出时面板在数据目录里开工作目录（有冲突时留给用户），不能碰真正的 ~/.agent-panel
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'ap-pick-data-'))
const { cherryPickGit, cherryPickP4, userAsked } = await import('./cherry-pick.ts')

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

test('cherry-pick（P4）：pending 的改动三方合并进目标（不要求是这个对话改的），在目标建对应的 pending，不 submit', async () => {
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
    // 不要求是这个对话改的（P4 只守「不 submit」）：对话里一个文件都没改过也照样搬
    const ok = await cherryPickP4(root, target, taskOf([]), '7', p4)
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

test('cherry-pick（P4）：已经 submit 的 changelist 按「提交前一版 → 提交的版本」三方合并进目标，新增删除照搬，不 submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-pick-src-'))
  const target = mkdtempSync(path.join(tmpdir(), 'ap-pick-dst-'))
  try {
    mkdirSync(path.join(root, 'src'))
    mkdirSync(path.join(target, 'src'))
    // 提交之后本地又改过：搬的必须是提交的那一版，不是本地现在的
    writeFileSync(path.join(root, 'src/a.lua'), 'one\ntwo\nthree\nfour\nFIVE\nlocal later\n')
    writeFileSync(path.join(target, 'src/a.lua'), 'ONE\ntwo\nthree\nfour\nfive\n')
    writeFileSync(path.join(target, 'src/old.lua'), 'old\n')
    // 每个 depot 文件各个版本的内容：a.lua #3 是提交前，#4 是这次提交的；new.lua #1 是这次新增的
    const revs: Record<string, string> = {
      '//d/src/a.lua#3': 'one\ntwo\nthree\nfour\nfive\n',
      '//d/src/a.lua#4': 'one\ntwo\nthree\nfour\nFIVE\n',
      '//d/src/new.lua#1': 'new\n',
    }
    const calls: string[][] = []
    const p4 =
      (cwd: string): P4Run =>
      async (args, stdin) => {
        calls.push([cwd === target ? 'dst' : 'src', ...args, ...(stdin ? [stdin] : [])])
        const [cmd] = args.filter((x) => x !== '-ztag')
        if (cmd === 'describe')
          return {
            ok: true,
            out: [
              '... change 9',
              // 真实输出里多行描述带空行：不能因此把 status / depotFile 分到另一条记录
              '... desc 修复跑测图标',
              'https://example.com/issue/1',
              '',
              '... status submitted',
              '... depotFile0 //d/src/a.lua',
              '... action0 edit',
              '... rev0 4',
              '... depotFile1 //d/src/new.lua',
              '... action1 add',
              '... rev1 1',
              '... depotFile2 //d/src/old.lua',
              '... action2 delete',
              '... rev2 2',
            ].join('\n'),
            err: '',
          }
        if (cmd === 'opened') return { ok: true, out: '', err: '' }
        if (cmd === 'where') {
          const f = args.at(-1)!.replace('//d/', '')
          return { ok: true, out: `... path ${path.join(root, f)}`, err: '' }
        }
        if (cmd === 'print') {
          const spec = args.at(-1)!
          if (!(spec in revs)) return { ok: false, out: '', err: `${spec} - no such file(s).` }
          writeFileSync(args[args.indexOf('-o') + 1], revs[spec])
          return { ok: true, out: '', err: '' }
        }
        if (cmd === 'change') return { ok: true, out: 'Change 43 created.', err: '' }
        return { ok: true, out: '', err: '' }
      }
    const ok = await cherryPickP4(root, target, taskOf(['src/a.lua']), '9', p4)
    assert.equal(ok.ok, true, ok.info)
    assert.ok(!calls.some((c) => c[1] === 'opened'), '已提交的不按打开的文件找')
    assert.equal(
      readFileSync(path.join(target, 'src/a.lua'), 'utf8'),
      'ONE\ntwo\nthree\nfour\nFIVE\n',
      '只带提交里改的那一行，目标原有差异保留，本地提交后又改的不带',
    )
    assert.equal(readFileSync(path.join(target, 'src/new.lua'), 'utf8'), 'new\n', '新增的按提交的版本放过去')
    assert.ok(
      calls.some((c) => c[0] === 'dst' && c[1] === 'delete'),
      '删除的在目标里也删',
    )
    assert.match(ok.info, /已提交的 changelist 9[\s\S]*changelist 43[\s\S]*没有 submit/)
    const made = calls.find((c) => c[0] === 'dst' && c[1] === 'change')
    assert.match(made?.at(-1) ?? '', /修复跑测图标（cherry-pick 自 9）/)
    assert.ok(!calls.some((c) => c.includes('submit')), '不 submit')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('cherry-pick（P4）：别的 stream 上用户自己提交的 changelist，按 stream 换算路径搬过去', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-pick-src-'))
  const target = mkdtempSync(path.join(tmpdir(), 'ap-pick-dst-'))
  try {
    // 目标也是同一个项目目录（另一个工作区里的 Game）：相对路径一样
    mkdirSync(path.join(target, 'Src'), { recursive: true })
    writeFileSync(path.join(target, 'Src/a.lua'), 'ONE\ntwo\nthree\nfour\nfive\n')
    writeFileSync(path.join(target, 'Src/gone.lua'), 'gone\n')
    // 子流上的提交：当前工作区在父流 //depot/Dev，映射里没有 //depot/1.0_official_dev 的文件
    const revs: Record<string, string> = {
      '//depot/1.0_official_dev/Game/Src/a.lua#6': 'one\ntwo\nthree\nfour\nfive\n',
      '//depot/1.0_official_dev/Game/Src/a.lua#7': 'one\ntwo\nthree\nfour\nFIVE\n',
    }
    const calls: string[][] = []
    const p4 =
      (cwd: string): P4Run =>
      async (args, stdin) => {
        calls.push([cwd === target ? 'dst' : 'src', ...args, ...(stdin ? [stdin] : [])])
        const [cmd] = args.filter((x) => x !== '-ztag')
        if (cmd === 'describe')
          return {
            ok: true,
            out: [
              '... change 1259263',
              '... status submitted',
              '... desc 修复 hong_main',
              '... depotFile0 //depot/1.0_official_dev/Game/Src/a.lua',
              '... action0 integrate',
              '... rev0 7',
              '... depotFile1 //depot/1.0_official_dev/Game/Src/gone.lua',
              '... action1 delete',
              '... rev1 3',
            ].join('\n'),
            err: '',
          }
        if (cmd === 'client') return { ok: true, out: '... Client hong_main\n... Stream //depot/Dev', err: '' }
        if (cmd === 'where') {
          // 项目目录映射到父流里的 Game 子目录；子流的文件不在这个工作区的映射里
          if (args.at(-1)!.endsWith('...'))
            return { ok: true, out: `... depotFile //depot/Dev/Game/...\n... path ${root}/...`, err: '' }
          return { ok: false, out: '', err: 'file(s) not in client view.' }
        }
        if (cmd === 'print') {
          const spec = args.at(-1)!
          if (!(spec in revs)) return { ok: false, out: '', err: `${spec} - no such file(s).` }
          writeFileSync(args[args.indexOf('-o') + 1], revs[spec])
          return { ok: true, out: '', err: '' }
        }
        if (cmd === 'change') return { ok: true, out: 'Change 44 created.', err: '' }
        return { ok: true, out: '', err: '' }
      }
    const said = (text: string) => ({ changes: [], messages: [{ role: 'user', text, tools: [] }] }) as unknown as Task
    const ok = await cherryPickP4(root, target, said('把 CL 1259263 cherry-pick 到 Dev'), '1259263', p4)
    assert.equal(ok.ok, true, ok.info)
    assert.equal(
      readFileSync(path.join(target, 'Src/a.lua'), 'utf8'),
      'ONE\ntwo\nthree\nfour\nFIVE\n',
      '子流提交的改动合进目标，目标原有差异保留',
    )
    assert.ok(
      calls.some((c) => c[0] === 'dst' && c[1] === 'delete' && c.at(-1)!.endsWith(path.join('Src', 'gone.lua'))),
      '删除的文件在目标里也删',
    )
    assert.ok(!calls.some((c) => ['integrate', 'copy', 'merge', 'submit'].includes(c[1])), '不跑流间集成，不 submit')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('cherry-pick：用户最近几条消息里要求过就算，不用按固定说法回复；「提到」这类不算', () => {
  const msgs = (...xs: [string, string][]) =>
    ({ messages: xs.map(([role, text]) => ({ role, text })) }) as unknown as Task
  // 用户先说要搬、Agent 问一句、用户补一句：补的那句没有关键词也算
  assert.equal(
    userAsked(msgs(['user', '把这个 cherry-pick 过去'], ['agent', '要搬哪些？'], ['user', '只要 lua']), 'release'),
    true,
  )
  assert.equal(userAsked(msgs(['user', '这个也搬过去吧']), 'release'), true)
  // 很早以前说过，后面又聊了好几句别的：不算
  assert.equal(
    userAsked(msgs(['user', 'cherry-pick 过去'], ['user', 'a'], ['user', 'b'], ['user', 'c']), 'release'),
    false,
  )
  assert.equal(userAsked(msgs(['user', '你提到的那个问题再看看']), 'release'), false)
})

test('cherry-pick（Git）：有冲突不撤回，停在冲突的提交上留给用户解决，写清目录和冲突文件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-pick-conflict-'))
  try {
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'config', 'user.name', 't')
    sh(dir, 'config', 'user.email', 't@t')
    commit(dir, 'a.txt', 'a\n', 'base')
    sh(dir, 'branch', 'release')
    sh(dir, 'checkout', '-q', 'release')
    commit(dir, 'a.txt', 'release\n', 'release change')
    sh(dir, 'checkout', '-q', 'main')
    const mine = commit(dir, 'a.txt', 'mine\n', 'my fix')
    const r = await cherryPickGit(dir, 'release', taskOf(['a.txt']), [mine])
    assert.equal(r.ok, true, r.info)
    assert.match(r.info, /有冲突[\s\S]*a\.txt[\s\S]*git cherry-pick --continue/)
    const at = /目录：(.+)/.exec(r.info)?.[1]?.trim() ?? ''
    assert.ok(at && at.startsWith(process.env.AGENT_PANEL_DATA!), '目标分支没检出时在数据目录里开工作目录')
    assert.match(readFileSync(path.join(at, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/, '冲突留在文件里')
    assert.equal(sh(dir, 'branch', '--show-current'), 'main', '不动当前目录')
    // 冲突没解决前再搬：那个目录不干净，说清楚
    const again = await cherryPickGit(dir, 'release', taskOf(['a.txt']), [mine])
    assert.equal(again.ok, false)
    assert.match(again.info, /没提交的改动/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cherry-pick（P4）：和目标撞在一起时不撤回，冲突标记写进目标文件、照样打开在 pending 里，留给用户解决', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-pick-src-'))
  const target = mkdtempSync(path.join(tmpdir(), 'ap-pick-dst-'))
  try {
    mkdirSync(path.join(root, 'src'))
    mkdirSync(path.join(target, 'src'))
    writeFileSync(path.join(root, 'src/a.lua'), 'one\nFIVE\n')
    // 目标里同一行也改过：合不上
    writeFileSync(path.join(target, 'src/a.lua'), 'one\nfive-target\n')
    const calls: string[][] = []
    const p4 =
      (cwd: string): P4Run =>
      async (args) => {
        calls.push([cwd === target ? 'dst' : 'src', ...args])
        const [cmd] = args.filter((x) => x !== '-ztag')
        if (cmd === 'opened') return { ok: true, out: '... depotFile //d/src/a.lua\n... action edit', err: '' }
        if (cmd === 'where')
          return { ok: true, out: `... path ${path.join(root, args.at(-1)!.replace('//d/', ''))}`, err: '' }
        if (cmd === 'print') {
          writeFileSync(args[args.indexOf('-o') + 1], 'one\nfive\n')
          return { ok: true, out: '', err: '' }
        }
        if (cmd === 'change') return { ok: true, out: 'Change 43 created.', err: '' }
        return { ok: true, out: '', err: '' }
      }
    const r = await cherryPickP4(root, target, taskOf([]), '8', p4)
    assert.equal(r.ok, true, r.info)
    assert.match(r.info, /a\.lua（编辑，有冲突）[\s\S]*留给用户解决/)
    assert.match(readFileSync(path.join(target, 'src/a.lua'), 'utf8'), /<<<<<<< target[\s\S]*FIVE[\s\S]*>>>>>>> mine/)
    assert.ok(
      calls.some((c) => c[0] === 'dst' && c[1] === 'edit'),
      '冲突的文件也打开在目标的 pending 里',
    )
    assert.ok(!calls.some((c) => c.includes('submit')), '不 submit')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
