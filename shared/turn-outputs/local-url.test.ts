import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLocalUrl, roundUrls, urlLabel, urlPort, type LiveUrl } from './local-url.ts'

test('认出常见开发服务器打印的本机地址，局域网地址不认', () => {
  assert.equal(
    findLocalUrl('  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m'),
    'http://localhost:5173/',
  )
  assert.equal(findLocalUrl('  - Local:        http://localhost:3000'), 'http://localhost:3000/')
  assert.equal(findLocalUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), 'http://localhost:8000/')
  assert.equal(findLocalUrl('listening at http://127.0.0.1:8787/api.'), 'http://127.0.0.1:8787/api')
  assert.equal(findLocalUrl('open http://[::1]:4000/docs'), 'http://localhost:4000/docs')
  assert.equal(findLocalUrl('  ➜  Network: http://192.168.1.5:5173/'), '')
  assert.equal(findLocalUrl('see https://example.com/localhost:80'), '')
  assert.equal(findLocalUrl('编译完成'), '')
})

test('探活用的主机和端口；显示用的地址', () => {
  assert.deepEqual(urlPort('http://localhost:5173/'), { host: '127.0.0.1', port: 5173 })
  assert.deepEqual(urlPort('http://localhost/'), { host: '127.0.0.1', port: 80 })
  assert.equal(urlLabel('http://localhost:5173/'), 'localhost:5173')
})

test('本轮产出列哪些地址：跑着的都列，停了的只列这一轮起的，新的在前', () => {
  const u = (job: string, state: LiveUrl['state'], startedAt: string): LiveUrl => ({
    job,
    url: `http://localhost:${job}/`,
    name: job,
    command: 'npm run dev',
    state,
    startedAt,
  })
  const list = [
    u('1', 'running', '2026-11-18T01:00:00Z'),
    u('2', 'stopped', '2026-11-18T01:30:00Z'),
    u('3', 'stopped', '2026-11-18T03:00:00Z'),
  ]
  assert.deepEqual(
    roundUrls(list, '2026-11-18T02:00:00Z').map((x) => x.job),
    ['3', '1'],
  )
})
