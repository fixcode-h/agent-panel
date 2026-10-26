import assert from 'node:assert/strict'
import test from 'node:test'
import { clip } from './text.ts'

test('clip：没超长时原样返回，超长时截到 n 个字再补省略号', () => {
  assert.equal(clip('短文本', 10), '短文本')
  assert.equal(clip('x'.repeat(10), 10), 'x'.repeat(10))
  assert.equal(clip('x'.repeat(11), 10), 'x'.repeat(10) + '…')
  assert.equal(clip('', 10), '')
})

test('clip：oneLine 先折成一个空格并去掉首尾空白，再按长度判断', () => {
  assert.equal(clip('  a\n\n b  ', 100, { oneLine: true }), 'a b')
  assert.equal(clip('a\nb\nc\nd', 3, { oneLine: true }), 'a b…')
})

test('clip：total 时 n 是含省略号的总长', () => {
  const out = clip('y'.repeat(20), 10, { total: true })
  assert.equal(out.length, 10)
  assert.equal(out, 'y'.repeat(9) + '…')
})

test('clip：mark 收到被省略的字数，可以用它拼自己的文案', () => {
  assert.equal(clip('x'.repeat(20), 10, { mark: (n) => `（省略 ${n} 字）` }), 'x'.repeat(10) + '（省略 10 字）')
  assert.equal(
    clip('x'.repeat(20), 10, { total: true, mark: (n) => `…（后面省略 ${n} 字）` }),
    'x'.repeat(9) + '…（后面省略 11 字）',
  )
})

test('clip：tailRatio 保留头尾、中间换成 mark，省略字数按实际截掉的算', () => {
  const text = 'abcdefghij'
  assert.equal(clip(text, 4, { tailRatio: 0.5, mark: (n) => `<${n}>` }), 'ab<6>ij')
  // n 是头尾加起来的总长：头尾额度不能被 0.5 整除时也不能多留
  assert.equal(clip(text, 9, { tailRatio: 0.3, mark: (n) => `<${n}>` }), 'ab<2>efghij')
})
