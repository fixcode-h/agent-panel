import assert from 'node:assert/strict'
import test from 'node:test'
import { chipMarker, chips, dropChip, forSend, removeChip, segments } from '../shared/composer.ts'

test('带卡片的文字拆成文本段和卡片段', () => {
  assert.deepEqual(segments('看图 [图片:设计稿.png] 改成'), [
    { text: '看图 ' },
    { chip: { kind: 'image', name: '设计稿.png' } },
    { text: ' 改成' },
  ])
  // 普通方括号、没写全的标记都是普通文字
  assert.deepEqual(segments('数组 [1, 2] 和 [图片:]'), [{ text: '数组 [1, 2] 和 [图片:]' }])
  assert.deepEqual(chips('[技能:blender] 建个模型 [文件:需求.pdf]'), [
    { kind: 'skill', name: 'blender' },
    { kind: 'file', name: '需求.pdf' },
  ])
  assert.equal(chipMarker('command', 'compact'), '[命令:compact]')
})

test('发给服务端：Skill 和命令提到最前面，图片和文件留在原来的位置', () => {
  // 卡片放在哪儿都行，Skill 交给服务端展开时必须排在开头
  assert.equal(forSend('用 [技能:blender] 做一个低模的箱子'), '/blender 用 做一个低模的箱子')
  assert.equal(
    forSend('按 [图片:设计稿.png] 改，参考 [文件:需求.pdf]'),
    '按 [图片:设计稿.png] 改，参考 [文件:需求.pdf]',
  )
  assert.equal(forSend('看 [图片:设计稿.png] 的 [技能:blender] 说明'), '/blender 看 [图片:设计稿.png] 的 说明')
  assert.equal(forSend('[技能:blender]'), '/blender')
  assert.equal(forSend('  普通要求  '), '普通要求')
})

test('只放了附件、没写要求时用一句默认的话；没写要求也没附件时是空的', () => {
  assert.equal(forSend('[图片:设计稿.png]', '请查看附件'), '请查看附件')
  assert.equal(forSend('[图片:设计稿.png] 按这个改', '请查看附件'), '[图片:设计稿.png] 按这个改')
  assert.equal(forSend('[技能:blender]', '请查看附件'), '/blender')
  assert.equal(forSend('', '请查看附件'), '')
  assert.equal(forSend('   ', '请查看附件'), '')
})

test('附件从输入框里删掉时它那张卡片一起去掉，空出来的空格不留着', () => {
  assert.equal(dropChip('看 [图片:设计稿.png] 改', '设计稿.png'), '看 改')
  assert.equal(dropChip('[文件:需求.pdf] 按这个做', '需求.pdf'), '按这个做')
  assert.equal(dropChip('看 [图片:设计稿.png]', '设计稿.png'), '看')
  // 别的卡片、Skill 卡片、普通文字都不动
  assert.equal(dropChip('[图片:渲染.png] [技能:blender]', '设计稿.png'), '[图片:渲染.png] [技能:blender]')
  assert.equal(dropChip('【[图片:a.png]】', 'a.png'), '【】')
})

test('退格删卡片：技能和命令也能整张删掉，同名不同类型的不误删', () => {
  assert.equal(removeChip('用 [技能:blender] 建个模型', { kind: 'skill', name: 'blender' }), '用 建个模型')
  assert.equal(removeChip('[命令:compact] 压缩一下', { kind: 'command', name: 'compact' }), '压缩一下')
  assert.equal(removeChip('看 [图片:设计稿.png] 改', { kind: 'image', name: '设计稿.png' }), '看 改')
  // 同名的文件卡片不受影响
  assert.equal(removeChip('[图片:图片.png] [文件:图片.png]', { kind: 'image', name: '图片.png' }), '[文件:图片.png]')
  // 卡片后面直接接着打的字：删掉卡片后补一个空格，两边不会粘在一起
  assert.equal(removeChip('看 [技能:blender]改完了', { kind: 'skill', name: 'blender' }), '看 改完了')
  assert.equal(removeChip('没有卡片', { kind: 'skill', name: 'blender' }), '没有卡片')
})
