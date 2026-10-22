import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseApiBalance } from './api-balance.ts'
import { t } from './i18n.ts'

test('解析 DeepSeek 的余额返回', () => {
  assert.deepEqual(
    parseApiBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    }),
    {
      available: true,
      rows: [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }],
    },
  )
})

test('多个币种、数字金额和余额不可用', () => {
  const balance = parseApiBalance({
    is_available: false,
    balance_infos: [
      { currency: 'USD', total_balance: 0 },
      { currency: 'CNY', total_balance: '5.00' },
    ],
  })
  assert.equal(balance.available, false)
  assert.deepEqual(
    balance.rows.map((r) => [r.currency, r.total, r.granted, r.toppedUp]),
    [
      ['USD', '0', '', ''],
      ['CNY', '5.00', '', ''],
    ],
  )
})

test('认不出的返回直接报错，不静默当成没有余额', () => {
  // 期望文案用 t() 算：CI 的 LANG 是英文，写死中文本机能过、CI 挂
  const expected = { message: t('接口没有返回余额信息') }
  assert.throws(() => parseApiBalance({}), expected)
  assert.throws(() => parseApiBalance(null), expected)
  assert.throws(() => parseApiBalance({ balance_infos: [{ total_balance: '1' }] }), expected)
})
