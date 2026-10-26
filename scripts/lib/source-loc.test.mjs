// 元素抓取的源码位置：构建时给原生标签写 data-src，行号、组件名要对，组件标签和已有 data-src 的不动
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addSourceLoc } from './source-loc.mjs'

test('addSourceLoc：原生标签写上「路径:行号:组件名」，组件标签不加', () => {
  const code = [
    '// 中文注释😀 不影响位置',
    'export function SendBar() {',
    '  return (',
    '    <div className="x">',
    '      <Button>发送</Button>',
    '      <span>好</span>',
    '    </div>',
    '  )',
    '}',
  ].join('\n')
  const out = addSourceLoc(code, 'components/chat/SendBar.tsx')
  assert.match(out, /<div data-src="components\/chat\/SendBar\.tsx:4:SendBar" className="x">/)
  assert.match(out, /<span data-src="components\/chat\/SendBar\.tsx:6:SendBar">好<\/span>/)
  assert.match(out, /<Button>发送<\/Button>/)
  // 只插属性不换行：行号和原文一致
  assert.equal(out.split('\n').length, code.split('\n').length)
})

test('addSourceLoc：组件名取最近的组件或 hook 变量名（memo 包着的取外面的名字），内部的普通变量不算', () => {
  const code = [
    'const Card = memo(function Inner() {',
    '  const cls = "a"',
    '  const render = () => <i className={cls} />',
    '  return <b>{render()}</b>',
    '})',
    'const top = <p />',
  ].join('\n')
  const out = addSourceLoc(code, 'Card.tsx')
  assert.match(out, /<i data-src="Card\.tsx:3:Card"/)
  assert.match(out, /<b data-src="Card\.tsx:4:Card">/)
  // 文件顶层的标签没有组件名
  assert.match(out, /<p data-src="Card\.tsx:6" \/>/)
})

test('addSourceLoc：已经写了 data-src 的、成员表达式标签不动；解析失败或没有标签时返回 null', () => {
  const out = addSourceLoc('const A = () => <><div data-src="x" /><motion.div /></>', 'A.tsx')
  assert.equal(out, null)
  assert.equal(addSourceLoc('const a = 1', 'a.tsx'), null)
  assert.equal(addSourceLoc('const A = () => <div', 'a.tsx'), null)
})
