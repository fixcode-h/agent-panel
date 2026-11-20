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

test('结构化结果：一个 text 块时原样保留；还有提示、图片时去掉（Claude Code 有它时只看它）', async () => {
  const data = { a: 1 }
  const one = { content: [{ type: 'text' as const, text: '{"a":1}' }], structuredContent: data }
  assert.equal(await clipPluginResult(one, 'n', async () => 'f', 1000), one)
  const noted = await clipPluginResult(
    {
      content: [
        { type: 'text' as const, text: '{"a":1}' },
        { type: 'text' as const, text: '提示' },
      ],
      structuredContent: data,
    },
    'n',
    async () => 'f',
    1000,
  )
  assert.equal(noted.structuredContent, undefined)
  assert.equal(noted.content.length, 2, '文字原样')
  const withImg = await clipPluginResult({ content: [img], structuredContent: data }, 'n', async () => 'f', 1000)
  assert.equal(withImg.structuredContent, undefined)
})

test('结构化结果超长：和文字一起按上限算，截断后去掉，模型看到的是开头结尾和文件路径', async () => {
  const data = { items: Array.from({ length: 300 }, (_, i) => `item-${i}`) }
  const text = JSON.stringify(data)
  const r = await clipPluginResult(
    { content: [{ type: 'text', text }], structuredContent: data },
    'n',
    async () => '/f.md',
    1000,
  )
  assert.equal(r.structuredContent, undefined)
  assert.match(r.content[0].type === 'text' ? r.content[0].text : '', /\/f\.md/)
  // 存不了文件：整段文字交回，结构化结果去掉
  const full = await clipPluginResult(
    { content: [{ type: 'text', text }], structuredContent: data },
    'n',
    async () => '',
    1000,
  )
  assert.equal(full.structuredContent, undefined)
  assert.equal(full.content[0].type === 'text' ? full.content[0].text : '', text)
})
