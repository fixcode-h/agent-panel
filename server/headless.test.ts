import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HeadlessPages, findBrowser, headlessArgs } from './headless.ts'

test('findBrowser：指定的路径优先，Linux 按 PATH 找 chrome / chromium', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hl-'))
  try {
    const exe = path.join(dir, 'chromium')
    writeFileSync(exe, '')
    assert.equal(findBrowser({ PATH: dir }, 'linux'), exe)
    assert.equal(findBrowser({ AGENT_PANEL_BROWSER: exe }, 'linux'), exe)
    // 指定了但不存在：不去猜别的
    assert.equal(findBrowser({ AGENT_PANEL_BROWSER: path.join(dir, 'nope'), PATH: dir }, 'linux'), undefined)
    assert.equal(findBrowser({ PATH: path.join(dir, 'empty') }, 'linux'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('headlessArgs：无头、独立的用户目录，root 时关沙箱，地址放最后', () => {
  const a = headlessArgs('http://127.0.0.1:1/#/capture/d1', '/tmp/p', false)
  assert.ok(a.includes('--headless=new'))
  assert.ok(a.includes('--user-data-dir=/tmp/p'))
  assert.ok(!a.includes('--no-sandbox'))
  assert.equal(a.at(-1), 'http://127.0.0.1:1/#/capture/d1')
  assert.ok(headlessArgs('u', '/tmp/p', true).includes('--no-sandbox'))
})

test('HeadlessPages：找不到浏览器或被关掉时返回 false；拉起后重复请求只续期不重开', async (t) => {
  assert.equal(new HeadlessPages({ url: () => 'x', browser: () => undefined }).ensure('d1'), false)
  const prev = process.env.AGENT_PANEL_HEADLESS
  process.env.AGENT_PANEL_HEADLESS = '0'
  assert.equal(new HeadlessPages({ url: () => 'x', browser: () => process.execPath }).ensure('d1'), false)
  if (prev === undefined) delete process.env.AGENT_PANEL_HEADLESS
  else process.env.AGENT_PANEL_HEADLESS = prev
  if (process.platform === 'win32') return t.skip('用 shell 脚本冒充浏览器，只在 POSIX 上跑')
  // 用一个一直挂着的脚本冒充浏览器：确认只启动一次、关闭时结束进程
  const dir = mkdtempSync(path.join(tmpdir(), 'hl-'))
  const exe = path.join(dir, 'fake-browser')
  const log = path.join(dir, 'log')
  writeFileSync(exe, `#!/bin/sh\necho "$@" >> ${log}\nexec sleep 30\n`)
  chmodSync(exe, 0o755)
  const pages = new HeadlessPages({ url: (id) => `http://x/#/capture/${id}`, browser: () => exe, idleMs: 10_000 })
  try {
    assert.equal(pages.ensure('d1'), true)
    assert.equal(pages.ensure('d1'), true)
    await new Promise((r) => setTimeout(r, 300))
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /--headless=new .*http:\/\/x\/#\/capture\/d1$/)
  } finally {
    pages.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
