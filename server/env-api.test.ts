import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envApi } from './env-api.ts'

test('检测本机代理的接口：原样返回探测结果，系统代理在前', async () => {
  const proxies = [
    { url: 'http://127.0.0.1:7890', source: 'system' as const },
    { url: 'http://127.0.0.1:10809', source: 'port' as const },
  ]
  const res = await envApi(async () => proxies).request('/net/proxy/detect')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { proxies })
})
