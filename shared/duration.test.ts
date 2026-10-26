import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtDuration } from './duration.ts'

test('不到一分钟写秒，最多一位小数，整数不带 .0', () => {
  assert.equal(fmtDuration(0), '0s')
  assert.equal(fmtDuration(1_200), '1.2s')
  assert.equal(fmtDuration(20_000), '20s')
  assert.equal(fmtDuration(41_160), '41.2s')
  assert.equal(fmtDuration(59_860), '59.9s')
})

test('一秒以内按毫秒写：加载那几步的耗时差要看得出来', () => {
  assert.equal(fmtDuration(1), '1ms')
  assert.equal(fmtDuration(20), '20ms')
  assert.equal(fmtDuration(38), '38ms')
  assert.equal(fmtDuration(999), '999ms')
  // 0.5 毫秒以内的零头归到 0s，不写「0ms」
  assert.equal(fmtDuration(0.4), '0s')
  // 四舍五入到 1000ms 的按 1s 写，不出现「1000ms」
  assert.equal(fmtDuration(999.6), '1s')
  assert.equal(fmtDuration(1_000), '1s')
  assert.equal(fmtDuration(1_200), '1.2s')
})

test('满一分钟转成分 + 秒，秒位保留一位小数', () => {
  assert.equal(fmtDuration(59_900), '59.9s')
  assert.equal(fmtDuration(60_000), '1m 0s')
  assert.equal(fmtDuration(243_580), '4m 3.6s')
  assert.equal(fmtDuration(178_200), '2m 58.2s')
  // 59.96 秒进位到整分，不会写出「60s」
  assert.equal(fmtDuration(59_960), '1m 0s')
})

test('满一小时转成小时 + 分', () => {
  assert.equal(fmtDuration(3_599_900), '59m 59.9s')
  assert.equal(fmtDuration(3_600_000), '1h 0m')
  assert.equal(fmtDuration(2 * 3600_000 + 5 * 60_000), '2h 5m')
  assert.equal(fmtDuration(23 * 3600_000 + 59 * 60_000), '23h 59m')
})

test('满一天转成天 + 小时', () => {
  // 23 小时 59 分 50 秒四舍五入到 24 小时，进位成 1 天
  assert.equal(fmtDuration(86_390_000), '1d 0h')
  assert.equal(fmtDuration(86_400_000), '1d 0h')
  assert.equal(fmtDuration(27 * 3600_000), '1d 3h')
  assert.equal(fmtDuration(51 * 3600_000), '2d 3h')
})

test('负数、缺失和非数值都按 0 处理，不抛错也不显示负数', () => {
  assert.equal(fmtDuration(-1), '0s')
  assert.equal(fmtDuration(-60_000), '0s')
  assert.equal(fmtDuration(Number.NaN), '0s')
  assert.equal(fmtDuration(Number.POSITIVE_INFINITY), '0s')
  assert.equal(fmtDuration(undefined as unknown as number), '0s')
})

test('脚本侧那份副本和界面实现给出同样结果', async () => {
  // 路径写成 string 动态导入：脚本是 .mjs，类型检查不进去，只在这里比对两边的输出
  const script = (await import('../scripts/lib/duration.mjs' as string)) as {
    fmtDuration: (ms: number) => string
  }
  const cases = [
    0,
    0.4,
    20,
    38,
    99,
    100,
    990,
    1_000,
    20_000,
    41_160,
    59_860,
    59_960,
    60_000,
    243_580,
    1_789_000,
    3_599_900,
    3_600_000,
    7_500_000,
    23 * 3600_000,
    86_390_000,
    86_400_000,
    27 * 3600_000,
    51 * 3600_000,
    -1,
    Number.NaN,
  ]
  for (const ms of cases) assert.equal(script.fmtDuration(ms), fmtDuration(ms), `毫秒 ${ms}`)
})
