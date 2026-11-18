import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveUrls, sniffUrl, type UrlJob } from './url.ts'

const job = (over: Partial<UrlJob> = {}): UrlJob => ({
  id: 'j1',
  name: '开发服务器',
  command: 'npm run dev',
  state: 'running',
  startedAt: '2026-11-18T01:00:00Z',
  endedAt: '',
  ...over,
})

test('输出里认出地址、端口通了才记下；记下后不再换', async () => {
  const j = job()
  const tried: number[] = []
  await sniffUrl(j, 'Local: http://localhost:5173/', {
    probe: async (_h, port) => (tried.push(port), true),
    gapMs: 1,
  })
  assert.equal(j.url, 'http://localhost:5173/')
  assert.equal(sniffUrl(j, 'Local: http://localhost:9999/'), undefined)
  assert.deepEqual(tried, [5173])
})

test('端口一直不通就放掉，后面的输出还能再认', async () => {
  const j = job()
  await sniffUrl(j, 'http://localhost:3000', { probe: async () => false, tries: 2, gapMs: 1 })
  assert.equal(j.url, undefined)
  assert.equal(j.urlProbing, undefined)
  await sniffUrl(j, 'http://localhost:3001', { probe: async () => true, gapMs: 1 })
  assert.equal(j.url, 'http://localhost:3001/')
})

test('交给页面的地址：跑着的算运行中，结束了算已停止，没认出地址的不列', () => {
  const list = [
    job({ url: 'http://localhost:1/' }),
    job({ id: 'j2', state: 'stopped', endedAt: 'x', url: 'http://localhost:2/' }),
    job({ id: 'j3' }),
  ]
  assert.deepEqual(
    liveUrls(list).map((x) => [x.job, x.state]),
    [
      ['j1', 'running'],
      ['j2', 'stopped'],
    ],
  )
})
