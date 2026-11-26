/**
 * find 的 query 收数组（设计稿 15.3 方案 B）：几个词同时查、按词分组，总长按 ADR 0067 的 4000 字预算截，
 * 截掉的那组写清怎么单独查；一个词的数组照单个查，超过上限报错。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FIND } from './find-tool.ts'
import { MULTI_MAX } from './find-multi.ts'
import type { FindRequest } from '../../shared/capability-router/find/types.ts'

test('find 的 query 给数组：每个词各查一遍、按词分组，总长不超过 4000 字，没列完的那组写清怎么单独查', async () => {
  const asked: FindRequest[] = []
  const o = {
    findCode: async (req: FindRequest) => {
      asked.push(req)
      const n = req.query === 'Big' ? 400 : 2
      return {
        text: Array.from({ length: n }, (_, i) => `src/${req.query}.lua:${i + 1}: ${req.query} 第 ${i + 1} 处`).join(
          '\n',
        ),
      }
    },
  } as never
  const r = await FIND.call(o, { action: 'refs', query: ['OnSellAll', 'Big', 'Refresh'] })
  const text = r.content[0].text
  assert.deepEqual(asked.map((x) => x.query).sort(), ['Big', 'OnSellAll', 'Refresh'])
  assert.ok(text.length <= 4000 + 200, `总长 ${text.length}`)
  assert.match(text, /^## OnSellAll\n/)
  assert.match(text, /## Refresh\nsrc\/Refresh\.lua:1/, '前面那组长，后面的照样有自己的一份')
  assert.match(text, /这一组没列完：单独查 query="Big"/)

  asked.length = 0
  await FIND.call(o, { action: 'refs', query: ['OnSellAll'] })
  assert.equal(asked[0].query, 'OnSellAll', '一个词的数组照单个查')
  const over = await FIND.call(o, {
    action: 'refs',
    query: Array.from({ length: MULTI_MAX + 1 }, (_, i) => `Name${i}`),
  })
  assert.equal(over.isError, true)
})
