/**
 * 插件工具结果的上限（工作包 I）：超长的存文件只回头尾和路径，存不了就整段交回。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { clipPluginResult } from './mcp-clip.ts'

const img = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }

test('插件结果超长：存文件，只回开头、结尾和路径，图片原样保留', async () => {
  const text = `开头结论${'中'.repeat(5000)}最后一行报错`
  const saved: string[] = []
  const r = await clipPluginResult(
    { content: [{ type: 'text', text }, img] },
    'n',
    async (_n, t) => {
      saved.push(t)
      return '/data/handoff/t/n.md'
    },
    1000,
  )
  assert.equal(saved[0], text, '文件里是完整内容')
  const out = r.content[0].type === 'text' ? r.content[0].text : ''
  assert.match(out, /^开头结论/)
  assert.match(out, /最后一行报错\n/)
  assert.match(out, /中间省略 \d+ 字/)
  assert.match(out, /\/data\/handoff\/t\/n\.md/)
  assert.deepEqual(r.content[1], img)
})

test('插件结果没超长原样返回；存不了文件时整段交回，不悄悄截掉', async () => {
  const short = { content: [{ type: 'text' as const, text: 'ok' }] }
  assert.equal(await clipPluginResult(short, 'n', async () => 'f', 1000), short)
  const long = { content: [{ type: 'text' as const, text: 'x'.repeat(5000) }] }
  assert.equal(await clipPluginResult(long, 'n', async () => '', 1000), long)
  assert.equal(await clipPluginResult(long, 'n', async () => Promise.reject(new Error('disk')), 1000), long)
})
