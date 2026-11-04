import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：记忆真的写盘
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-chat-memory-'))
const { chatMemoryFor, forget, MEMORY_MAX, readChatMemory, remember } = await import('./chat-memory.ts')
const { memoryPart } = await import('../shared/chat-prompt.ts')

test('remember：记一句话，一样的不重复记，太长的不收', async () => {
  assert.equal((await remember('  用户叫小王  ')).ok, true)
  assert.match((await remember('用户叫小王')).info, /已经记过/)
  assert.equal((await remember('')).ok, false)
  assert.equal((await remember('长'.repeat(301))).ok, false)
  assert.deepEqual(
    (await readChatMemory()).items.map((x) => x.text),
    ['用户叫小王'],
  )
})

test('记满了丢最早的一条，并在交回的话里说清丢了哪条', async () => {
  for (let i = 0; i < MEMORY_MAX; i++) await remember(`第 ${i} 条`)
  const items = (await readChatMemory()).items
  assert.equal(items.length, MEMORY_MAX)
  assert.ok(!items.some((x) => x.text === '用户叫小王'), '最早的那条被挤掉')
})

test('forget：按原文删；交给对话的 remember 带 forget 时删，删不到说清楚', async () => {
  const m = await chatMemoryFor()
  assert.equal((await m.remember('第 3 条', true)).ok, true)
  assert.equal((await m.remember('没有这条', true)).ok, false)
  assert.equal(await forget('第 4 条'), true)
  assert.ok(!(await readChatMemory()).items.some((x) => x.text === '第 3 条' || x.text === '第 4 条'))
})

test('Chat 的提示词带上「关于我」和记忆；没有 chatMemory（项目里的对话）时一个字都不加', () => {
  const part = memoryPart({
    about: '回复用中文',
    items: ['用 Windows'],
    remember: async () => ({ ok: true, info: '' }),
  })
  assert.match(part, /## 关于用户/)
  assert.match(part, /回复用中文/)
  assert.match(part, /- 用 Windows/)
  assert.match(part, /remember/)
  assert.equal(memoryPart(undefined), '')
})
