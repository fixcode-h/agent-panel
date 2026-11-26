import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatVcsStatus, vcsStatus, type VcsStatusReport } from './status.ts'
import { gitRun } from '../exec/git.ts'

test('vcs_status 文字：二进制又落后 / 别人开着的排最前并标「要先问用户」，计数对得上', () => {
  const r: VcsStatusReport = {
    vcs: 'p4',
    rows: [
      { file: 'Script/a.lua', action: 'edit', add: 12, del: 3 },
      { file: 'Data/b.xlsx', action: 'edit', behind: true, have: 3, head: 5, others: ['alice@ws'], binary: true },
      { file: 'Data/c.xlsx', action: 'edit', binary: true },
    ],
  }
  const s = formatVcsStatus(r)
  assert.match(s, /^P4 · 3 个文件，落后 1，别人也开着 1，二进制 2/)
  assert.match(s, /【要先问用户】Data\/b\.xlsx：/)
  const lines = s.split('\n')
  assert.match(lines[2], /^- Data\/b\.xlsx +edit · 落后：本地 #3 \/ 库里 #5 · 别人也开着：alice@ws · 二进制$/)
  assert.ok(lines.some((l) => /^- Script\/a\.lua +edit · \+12 −3$/.test(l)))
})

test('vcs_status 文字：行太多时截断并说还有几个，不超过约 4000 字', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    file: `Some/Long/Path/To/File_${i}_${'x'.repeat(40)}.lua`,
    add: i,
    del: 0,
  }))
  const s = formatVcsStatus({ vcs: 'git', rows })
  assert.ok(s.length < 4000, `${s.length}`)
  assert.match(s, /还有 \d+ 个没列出：用 files 点名要看的。/)
})

test('P4：点名的文件问 fstat，没点名时再问工作目录下打开着的，落后、别人开着、二进制、加减行数都取到', async () => {
  const root = path.join(tmpdir(), 'p4ws')
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args.includes('fstat') && args.includes('-Ro'))
      return {
        ok: true,
        out: `... clientFile ${root}/Data/b.xlsx\n... action edit\n... headType binary+l\n... headRev 5\n... haveRev 3\n... otherOpen 1\n... otherOpen0 alice@ws`,
        err: '',
      }
    if (args.includes('fstat'))
      return {
        ok: true,
        out: `... clientFile ${root}/Script/a.lua\n... action edit\n... headType text\n... headRev 2\n... haveRev 2`,
        err: '',
      }
    if (args[0] === 'diff')
      return {
        ok: true,
        out: `==== //d/Script/a.lua#2 - ${root}/Script/a.lua ====\nadd 1 chunks 4 lines\ndeleted 0 chunks 0 lines\nchanged 0 chunks 0 / 0 lines`,
        err: '',
      }
    return { ok: false, out: '', err: '' }
  }
  // 不是真的 P4 工作区：直接测 P4 那一支，detectVcs 判不出来时会走「没有版本管理」
  const { p4StatusForTest } = await import('./status.ts')
  const r = await p4StatusForTest({ root, changes: [{ path: 'Script/a.lua', add: 1, del: 0 }], p4: run })
  const b = r.rows.find((x) => x.file === 'Data/b.xlsx')
  assert.deepEqual(b, {
    file: 'Data/b.xlsx',
    action: 'edit',
    behind: true,
    have: 3,
    head: 5,
    others: ['alice@ws'],
    binary: true,
  })
  assert.deepEqual(
    r.rows.find((x) => x.file === 'Script/a.lua'),
    { file: 'Script/a.lua', action: 'edit', add: 4, del: 0 },
  )
  assert.ok(calls.some((c) => c.includes('-Ro')))
})

test('Git：列出这个对话的改动、新文件、二进制；没有上游时写明不比远端', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vcs-status-'))
  await gitRun(root, ['init', '-q'])
  await gitRun(root, ['config', 'user.email', 'a@b.c'])
  await gitRun(root, ['config', 'user.name', 't'])
  await writeFile(path.join(root, 'a.txt'), 'one\n')
  await writeFile(path.join(root, 'b.bin'), Buffer.from([0, 1, 2, 3]))
  await gitRun(root, ['add', '.'])
  await gitRun(root, ['commit', '-qm', 'init'])
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n')
  await writeFile(path.join(root, 'b.bin'), Buffer.from([0, 9, 9]))
  await mkdir(path.join(root, 'n'))
  await writeFile(path.join(root, 'n/new.lua'), 'x\ny\n')
  const r = await vcsStatus({
    root,
    changes: [
      { path: 'a.txt', add: 1, del: 0 },
      { path: 'b.bin', add: 0, del: 0 },
      { path: 'n/new.lua', add: 2, del: 0 },
    ],
  })
  assert.equal(r.vcs, 'git')
  assert.deepEqual(r.rows, [
    { file: 'a.txt', add: 1, del: 0 },
    { file: 'b.bin', add: 0, del: 0, binary: true },
    { file: 'n/new.lua', action: 'untracked', add: 2, del: 0 },
  ])
  assert.match(r.note ?? '', /没有上游/)
})
