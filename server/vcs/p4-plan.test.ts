// P4 改文件前后的签出规则（server/vcs/p4-plan.ts）：钩子、UE 保存、表格保存共用。用例从 UE 插件的 p4-checkout.test.ts 搬来
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import type { P4Run } from '../p4-split.ts'
import { p4Open, p4WritePlan } from './p4-plan.ts'

const root = path.resolve('/proj')
const f = (n: string) => path.join(root, 'Content', n)
const all = () => true

/** 假 p4：depot 里有哪些文件、哪些已经打开；照 -ztag fstat 的格式答 */
function fake(
  depot: Record<string, { action?: string; headAction?: string; type?: string; have?: number; head?: number }>,
  err = '',
) {
  const calls: string[][] = []
  const run: P4Run = async (args) => {
    calls.push(args)
    const out: string[] = []
    const errs: string[] = err ? [err] : []
    for (const a of args.filter((x) => path.isAbsolute(x))) {
      const d = depot[a]
      if (!d) {
        errs.push(`${a} - no such file(s).`)
        continue
      }
      out.push(
        `... clientFile ${a}`,
        `... headAction ${d.headAction ?? 'edit'}`,
        `... headType ${d.type ?? 'binary+l'}`,
      )
      out.push(`... headRev ${d.head ?? 4}`, `... haveRev ${d.have ?? 4}`)
      if (d.action) out.push(`... action ${d.action}`)
    }
    return { ok: true, out: out.join('\n'), err: errs.join('\n') }
  }
  return { run, calls }
}

test('可写但没打开的也签出（以前只签只读的，改动不进变更列表）', async () => {
  const p = fake({ [f('A.uasset')]: {}, [f('B.uasset')]: {} })
  const plan = await p4WritePlan(p.run, [f('A.uasset'), f('B.uasset')], all)
  assert.deepEqual(plan, { edit: [f('A.uasset'), f('B.uasset')], add: [], opened: [], stale: [] })
})

test('已经在某个 pending 里的留在原处；库里没有、库里已删除、本地没有的写完后 add', async () => {
  const p = fake({
    [f('Open.uasset')]: { action: 'edit' },
    [f('Gone.uasset')]: { headAction: 'delete' },
    [f('Missing.uasset')]: {},
  })
  const files = [f('Open.uasset'), f('Gone.uasset'), f('Local.uasset'), f('Missing.uasset')]
  const plan = await p4WritePlan(p.run, files, (x) => x !== f('Missing.uasset'))
  assert.deepEqual(plan, {
    edit: [],
    add: [f('Gone.uasset'), f('Local.uasset'), f('Missing.uasset')],
    opened: [f('Open.uasset')],
    stale: [],
  })
})

test('不在 client 视图里的不管；连不上、没登录原样报错', async () => {
  const out = path.resolve('/elsewhere/X.uasset')
  const view = fake({}, `${out} - file(s) not in client view.`)
  assert.deepEqual(await p4WritePlan(view.run, [out], all), { edit: [], add: [], opened: [], stale: [] })
  const down: P4Run = async () => ({ ok: false, out: '', err: 'Perforce password (P4PASSWD) invalid or unset.' })
  assert.match((await p4WritePlan(down, [f('A.uasset')], all)).error ?? '', /P4PASSWD/)
  assert.deepEqual(await p4WritePlan(down, [], all), { edit: [], add: [], opened: [], stale: [] })
})

test('本地落后的二进制资源列出来让调用方先问；落后的文本文件不算（代码不看远端）', async () => {
  const p = fake({
    [f('Old.uasset')]: { have: 2, head: 5 },
    [f('New.uasset')]: { have: 5, head: 5 },
    [f('Cfg.ini')]: { type: 'text', have: 1, head: 3 },
  })
  const plan = await p4WritePlan(p.run, [f('Old.uasset'), f('New.uasset'), f('Cfg.ini')], all)
  assert.deepEqual(plan.edit, [f('Old.uasset'), f('New.uasset'), f('Cfg.ini')])
  assert.deepEqual(plan.stale, [{ file: f('Old.uasset'), have: 2, head: 5 }])
  assert.ok(!p.calls.some((c) => c[0] === 'sync'), '不替用户更新')
})

test('p4Open：已打开、被忽略不算错；被锁住原样返回', async () => {
  const ok: P4Run = async () => ({ ok: true, out: '', err: 'x - currently opened for edit' })
  assert.equal(await p4Open(ok, 'edit', [f('A.uasset')]), undefined)
  const ign: P4Run = async () => ({ ok: false, out: '', err: "x - ignored file can't be added." })
  assert.equal(await p4Open(ign, 'add', [f('A.uasset')]), undefined)
  const locked: P4Run = async () => ({ ok: false, out: '', err: "x - can't edit exclusive file already opened" })
  assert.match((await p4Open(locked, 'edit', [f('A.uasset')])) ?? '', /exclusive/)
  assert.equal(await p4Open(locked, 'edit', []), undefined)
})
