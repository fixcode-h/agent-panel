/** 沙箱源：令牌只认自己的根目录，逃不出去；响应带 CSP sandbox */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { installHttpGuards } from '../http-guards.ts'
import { SANDBOX_PREFIX, grantRoot, sandboxUrl, serveSandbox } from './sandbox.ts'

test('按令牌发根目录里的文件，相对引用能取到，越界和过期的拒绝', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sandbox-'))
  try {
    const root = path.join(base, 'root')
    await mkdir(path.join(root, 'sub'), { recursive: true })
    await writeFile(path.join(root, 'sub', 'a b.html'), '<h1>hi</h1>')
    await writeFile(path.join(root, 'style.css'), 'h1{}')
    await writeFile(path.join(base, 'secret.txt'), 'no')
    const app = new Hono()
    installHttpGuards(app)
    app.get(`${SANDBOX_PREFIX}*`, serveSandbox)
    const token = grantRoot(root)
    assert.equal(grantRoot(root), token, '同一个根目录复用令牌')
    const page = await app.request(sandboxUrl(token, 'sub/a b.html'))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(page.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/)
    assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /allow-same-origin/)
    assert.equal(page.headers.get('x-frame-options'), null)
    assert.equal((await app.request(sandboxUrl(token, 'style.css'))).status, 200)
    assert.equal((await app.request(`${SANDBOX_PREFIX}${token}/%2e%2e/secret.txt`)).status, 404)
    assert.equal((await app.request(sandboxUrl('nope', 'style.css'))).status, 404)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
