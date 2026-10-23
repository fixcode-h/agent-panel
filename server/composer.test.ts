import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachChip,
  chipMarker,
  chips,
  copyText,
  dropChip,
  findPaths,
  forSend,
  removeChip,
  segments,
  solePath,
} from '../shared/composer.ts'

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
  // 卡片留在原位：发出去后对话里照样显示成卡片
  assert.equal(forSend('[图片:设计稿.png]', '请查看附件'), '[图片:设计稿.png] 请查看附件')
  // 只有引用卡片时引用本身就是内容，不补那句话
  assert.equal(forSend('[引用:一段话#q1]', '请查看附件'), '[引用:一段话#q1]')
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

test('引用卡片也算附件卡片：附件删掉时卡片一起去掉', () => {
  assert.equal(dropChip('看 [引用:一段话#q1] 再说', '一段话#q1'), '看 再说')
})

test('附件对应哪种卡片：带原文的是引用，图片按类型或扩展名认', () => {
  assert.equal(attachChip({ name: 'a#q1', mime: 'text/markdown', quote: '原文' }), 'quote')
  assert.equal(attachChip({ name: 'a.PNG', mime: '' }), 'image')
  assert.equal(attachChip({ name: 'a.pdf', mime: 'application/pdf' }), 'file')
})

test('复制用户消息：卡片换成路径，带空格的路径加引号，没写进文字的附件放在最前面', () => {
  const img = { name: '设计稿.png', path: '/data/uploads/1/设计稿.png', mime: 'image/png' }
  const doc = { name: '需求.pdf', path: 'C:\\Users\\Me Too\\需求.pdf', mime: '' }
  const quote = { name: '一段话#q1', path: '/data/uploads/2/quote-q1.md', mime: 'text/markdown', quote: '一段话' }
  assert.equal(
    copyText('按 [图片:设计稿.png] 改，参考 [文件:需求.pdf] 和 [引用:一段话#q1]', [img, doc, quote]),
    '按 /data/uploads/1/设计稿.png 改，参考 "C:\\Users\\Me Too\\需求.pdf" 和 /data/uploads/2/quote-q1.md',
  )
  assert.equal(copyText('修复下吧', [img]), '/data/uploads/1/设计稿.png 修复下吧')
  assert.equal(copyText('/blender 做个箱子'), '/blender 做个箱子')
})

test('粘贴的文字里找绝对路径：引号里的可以带空格，网址、相对路径不算，句尾标点去掉', () => {
  const text =
    '看 /data/uploads/1/a.png，还有 "C:\\Users\\Me Too\\b.pdf" 和 D:/x/c.txt。网址 https://a.com/b 不算，src/a.ts 也不算'
  const hits = findPaths(text)
  assert.deepEqual(
    hits.map((h) => h.path),
    ['/data/uploads/1/a.png', 'C:\\Users\\Me Too\\b.pdf', 'D:/x/c.txt'],
  )
  // 位置对得上：换成卡片时按位置替换
  for (const h of hits) assert.ok(text.slice(h.start, h.end).includes(h.path))
  assert.deepEqual(findPaths('没有路径'), [])
  // 复制出来的再粘贴回去能认全
  const copied = copyText('看 [图片:a b.png]', [{ name: 'a b.png', path: '/tmp/x/a b.png', mime: 'image/png' }])
  assert.deepEqual(
    findPaths(copied).map((h) => h.path),
    ['/tmp/x/a b.png'],
  )
})

test('整段就是一个路径才当会话/文件引用：前后有别的文字不算，普通文本也不算', () => {
  // 「复制对话」放进剪贴板的就是这种：唯一一个绝对路径，前后只有空白
  assert.equal(
    solePath('/home/me/.agent-panel/uploads/会话-改个按钮.md'),
    '/home/me/.agent-panel/uploads/会话-改个按钮.md',
  )
  assert.equal(
    solePath('  /home/me/.agent-panel/uploads/会话-改个按钮.md\n'),
    '/home/me/.agent-panel/uploads/会话-改个按钮.md',
  )
  // 带空格的路径复制时加了双引号，粘贴回来还算整段一个路径
  assert.equal(solePath('"C:\\Users\\Me Too\\会话-改个按钮.md"'), 'C:\\Users\\Me Too\\会话-改个按钮.md')
  // 普通文字、相对路径、多个路径、路径后面跟着要求都不算
  assert.equal(solePath('改一下这个按钮的颜色'), undefined)
  assert.equal(solePath('src/components/A.tsx'), undefined)
  assert.equal(solePath('/home/me/a.md /home/me/b.md'), undefined)
  assert.equal(solePath('看 /home/me/a.md 这个文件'), undefined)
  assert.equal(solePath(''), undefined)
})
