import assert from 'node:assert/strict'
import test from 'node:test'
import { checkFile, cleanupPrompt, failedText, fileClean, lineDiff, tempLogLines } from './bug-cleanup.ts'

const base = ['function pay(order) {', '  const total = sum(order)', '  return charge(total)', '}'].join('\n')
// 加日志：插了一行日志和一个空行
const withLog = [
  'function pay(order) {',
  '  const total = sum(order)',
  '',
  "  console.log('[排查-支付] L1 total=', total)",
  '  return charge(total)',
  '}',
].join('\n')

test('查临时日志：只认 [排查- 前缀，行号从 1 起', () => {
  assert.deepEqual(tempLogLines('a.ts', withLog), [
    { file: 'a.ts', line: 4, text: "  console.log('[排查-支付] L1 total=', total)" },
  ])
  assert.deepEqual(tempLogLines('a.ts', base), [])
})

test('逐行比较：插入的行记在旧文件第几行之后，删掉的行记旧行号', () => {
  const ops = lineDiff(base, withLog)
  const adds = ops.filter((x) => x.op === 'add')
  assert.equal(adds.length, 2)
  assert.ok(adds.every((x) => x.op === 'add' && x.at === 2))
  assert.equal(ops.filter((x) => x.op === 'del').length, 0)
})

test('核对：日志删了但空行留着、删多了一行、一模一样', () => {
  const pre = withLog
  const leftBlank = base.replace('  const total = sum(order)\n', '  const total = sum(order)\n\n')
  const r = checkFile('a.ts', leftBlank, { base, pre, strict: true })
  assert.equal(r.blank.length, 1, '加日志时带进来的空行没删')
  assert.equal(fileClean(r), false)
  assert.match(failedText([r]), /a\.ts:3 多了一个空行/)
  const over = base.replace('  return charge(total)\n', '')
  assert.equal(checkFile('a.ts', over, { base, pre, strict: true }).removed.length, 1)
  assert.ok(fileClean(checkFile('a.ts', base, { base, pre, strict: true })))
  const still = checkFile('a.ts', withLog, { base, pre, strict: true })
  assert.equal(still.left.length, 1)
})

test('核对（已修过逻辑）：修复改动不算多出来；日志那一段留下的空行算', () => {
  const fixed = base.replace('charge(total)', 'charge(Math.round(total))')
  const pre = withLog.replace('charge(total)', 'charge(Math.round(total))')
  assert.ok(fileClean(checkFile('a.ts', fixed, { base, pre, strict: false })), '修复留着')
  const blank = fixed.replace('  const total = sum(order)\n', '  const total = sum(order)\n\n')
  assert.equal(checkFile('a.ts', blank, { base, pre, strict: false }).blank.length, 1)
  // 没快照：只查残留
  assert.ok(fileClean(checkFile('a.ts', blank, { strict: false })))
})

test('叫 Agent 删的话：列出每一处原文，要求删空行、不整文件还原', () => {
  const p = cleanupPrompt({ rev: 2, found: tempLogLines('a.ts', withLog), drop: ['tmp/repro.ts'] })
  assert.match(p, /第 2 版/)
  assert.match(p, /a\.ts:4 {2}console\.log\('\[排查-支付\] L1/)
  assert.match(p, /空白行也删掉/)
  assert.match(p, /不要用 git checkout/)
  assert.match(p, /tmp\/repro\.ts/)
})
