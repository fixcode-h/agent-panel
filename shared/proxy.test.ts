// 默认代理地址只在 shared/proxy.ts 里定义：这里钉住几个常量之间的对应关系。
// 「别处又写了一份字面量」由 `npm run lint` 的 rules-check 拦（不依赖这个用例）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_PROXY_URL,
  LOCAL_PROXY_PORTS,
  MAX_LOCAL_PROXIES,
  PROXY_ENV_EXAMPLE,
} from './proxy.ts'

test('默认代理地址由 DEFAULT_PROXY_PORT 生成，各处用的是同一个', () => {
  assert.ok(DEFAULT_PROXY_PORT > 0 && DEFAULT_PROXY_PORT < 65536)
  assert.equal(DEFAULT_PROXY_URL, `http://127.0.0.1:${DEFAULT_PROXY_PORT}`)
  // 设置页的占位符和 CLI 环境变量示例都从这个地址拼出来，不在别处另写一份
  assert.equal(PROXY_ENV_EXAMPLE, `HTTPS_PROXY=${DEFAULT_PROXY_URL}`)
  assert.ok(DEFAULT_PROXY_URL.startsWith('http://'), 'ProxyAgent 只认 http(s) 代理')
})

test('自动探测的端口顺序：默认端口在列表里，且排进真正会尝试的那几个', () => {
  const at = LOCAL_PROXY_PORTS.indexOf(DEFAULT_PROXY_PORT)
  assert.ok(at >= 0, '默认端口要在 LOCAL_PROXY_PORTS 里')
  assert.ok(at < MAX_LOCAL_PROXIES, '默认端口要排进前 MAX_LOCAL_PROXIES 个，否则永远试不到')
  assert.equal(new Set(LOCAL_PROXY_PORTS).size, LOCAL_PROXY_PORTS.length, '端口不重复')
})
