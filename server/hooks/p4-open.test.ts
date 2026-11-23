/**
 * P4 改前自动签出（内置钩子 p4-auto-open）：已有文件改前 p4 edit 进 default，新文件写完 p4 add，
 * 已经在 pending 里的不动，项目外和 .tmp/ 不管，P4 报错原样补给模型。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { P4Run } from '../p4-split.ts'
import { p4AutoOpen } from './p4-open.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-p4-open-'))
mkdirSync(path.join(dir, 'Source'), { recursive: true })
mkdirSync(path.join(dir, '.tmp'), { recursive: true })
for (const f of ['Source/a.cpp', 'Source/b.lua', 'Source/mine.h', 'Source/local-only.txt', '.tmp/x.txt'])
  writeFileSync(path.join(dir, f), 'x')
const abs = (f: string) => path.join(dir, f)

/** 模拟一个工作区：depot 里有哪些文件、哪些已经在某个 changelist 里打开；照真实 p4 的输出格式答 */
function fakeP4(
  depot: string[],
  openedIn: Record<string, string> = {},
  fail: Record<string, string> = {},
  /** 本地落后的文件：类型和本地 / 最新版本号 */
  revs: Record<string, { type: string; have: number; head: number }> = {},
) {
  const calls: string[][] = []
  const opened = new Map(Object.entries(openedIn).map(([f, cl]) => [abs(f), cl]))
  const inDepot = new Set(depot.map(abs))
  const run: P4Run = async (args) => {
    calls.push(args)
    const files = args.filter((a) => path.isAbsolute(a))
    if (args.includes('fstat')) {
      const out: string[] = []
      const err: string[] = []
      for (const f of files) {
        if (!inDepot.has(f)) {
          err.push(`${f} - no such file(s).`)
          continue
        }
        const rv = revs[path.relative(dir, f)] ?? { type: 'text', have: 3, head: 3 }
        out.push(`... clientFile ${f}`, '... headAction edit', `... headType ${rv.type}`)
        out.push(`... headRev ${rv.head}`, `... haveRev ${rv.have}`)
        if (opened.has(f)) out.push(`... action edit`)
        out.push('')
      }
      return { ok: true, out: out.join('\n'), err: err.join('\n') }
    }
    const verb = args[0]
    if (fail[verb]) return { ok: false, out: '', err: fail[verb] }
    for (const f of files) opened.set(f, 'default')
    return { ok: true, out: files.map((f) => `//g/${path.basename(f)}#1 - opened for ${verb}`).join('\n'), err: '' }
  }
  return { run, calls, opened }
}

const edit = (...files: string[]) => ({
  tool: { kind: 'edit' as const, name: 'Edit', input: {}, path: files[0], paths: files },
})

test('改已有文件前 p4 edit 进 default，同一个文件再改不再问 P4', async () => {
  const p4 = fakeP4(['Source/a.cpp', 'Source/b.lua'])
  const o = p4AutoOpen(dir, p4.run)
  const said = (await o.before(edit(abs('Source/a.cpp')))).context ?? ''
  assert.deepEqual(p4.calls.at(-1), ['edit', '-c', 'default', abs('Source/a.cpp')])
  assert.match(said, /已自动 p4 edit 进 default changelist：Source\/a\.cpp/)
  const n = p4.calls.length
  assert.deepEqual(await o.before(edit(abs('Source/a.cpp'))), {})
  assert.equal(p4.calls.length, n, '同一个文件不再跑 p4')
  // 相对路径（Codex 的补丁、sed -i）按项目目录算
  await o.before(edit('Source/b.lua'))
  assert.deepEqual(p4.calls.at(-1), ['edit', '-c', 'default', abs('Source/b.lua')])
})

test('已经在当前 client 某个 pending 里的文件留在原 changelist，不再 edit', async () => {
  const p4 = fakeP4(['Source/mine.h'], { 'Source/mine.h': '1234' })
  const o = p4AutoOpen(dir, p4.run)
  assert.deepEqual(await o.before(edit(abs('Source/mine.h'))), {})
  assert.ok(!p4.calls.some((c) => c[0] === 'edit'))
  assert.equal(p4.opened.get(abs('Source/mine.h')), '1234')
})

test('新文件（库里没有）写完后 p4 add 进 default；没写出来就不 add', async () => {
  const p4 = fakeP4([])
  const o = p4AutoOpen(dir, p4.run)
  const fresh = abs('Source/new.lua')
  assert.deepEqual(await o.before(edit(fresh)), {})
  assert.ok(!p4.calls.some((c) => c[0] === 'add'), '写之前不 add')
  assert.equal(await o.after(edit(fresh)), '', '工具失败、文件没写出来时不 add')
  writeFileSync(fresh, 'x')
  await o.after(edit(fresh))
  assert.deepEqual(p4.calls.at(-1), ['add', '-c', 'default', fresh])
  // 本地有、库里没有的文件也 add
  await o.before(edit(abs('Source/local-only.txt')))
  await o.after(edit(abs('Source/local-only.txt')))
  assert.deepEqual(p4.calls.at(-1), ['add', '-c', 'default', abs('Source/local-only.txt')])
})

