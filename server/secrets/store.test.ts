/** 本机保密项：存进去的是密文、读得回原文、清空就删掉、换了密钥读不出也不报错 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-secrets-'))
process.env.AGENT_PANEL_DATA = dir
const { dropSecrets, getSecret, secretHints, setSecret } = await import('./store.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

test('存的是密文，读回原文，界面只拿到末 4 位', async () => {
  await setSecret('plugin:demo', 'token', 'u-abcdefghijklmnop1234')
  await setSecret('plugin:demo', 'short', 'abc')
  const raw = readFileSync(path.join(dir, 'secrets', 'store.json'), 'utf8')
  assert.ok(!raw.includes('abcdefghijklmnop'), '文件里不能有原文')
  assert.equal(await getSecret('plugin:demo', 'token'), 'u-abcdefghijklmnop1234')
  assert.deepEqual(await secretHints('plugin:demo'), { token: { tail: '1234' }, short: { tail: '' } })
  assert.equal(await getSecret('plugin:other', 'token'), '', '别的命名空间读不到')
})

test('空串删掉，删插件时整个命名空间清掉', async () => {
  await setSecret('plugin:demo', 'short', '')
  assert.deepEqual(Object.keys(await secretHints('plugin:demo')), ['token'])
  await dropSecrets('plugin:demo')
  assert.equal(await getSecret('plugin:demo', 'token'), '')
})

test('密文被改坏时当没设置', async () => {
  await setSecret('plugin:demo', 'token', 'u-zzzzzzzzzzzz')
  const f = path.join(dir, 'secrets', 'store.json')
  const s = JSON.parse(readFileSync(f, 'utf8'))
  s['plugin:demo'].token.tag = Buffer.alloc(16).toString('base64')
  writeFileSync(f, JSON.stringify(s))
  assert.equal(await getSecret('plugin:demo', 'token'), '')
  assert.deepEqual(await secretHints('plugin:demo'), {})
})
