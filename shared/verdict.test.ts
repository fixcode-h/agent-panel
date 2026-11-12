import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteVerdictText } from './verdict.ts'
import { readFileSync } from 'node:fs'

// 结论只认 submit_verdict（ADR 0049 第三期）：旧版角色、节点里「最后一行写验收结论」的要求改写成调用工具，别的原样

test('三种旧说法都改成调用 submit_verdict；没有旧说法的原样返回', () => {
  assert.equal(
    rewriteVerdictText('逐条写证据。最后单独一行写「验收结论：通过」或「验收结论：不通过」。'),
    '逐条写证据。最后调用 submit_verdict 交结论（verdict 写 pass 或 fail），不通过时 blockers 写失败项。',
  )
  assert.equal(
    rewriteVerdictText('失败的逐条列出。最后一行写「验证结论：通过」或「验证结论：不通过」。'),
    '失败的逐条列出。最后调用 submit_verdict 交结论（verdict 写 pass 或 fail），不通过时 blockers 写失败项。',
  )
  assert.equal(
    rewriteVerdictText('有 🛑 时最后一行写「验收结论：不通过」，否则写「验收结论：通过」。'),
    '有 🛑 时调用 submit_verdict 交 fail（blockers 写失败项），否则交 pass。',
  )
  const plain = '照常做完，写清改了什么。'
  assert.equal(rewriteVerdictText(plain), plain)
})

test('内置模板里已经没有「写一行验收结论」的要求', () => {
  for (const f of ['workflows.ts', 'agents.ts'])
    assert.doesNotMatch(
      readFileSync(new URL(`./builtin/${f}`, import.meta.url), 'utf8'),
      /一行写「(验收|验证)?结论：/,
      f,
    )
})

test('启动迁移：只改带旧说法的角色和工作流，其余不写盘', async () => {
  const { migrateVerdictText } = await import('../server/verdict-migrate.ts')
  const writes: string[] = []
  const coll = <T extends { id: string }>(items: T[]) => ({
    list: async () => items,
    update: async (id: string) => void writes.push(id),
  })
  await migrateVerdictText(
    coll([
      { id: 'a1', instructions: '最后单独一行写「验收结论：通过」或「验收结论：不通过」。' },
      { id: 'a2', instructions: '照常做完' },
    ]),
    coll([
      {
        id: 'w1',
        document: '',
        flows: [{ nodes: [{ instructions: '最后一行写「验证结论：通过」或「验证结论：不通过」。' }] }],
      },
      { id: 'w2', document: '说明', flows: [{ nodes: [{ instructions: '做事' }] }] },
    ]),
  )
  assert.deepEqual(writes, ['a1', 'w1'])
})
