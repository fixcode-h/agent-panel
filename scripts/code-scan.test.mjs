// scripts/lib/code-scan.mjs 的测试：字符串、注释、正则、模板字符串、JSX 文字里的符号不能让括号配错
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { functionsOf, maskCode } from './lib/code-scan.mjs'

const body = (n) => Array.from({ length: n }, (_, i) => `  const a${i} = ${i}`).join('\n')

test('字符串、注释、正则里的括号不算', () => {
  const src = "const s = '{(' // }\nconst r = /[{]\\//\n/* } */ const t = `a ${'}'} {`\n"
  const code = maskCode(src)
  assert.equal((code.match(/{/g) ?? []).length, (code.match(/}/g) ?? []).length)
  assert.equal(code.length, src.length)
})

test('JSX 里的 / 和撇号不吃掉后面的括号', () => {
  const src = "const C = () => (\n  <p>\n    {a} / {b} don't\n    <br />\n  </p>\n)\nfunction f() {\n}\n"
  const code = maskCode(src)
  assert.equal((code.match(/{/g) ?? []).length, (code.match(/}/g) ?? []).length)
})

test('认出各种函数和它们的名字、行数', () => {
  const src = [
    `export async function runAgent(a: string): Promise<void> {\n${body(3)}\n}`,
    `const make = async <T,>(x: T) => {\n${body(2)}\n}`,
    `app.post('/tasks/:id', async (c) => {\n${body(1)}\n})`,
    `class A {\n  method(x: number): number {\n    return x\n  }\n}`,
    `if (ok) {\n}`,
  ].join('\n')
  const fns = Object.fromEntries(functionsOf(src).map((f) => [f.name, f.lines]))
  assert.equal(fns.runAgent, 5)
  assert.equal(fns.make, 4)
  assert.equal(fns["app.post('/tasks/:id')"], 3)
  assert.equal(fns.method, 3)
  assert.equal(fns.if, undefined)
})
