import assert from 'node:assert/strict'
import test from 'node:test'
import { demoDiagnosis, diagnosisBugPrompt, parseDiagnosis } from './diagnosis.ts'

/** 分析窗口的结论块带上 Bug 档案的三块（ADR 0046）：旧块照读；「按完整流程修」发回去的是 /bug */

test('结论块：调用栈、时间线、引入点查得到才写，写坏的那一条跳过；旧的结论块没有它们照常读', () => {
  const block = (o: object) => '```diagnosis\n' + JSON.stringify({ rootCause: { title: '空指针' }, ...o }) + '\n```'
  const old = parseDiagnosis(block({}))
  assert.ok(old?.ok && old.value.stack.length === 0 && old.value.timeline.length === 0 && !old.value.attribution)
  const r = parseDiagnosis(
    block({
      stack: [{ file: 'a.ts', line: 3, fn: 'f' }, 'x'],
      timeline: [{ at: '10:00', kind: 'change', text: '改了接口', abnormal: true }],
      attribution: { category: 'recent', change: 'abc', how: 'blame', author: '张三' },
    }),
  )
  assert.ok(r?.ok)
  assert.equal(r.value.stack.length, 1, '写坏的那一条（字符串）跳过')
  assert.equal(r.value.timeline[0].kind, 'change')
  assert.equal(r.value.attribution?.author, '张三')
})

test('按完整流程修：/bug 开头，分析窗口查到的原样带过去', () => {
  const text = diagnosisBugPrompt(demoDiagnosis(false))
  assert.match(text, /^\/bug 商品卡片直接调用 price\.toFixed/)
  assert.match(text, /先核对和现在的代码对得上，再按完整流程接着做/)
  assert.match(text, /- 引入点：4f2a9c1 《下架商品不再返回价格》 王五 2026-10-28（recent，blame）/)
  assert.match(text, /\[change\] 4f2a9c1：接口对下架商品改成返回 price: null（异常）/)
  assert.match(text, /- 修复建议：\n  - `src\/components\/ProductCard\.tsx:7`：价格为空时显示「暂无报价」/)
})
