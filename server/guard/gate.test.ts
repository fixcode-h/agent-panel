import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { EXTERNAL_ENV, FORWARDED_ENV } from '../hosts.ts'
import { clientIp } from './gate.ts'

// 访问者地址决定输错锁定按谁算：转发头只在「自建反代 + 连接来自本机 / 内网」时才信
const app = new Hono()
app.get('/', (c) => c.text(clientIp(c)))
const ipOf = async (headers: Record<string, string>, opts: { forwarded: boolean; peer: string }) =>
  (
    await app.request(
      'http://127.0.0.1:8788/',
      { headers },
      {
        [EXTERNAL_ENV]: true,
        [FORWARDED_ENV]: opts.forwarded,
        incoming: { socket: { remoteAddress: opts.peer } },
      },
    )
  ).text()

test('clientIp：frp 直通时不信转发头，自建反代取最后一跳', async () => {
  const frp = { forwarded: false, peer: '127.0.0.1' }
  assert.equal(await ipOf({ 'x-forwarded-for': '203.0.113.9' }, frp), '127.0.0.1', 'frp 进来的转发头是访问者自己写的')
  assert.equal(await ipOf({ 'x-real-ip': '203.0.113.9' }, frp), '127.0.0.1')

  const proxy = { forwarded: true, peer: '127.0.0.1' }
  assert.equal(await ipOf({ 'x-forwarded-for': '198.51.100.1' }, proxy), '198.51.100.1')
  assert.equal(
    await ipOf({ 'x-forwarded-for': '1.2.3.4, 198.51.100.1' }, proxy),
    '198.51.100.1',
    'nginx 追加在访问者自带的值后面：取第一个能伪造，取最后一个',
  )
  assert.equal(
    await ipOf({ 'x-real-ip': '198.51.100.2' }, proxy),
    '198.51.100.2',
    '没有 X-Forwarded-For 时看 X-Real-IP',
  )
  assert.equal(await ipOf({ 'cf-connecting-ip': '1.2.3.4' }, proxy), '127.0.0.1', '不认 CF-Connecting-IP')

  const publicPeer = { forwarded: true, peer: '203.0.113.50' }
  assert.equal(await ipOf({ 'x-forwarded-for': '1.2.3.4' }, publicPeer), '203.0.113.50', '直接从公网连进来的不信转发头')
})
