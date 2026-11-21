/**
 * 复用检查：差异里新增的公开函数和交接单的 reuse 对一遍，没写到的标给评审；都没有时不附。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { reuseInput, reusePart } from './reuse.ts'

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,3 @@',
  '+export function topLocation() {}',
  '+export function heightOf() {}',
].join('\n')

test('新增公开函数没写复用检查：标出来，允许评审查这几个名字', () => {
  const part = reusePart(
    diff,
    reuseInput([{ added: 'Lib::topLocation', looked: '搜了 Location', why: '现成的只算底部' }]),
  )
  assert.match(part, /现成的只算底部/)
  assert.match(part, /新增公开函数 1 个/)
  assert.match(part, /heightOf（src\/a\.ts）/)
  assert.doesNotMatch(part, /- topLocation（/)
})

test('没有新增公开函数也没写 reuse：不附；认不出的 reuse 项丢掉', () => {
  assert.equal(reusePart('diff --git a/x.md b/x.md\n+++ b/x.md\n+文字'), '')
  assert.deepEqual(reuseInput([{ looked: 'x' }, 'bad', null]), [])
})
