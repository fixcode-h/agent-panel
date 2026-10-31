import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binaryProblem, hostOfUrl, isRemoteHostAllowed, normalizePublicUrl, tunnelUrl } from './remote.ts'
import { isLocalHost } from './hosts.ts'
import { Settings } from '../shared/schema.ts'

test('从 cloudflared 的输出里取临时地址', () => {
  const out = '2025-01-01T00:00:00Z INF |  https://funny-cats-jump.trycloudflare.com  |'
  assert.equal(tunnelUrl(out), 'https://funny-cats-jump.trycloudflare.com')
  assert.equal(tunnelUrl(out.toUpperCase().replace('HTTPS', 'https')), 'https://funny-cats-jump.trycloudflare.com')
  assert.equal(tunnelUrl('INF Requesting new quick Tunnel...'), '')
})

test('外部地址补协议、去掉路径', () => {
  assert.equal(normalizePublicUrl('panel.example.com'), 'https://panel.example.com')
  assert.equal(normalizePublicUrl('https://panel.example.com/abc?x=1'), 'https://panel.example.com')
  assert.equal(normalizePublicUrl(' http://127.0.0.1:8787 '), 'http://127.0.0.1:8787')
  assert.equal(normalizePublicUrl(''), '')
  assert.equal(normalizePublicUrl('ftp://panel.example.com'), '')
  assert.equal(normalizePublicUrl('https://'), '')
  assert.equal(hostOfUrl('https://Panel.Example.com/path'), 'panel.example.com')
  assert.equal(hostOfUrl('not a url'), '')
})

test('外部访问默认关闭，默认用临时地址', () => {
  const s = Settings.parse({})
  assert.equal(s.remoteAccess.enabled, false)
  assert.equal(s.remoteAccess.mode, 'quick')
  assert.equal(s.remoteAccess.tunnelToken, '')
  assert.equal(s.remoteAccess.publicUrl, '')
})

test('本机主机名', () => {
  for (const h of ['127.0.0.1:8787', 'localhost:5173', '[::1]:8787', '::1']) assert.equal(isLocalHost(h), true)
  for (const h of ['panel.example.com', '192.168.1.2:8787', 'evil.localhost.example.com'])
    assert.equal(isLocalHost(h), false)
})

test('没开外部访问时，外网地址不允许', () => {
  assert.equal(isRemoteHostAllowed('panel.example.com'), false)
})

test('下载的 cloudflared 要是完整大小、本系统格式的可执行文件', () => {
  const big = 40 * 1024 * 1024
  const hex = (h: string) => Buffer.from(h, 'hex')
  assert.equal(binaryProblem(hex('7f454c46'), big, 'linux'), '')
  assert.equal(binaryProblem(Buffer.from('MZ\x90\x00', 'latin1'), big, 'win32'), '')
  assert.equal(binaryProblem(hex('cffaedfe'), big, 'darwin'), '')
  assert.equal(binaryProblem(hex('cafebabe'), big, 'darwin'), '', '通用二进制')
  // 被门户页换成 HTML、格式和系统对不上、太小的都拒绝
  assert.notEqual(binaryProblem(Buffer.from('<!DO'), big, 'linux'), '')
  assert.notEqual(binaryProblem(hex('7f454c46'), big, 'win32'), '')
  assert.notEqual(binaryProblem(hex('7f454c46'), 1000, 'linux'), '')
})
