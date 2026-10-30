import assert from 'node:assert/strict'
import test from 'node:test'
import { exportToReplay, exportTurns } from './replay-export.mjs'

const at = (s) => `2026-10-01T00:00:${String(s).padStart(2, '0')}.000Z`
const msg = (role, s, extra = {}) => ({ id: `${role}${s}`, role, text: '', tools: [], at: at(s), ...extra })

test('导出包转录像：每条用户消息开一轮，工具拼成 tool_use + tool_result，时间换成 _t', () => {
  const bundle = {
    task: {
      messages: [
        msg('user', 0, { text: '改角标' }),
        msg('agent', 2, {
          text: '先读一下',
          thinking: '看组件',
          tools: [{ kind: 'read', label: 'src/Badge.tsx', output: '1\tcode', ms: 500 }],
        }),
        msg('agent', 5, { text: '改好了' }),
        msg('user', 10, { text: '再看看' }),
        msg('user', 11, { text: '【面板】接着做' }),
        msg('agent', 13, { tools: [{ kind: 'run', label: 'npm test', input: 'npm test', failed: true }] }),
      ],
    },
    children: [{ id: 'k', messages: [msg('user', 0, { text: 'x' }), msg('agent', 1, { text: 'y' })] }],
  }
  assert.equal(exportTurns(bundle.task.messages).length, 2, '连着的两条用户消息算一轮')
  const lines = exportToReplay(bundle)
  const results = lines.filter((l) => l.type === 'result')
  assert.deepEqual(
    results.map((r) => r.result),
    ['改好了', ''],
  )
  const use = lines.find((l) => l.type === 'assistant').message.content
  assert.deepEqual(use[1], { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/Badge.tsx' } })
  const res = lines.find((l) => l.type === 'user')
  assert.equal(res._t, 2500)
  assert.equal(res.message.content[0].content, '1\tcode')
  const bash = lines.filter((l) => l.type === 'assistant').at(-1).message.content[0]
  assert.deepEqual([bash.name, bash.input.command], ['Bash', 'npm test'])
  assert.equal(lines.filter((l) => l.type === 'user').at(-1).message.content[0].is_error, true)
  assert.equal(exportToReplay(bundle, 'k').filter((l) => l.type === 'result').length, 1, '可以只取一个子对话')
  assert.throws(() => exportToReplay(bundle, 'nope'), /没有 id 为 nope/)
})
