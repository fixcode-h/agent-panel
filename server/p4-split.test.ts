import { test } from 'node:test'
import assert from 'node:assert/strict'
import { p4Bucket, parseZtag, splitChangelists, type P4Run } from './p4-split.ts'

test('按扩展名分桶：C++、表格、Lua、其他', () => {
  assert.equal(p4Bucket('//depot/Game/Source/A.cpp'), 'C++')
  assert.equal(p4Bucket('//depot/Game/Source/A.H'), 'C++')
  assert.equal(p4Bucket('D:\\Game\\Config\\Item.xlsx'), 'XLSX')
  assert.equal(p4Bucket('//depot/Data/Map.csv'), 'XLSX')
  assert.equal(p4Bucket('//depot/Script/ui/slot.lua'), 'Lua')
  assert.equal(p4Bucket('//depot/Content/M_Outline.uasset'), 'Other')
  assert.equal(p4Bucket('//depot/Script/ui/slot.luac'), 'Other')
})

test('parseZtag：多条记录按空行分开', () => {
  const recs = parseZtag('... depotFile //a/x.cpp\n... change default\n\n... depotFile //a/y.lua\n... change default\n')
  assert.deepEqual(
    recs.map((r) => r.depotFile),
    ['//a/x.cpp', '//a/y.lua'],
  )
})

/** 假的 p4：记下每次调用，按命令返回预设的输出 */
function fakeP4(files: string[]) {
  const calls: { args: string[]; stdin?: string }[] = []
  let next = 100
  const descs = new Map<string, string>()
  const run: P4Run = async (args, stdin) => {
    calls.push({ args, stdin })
    if (args[1] === 'opened')
      return { ok: true, out: files.map((f) => `... depotFile ${f}\n... change default\n`).join('\n'), err: '' }
    if (args[0] === 'change' && args[1] === '-i') {
      const n = String(next++)
      descs.set(n, /Description:\n\t(.*)\n/.exec(stdin ?? '')?.[1] ?? '')
      return { ok: true, out: `Change ${n} created.`, err: '' }
    }
    if (args[1] === 'fstat')
      return {
        ok: true,
        out: files
          .map((f) => `... depotFile ${f}\n... headRev 3\n... haveRev ${f.endsWith('.lua') ? 2 : 3}\n`)
          .join('\n'),
        err: '',
      }
    if (args[1] === 'describe')
      return { ok: true, out: `... change ${args[3]}\n... desc ${descs.get(args[3])}\n`, err: '' }
    return { ok: true, out: '', err: '' }
  }
  return { run, calls }
}

test('缺某一类的描述：不动任何文件，列出各类文件', async () => {
  const p4 = fakeP4(['//g/Source/Slot.cpp', '//g/Script/slot.lua'])
  const r = await splitChangelists(p4.run, { descriptions: { 'C++': '插槽描边' } })
  assert.equal(r.ok, false)
  assert.match(r.info, /缺 \[Lua\]/)
  assert.ok(!p4.calls.some((c) => c.args[0] === 'change' || c.args[0] === 'reopen'))
})

test('C++ 和 Lua 各建一个 pending，标签以类型为准', async () => {
  const p4 = fakeP4(['//g/Source/Slot.cpp', '//g/Source/Slot.h', '//g/Script/slot.lua'])
  const r = await splitChangelists(p4.run, {
    descriptions: { 'C++': '[C++/Lua] 插槽描边后处理', Lua: '编辑态高亮与 GM 入口' },
  })
  assert.equal(r.ok, true, r.info)
  const made = p4.calls.filter((c) => c.args[0] === 'change' && c.args[1] === '-i').map((c) => c.stdin)
  assert.equal(made.length, 2)
  assert.match(made[0]!, /\t\[C\+\+\] 插槽描边后处理\n/)
  assert.match(made[1]!, /\t\[Lua\] 编辑态高亮与 GM 入口\n/)
  const reopen = p4.calls.filter((c) => c.args[0] === 'reopen').map((c) => c.args)
  assert.deepEqual(reopen, [
    ['reopen', '-c', '100', '//g/Source/Slot.cpp', '//g/Source/Slot.h'],
    ['reopen', '-c', '101', '//g/Script/slot.lua'],
  ])
  assert.ok(!p4.calls.some((c) => c.args.includes('submit')))
  // 落后的文件要列出来交给用户，最新的不提
  assert.match(r.info, /不是最新版本.*slot\.lua（本地 #2，最新 #3）/)
  assert.doesNotMatch(r.info, /Slot\.cpp（本地/)
})

test('拆一个混在一起的 pending：挪空后删掉原来的；只有一类时不动', async () => {
  const p4 = fakeP4(['//g/Source/Slot.cpp', '//g/Script/slot.lua'])
  const r = await splitChangelists(p4.run, { from: '1213390', descriptions: { 'C++': '描边', Lua: '高亮' } })
  assert.equal(r.ok, true, r.info)
  assert.ok(p4.calls.some((c) => c.args.join(' ') === 'change -d 1213390'))

  const one = fakeP4(['//g/Source/Slot.cpp'])
  const r2 = await splitChangelists(one.run, { from: '1213390', descriptions: { 'C++': '描边' } })
  assert.equal(r2.ok, true)
  assert.ok(!one.calls.some((c) => c.args[0] === 'change'))
})
