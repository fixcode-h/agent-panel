/**
 * 子对话发给父对话的长消息（server/tasks/inbox-file.ts）：截断必须留下全文的位置，全文能读到（ADR 0041 第 14 节）。
 * 运行：npx tsx --test server/tasks/inbox-file.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 数据目录指到临时目录：store.ts 加载时就读它，必须在 import 之前设好
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'ap-inbox-'))
const { inboxWithFile, INBOX_CHARS } = await import('./inbox-file.ts')

test('子对话的长汇报：提示里不超过上限，结尾写明全文文件，文件里是完整原文；短的原样交', () => {
  const short = { title: '评审', text: '结论：通过' }
  assert.equal(inboxWithFile('t1', short), short)
  const long = { title: '评审', text: `开头结论\n${'意见。'.repeat(1500)}\n最后一条：第 9 条必须改` }
  const got = inboxWithFile('t1', long)
  assert.ok(got.text.length <= INBOX_CHARS, `长度 ${got.text.length}`)
  const file = /全文在文件 (.+?)，处理前先读完/.exec(got.text)?.[1]
  assert.ok(file, got.text.slice(-200))
  // 文件在这个对话的交接目录里：CLI 启动时就放行（见 store.ts 的 handoffDirOf）
  assert.ok(file.startsWith(path.join(process.env.AGENT_PANEL_DATA!, 'tasks', 'handoff', 't1')))
  assert.match(readFileSync(file, 'utf8'), /最后一条：第 9 条必须改/)
})
