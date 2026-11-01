/**
 * 朗读前把回复整理成适合念的文字、按句切段（web/src/lib/read-aloud.ts）。
 * 念出来全是星号、反引号、网址就没法听，这里守着这些规则
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { speakableText, speechChunks } from './read-aloud.ts'

test('speakableText：代码块不念，链接念文字，路径只念文件名，去掉 Markdown 符号', () => {
  const md = [
    '## 改动',
    '- **修好了** 登录页的报错，见 [说明](https://example.com/a)',
    '- 改了 `web/src/pages/Login.tsx` 和 server/auth/login.ts',
    '```ts',
    'const x = 1',
    '```',
    '| 文件 | 结果 |',
    '| --- | --- |',
    '| a.ts | 通过 |',
  ].join('\n')
  const out = speakableText(md)
  assert.equal(
    out,
    ['改动', '修好了 登录页的报错，见 说明', '改了 Login.tsx 和 login.ts', '文件，结果', 'a.ts，通过'].join('\n'),
  )
})

test('speechChunks：按句切，单段不超过上限，标题和列表各念各的', () => {
  assert.deepEqual(speechChunks('第一句。第二句！\n标题\n第三句'), ['第一句。第二句！', '标题', '第三句'])
  const long = '很长'.repeat(150)
  const chunks = speechChunks(long, 100)
  assert.ok(chunks.every((c) => c.length <= 100))
  assert.equal(chunks.join(''), long)
  // 只剩标点的段不交给语音引擎
  assert.deepEqual(speechChunks('。。\n'), [])
})
