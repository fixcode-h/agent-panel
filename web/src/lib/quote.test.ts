/**
 * 引用卡片的纯逻辑：引用块、摘要、原文存取、发送前换回引用块。
 * 浏览器里没有 localStorage 时（部分环境、隐私模式）也要能用内存里的那份，所以这些函数在 node 里能直接测。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chipMarker } from '@shared/composer'
import { expandQuotes, quoteBlock, quoteChip, quoteId, quoteLabel, quoteText } from '@/lib/quote'

test('quoteBlock：每行前面加「> 」，空行只留「>」，末尾空一行给用户接着写', () => {
  assert.equal(quoteBlock('第一行\n\n第二行\n'), '> 第一行\n>\n> 第二行\n\n')
})

test('quoteChip：摘要里的方括号和换行被压平，编号能把原文取回来', () => {
  const chip = quoteChip('看 [这里]\n  有两行')
  assert.equal(chip.kind, 'quote')
  assert.match(quoteId(chip.name), /^q[0-9a-z]+$/)
  assert.equal(quoteLabel(chip.name), '看 这里 有两行')
  assert.equal(quoteText(chip.name), '看 [这里]\n  有两行')
})

test('quoteChip：太长的原文只留开头 40 个字加省略号', () => {
  const chip = quoteChip('一'.repeat(60))
  assert.equal(quoteLabel(chip.name), `${'一'.repeat(40)}…`)
  assert.equal(quoteText(chip.name), '一'.repeat(60))
})

test('expandQuotes：引用卡片换回引用块，前后文字留在原位', () => {
  const chip = quoteChip('原文')
  const value = `看这个 ${chipMarker('quote', chip.name)} 再说`
  assert.equal(expandQuotes(value), `看这个 \n${quoteBlock('原文')} 再说`)
})

test('expandQuotes：找不到原文时用卡片上的摘要', () => {
  assert.equal(expandQuotes(chipMarker('quote', '旧摘要#qgone123')), quoteBlock('旧摘要'))
})

test('expandQuotes：图片、文件等其他卡片原样留着', () => {
  const value = `前 ${chipMarker('image', 'a.png')} 后`
  assert.equal(expandQuotes(value), value)
})

test('expandQuotes：没有卡片时原样返回', () => {
  assert.equal(expandQuotes('就是一段普通文字'), '就是一段普通文字')
})