test('代码文件不管远端有没有更新直接签出；没法合并的资源本地落后时拦一次让它先问用户，问过就放行', async () => {
  for (const f of ['Content/Hero.uasset', 'Content/Map.umap']) {
    mkdirSync(path.dirname(abs(f)), { recursive: true })
    writeFileSync(abs(f), 'x')
  }
  const p4 = fakeP4(
    ['Source/a.cpp', 'Content/Hero.uasset', 'Content/Map.umap'],
    {},
    {},
    {
      'Source/a.cpp': { type: 'text', have: 3, head: 9 },
      'Content/Hero.uasset': { type: 'binary+l', have: 2, head: 5 },
      'Content/Map.umap': { type: 'binary+l', have: 7, head: 7 },
    },
  )
  const o = p4AutoOpen(dir, p4.run, 'stale-task')
  const code = await o.before(edit(abs('Source/a.cpp')))
  assert.ok(!code.deny, '代码文件落后也直接签出')
  assert.deepEqual(p4.calls.at(-1), ['edit', '-c', 'default', abs('Source/a.cpp')])
  assert.ok(!(await o.before(edit(abs('Content/Map.umap')))).deny, '资源是最新的就直接签出')
  const r = await o.before(edit(abs('Content/Hero.uasset')))
  assert.match(r.deny ?? '', /没法合并的资源.*Content\/Hero\.uasset（本地 #2，最新 #5）.*问用户/)
  assert.ok(!p4.calls.some((c) => c[0] === 'edit' && c.includes(abs('Content/Hero.uasset'))), '拦下时不签出')
  assert.ok(!p4.calls.some((c) => c[0] === 'sync'), '面板自己不 sync')
  // 用户回答后再改（这一轮之后的下一次调用也一样）：不再拦，签出
  const again = await p4AutoOpen(dir, p4.run, 'stale-task').before(edit(abs('Content/Hero.uasset')))
  assert.ok(!again.deny)
  assert.deepEqual(p4.calls.at(-1), ['edit', '-c', 'default', abs('Content/Hero.uasset')])
})

test('项目外的文件和项目的 .tmp/ 不管', async () => {
  const p4 = fakeP4(['.tmp/x.txt'])
  const o = p4AutoOpen(dir, p4.run)
  await o.before(edit(abs('.tmp/x.txt'), path.join(tmpdir(), 'elsewhere.md'), path.join(dir, '..', 'docs', 'a.md')))
  assert.equal(p4.calls.length, 0)
})

test('P4 拒绝签出（独占锁、没登录）时原样告诉模型，不当成功', async () => {
  const p4 = fakeP4(['Source/a.cpp'], {}, { edit: "//g/a.cpp - can't edit exclusive file already opened" })
  const o = p4AutoOpen(dir, p4.run)
  const said = (await o.before(edit(abs('Source/a.cpp')))).context ?? ''
  assert.match(said, /P4 自动签出失败.*can't edit exclusive file/)
  const down: P4Run = async () => ({ ok: false, out: '', err: 'Perforce password (P4PASSWD) invalid or unset.' })
  assert.match(
    (await p4AutoOpen(dir, down).before(edit(abs('Source/a.cpp')))).context ?? '',
    /P4 自动签出没成功.*P4PASSWD/,
  )
})

test(
  '钩子接到面板上：P4 项目里改文件前真的起 p4 edit，新文件写完起 p4 add',
  { skip: process.platform === 'win32' },
  async () => {
    // 假 p4 命令放在 PATH 最前面：记下每次调用，fstat 按「a.cpp 在库里」回答
    const bin = mkdtempSync(path.join(tmpdir(), 'agent-panel-fake-p4-'))
    const log = path.join(bin, 'calls.log')
    writeFileSync(
      path.join(bin, 'p4'),
      `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *fstat*) for f in "$@"; do case "$f" in */a.cpp) printf '... clientFile %s\\n... headAction edit\\n\\n' "$f";; /*) echo "$f - no such file(s)." >&2;; esac; done;;
  *where*) echo "... path $PWD";;
  *) echo "//g/x#1 - opened";;
esac
`,
    )
    chmodSync(path.join(bin, 'p4'), 0o755)
    const proj = mkdtempSync(path.join(tmpdir(), 'agent-panel-p4-proj-'))
    writeFileSync(path.join(proj, '.p4config'), 'P4CLIENT=c\n')
    writeFileSync(path.join(proj, 'a.cpp'), 'x')
    const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-p4-data-'))
    process.env.AGENT_PANEL_DATA = data
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    const { ProjectInput, Task } = await import('../../shared/schema.ts')
    const { hookOptions } = await import('./dispatch.ts')
    const at = '2026-11-23T00:00:00.000Z'
    const h = await hookOptions({
      task: Task.parse({
        id: 'tp4',
        projectId: 'pp4',
        title: 't',
        mode: 'chat',
        status: 'running',
        createdAt: at,
        updatedAt: at,
      }),
      project: { ...ProjectInput.parse({ name: 'p', path: proj }), id: 'pp4' },
      agent: { id: 'a1', name: '执行', origin: '' },
      agents: [],
      cliId: 'claude',
      cwd: proj,
      call: { agentId: 'a1', prompt: '', sessionKey: 'a1', orch: { helper: false, coordinator: false } } as never,
      mark: () => {},
    } as never)
    assert.ok(h.hookEvents?.includes('tool.before') && h.hookEvents.includes('tool.after'))
    assert.ok(h.hookTools?.['tool.before']?.includes('edit') && h.hookTools['tool.after']?.includes('edit'))
    const before = await h.onHook!('tool.before', edit(path.join(proj, 'a.cpp')))
    assert.ok(!before.deny, before.reason ?? '')
    assert.match(before.context ?? '', /已自动 p4 edit/)
    await h.onHook!('tool.before', edit(path.join(proj, 'new.lua')))
    writeFileSync(path.join(proj, 'new.lua'), 'x')
    await h.onHook!('tool.after', edit(path.join(proj, 'new.lua')))
    const calls = readFileSync(log, 'utf8')
    assert.match(calls, new RegExp(`^edit -c default ${path.join(proj, 'a.cpp')}$`, 'm'))
    assert.match(calls, new RegExp(`^add -c default ${path.join(proj, 'new.lua')}$`, 'm'))
  },
)
