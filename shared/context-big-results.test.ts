/**
 * 会话栏上下文里的「最大的工具结果」（工作包 I）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bigToolResults, resultChars } from './context-big-results.ts'
import type { TaskMessage } from './schema.ts'

const msg = (id: string, agentId: string, tools: object[], role = 'agent') =>
  ({ id, role, agentId, tools, text: '' }) as unknown as TaskMessage
const tool = (label: string, chars: number, more: object = {}) => ({
  kind: 'run',
  label,
  output: 'x'.repeat(chars),
  ...more,
})

test('最大的工具结果：只看最近一次压缩之后、当前角色的，按字数从大到小，小的不列', () => {
  const list = bigToolResults(
    [
      msg('m0', 'a', [tool('压缩之前的大输出', 90000)]),
      msg('m1', 'a', [{ kind: 'compact', label: '压缩' }]),
      // 压缩那一行和之后的工具调用在同一条消息里：压缩之前那条不算
      msg('m2', 'a', [
        tool('同一条消息里压缩之前的', 99000),
        { kind: 'compact', label: '压缩' },
        tool('npm test', 30000),
        tool('ls', 100),
      ]),
      msg('m3', 'b', [tool('别的角色', 50000)]),
      msg('m4', 'a', [tool('cat big.log', 40000)]),
    ],
    'a',
  )
  assert.deepEqual(
    list.map((x) => [x.label, x.msg, x.i]),
    [
      ['cat big.log', 'm4', 0],
      ['npm test', 'm2', 2],
    ],
  )
  assert.equal(list[0].tokens, Math.round(40000 / 3))
})

test('原本多长：页面收到的省掉了后半段按存盘长度算，存盘时截掉的按结尾写的字数补上', () => {
  assert.equal(resultChars({ output: 'abc', outputCut: { len: 9000 } }), 9000)
  const zh = `${'x'.repeat(8000)}\n…（还有 22000 个字符没有显示）`
  assert.equal(resultChars({ output: zh }), zh.length + 22000)
  const en = `${'x'.repeat(10)}\n…(5 more characters not shown)`
  assert.equal(resultChars({ output: en }), en.length + 5)
})
