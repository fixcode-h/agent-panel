import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assistSteer } from './assist-steer.ts'

const mcp = { args: [] } as never

test('AI 创建执行中插话：有插话协议的直接交给 CLI，收不下时没有 notes 就交回页面排队', async () => {
  const s = assistSteer({ notes: false, mcp: undefined })
  // 进程还没起来：没有控制通道
  assert.equal(await s.steer('还没好？'), false)
  const sent: string[] = []
  let accept = true
  s.onControl({ steer: async (x) => (sent.push(x), accept), interrupt: () => true })
  assert.equal(await s.steer('还没好？'), true)
  assert.match(sent[0], /还没好？/)
  accept = false
  assert.equal(await s.steer('再快点'), false)
  assert.equal(s.readNotes, undefined)
})

test('AI 创建执行中插话：没有插话协议的登记给 read_user_notes，到结束没取走的交回页面', async () => {
  const s = assistSteer({ notes: true, mcp })
  assert.equal(await s.steer('第一句'), true)
  assert.match(s.readNotes!().join(), /第一句/)
  assert.deepEqual(s.readNotes!(), [])
  assert.equal(await s.steer('第二句'), true)
  assert.deepEqual(s.unread(), ['第二句'])
})
