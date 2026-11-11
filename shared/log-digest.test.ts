/**
 * 编译、测试日志的提炼（工作包 I）：按编译器格式认错误和警告行，去重限条数，成功只给最后几行。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DIGEST_ERRORS, digestLines, digestText } from './log-digest.ts'

test('认得各家编译器的错误和警告行，普通输出里出现 error 字样的不算', () => {
  const d = digestLines([
    'Building 3 actions',
    'G:/P/Source/A.cpp(12): error C2065: “foo”: 未声明的标识符',
    'Module.A.cpp.obj : error LNK2019: unresolved external symbol',
    'src/x.c:3:5: error: expected ;',
    'src/a.ts(1,2): error TS2322: Type string is not assignable',
    'error[E0308]: mismatched types',
    '[2026.11.11-10.00.00:000][  0]LogInit: Error: failed to load',
    'src/x.c:9:1: warning: unused variable',
    'A.cpp(3): warning C4996: deprecated',
    'Compiling error_handler.cpp',
    'no errors found',
  ])
  assert.equal(d.errorCount, 6)
  assert.equal(d.warningCount, 2)
  assert.ok(!d.errors.some((l) => /error_handler|no errors/.test(l)))
})

test('同一条报错打印多次算一条（时间戳不同也算），超出条数只计数', () => {
  const same = digestLines(['[t1] a.c:1:1: error: x', '[t2] a.c:1:1: error: x'])
  assert.equal(same.errorCount, 1)
  const many = digestLines(Array.from({ length: 50 }, (_, i) => `a.c:${i}:1: error: e${i}`))
  assert.equal(many.errorCount, 50)
  assert.equal(many.errors.length, DIGEST_ERRORS)
  assert.match(digestText([], many, false), /错误（50 条，列前 30 条）/)
})

test('成功只给最后几行和警告条数，失败给错误、警告和结尾；有日志文件写明路径', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
  const d = { errors: ['a.c:1:1: error: x'], warnings: ['w'], errorCount: 1, warningCount: 3 }
  const ok = digestText(lines, d, true, '/data/x.log')
  assert.match(ok, /line 99/)
  assert.doesNotMatch(ok, /line 90\b/)
  assert.doesNotMatch(ok, /error: x/, '成功时不列错误')
  assert.match(ok, /另有 3 条警告/)
  assert.match(ok, /\/data\/x\.log/)
  const bad = digestText(lines, d, false)
  assert.match(bad, /错误（1 条）[\s\S]*警告（3 条，列前 1 条）[\s\S]*line 60[\s\S]*line 99/)
  assert.doesNotMatch(bad, /完整日志/)
})
