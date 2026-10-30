import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { removeTaskLog, setTaskLogPath, taskLog } from './task-log.ts'

test('对话日志：一行一件事，带空格的值加引号，找不到对话时不写，删除时连旧文件一起删', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'task-log-'))
  try {
    setTaskLogPath((id) => (id === 'a' ? path.join(dir, 'a.log') : undefined))
    taskLog('a', '收到消息', { messageId: 'm1', text: '有 空格', live: true, skipped: undefined })
    taskLog('a', '停止', { reason: 'user' })
    taskLog('b', '收到消息', { messageId: 'm2' })
    const lines = readFileSync(path.join(dir, 'a.log'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[收到消息\] messageId=m1 text="有 空格" live=true$/)
    assert.match(lines[1], /\[停止\] reason=user$/)
    assert.ok(!existsSync(path.join(dir, 'b.log')), '不属于任何对话的不写')
    removeTaskLog(path.join(dir, 'a.log'))
    assert.ok(!existsSync(path.join(dir, 'a.log')))
  } finally {
    setTaskLogPath(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
