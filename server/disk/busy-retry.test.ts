import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryBusy } from './busy-retry.ts'

const err = (code: string) => Object.assign(new Error(code), { code })

test('文件被占用（EPERM）时等一会儿重试，好了就返回结果', async () => {
  let n = 0
  const r = await retryBusy(async () => {
    if (++n < 3) throw err('EPERM')
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(n, 3)
})

test('别的错误不重试，马上抛出；重试次数用完也抛出', async () => {
  let n = 0
  await assert.rejects(
    retryBusy(async () => {
      n++
      throw err('ENOENT')
    }),
    /ENOENT/,
  )
  assert.equal(n, 1)
  n = 0
  await assert.rejects(
    retryBusy(async () => {
      n++
      throw err('EBUSY')
    }, 2),
    /EBUSY/,
  )
  assert.equal(n, 2)
})
