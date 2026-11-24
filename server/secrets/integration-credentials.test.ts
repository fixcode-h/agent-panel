/** 账号授权的备用登录信息：保密项只给末 4 位、不保密的给原值、没声明的键不收，插件能写回续期后的令牌 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-cred-'))
process.env.AGENT_PANEL_DATA = dir
const { credentialHints, credentialStore, saveCredentials } = await import('./integration-credentials.ts')
test.after(() => rmSync(dir, { recursive: true, force: true }))

test('保密项只给末 4 位，不保密的给原值，没声明的键不收', async () => {
  const hints = await saveCredentials('feishu', { userToken: '  u-0123456789abcd  ', brand: 'lark', bogus: 'x' })
  assert.deepEqual(hints, { brand: { tail: '', value: 'lark' }, userToken: { tail: 'abcd' } })
  assert.equal(await credentialStore('feishu').get('userToken'), 'u-0123456789abcd')
  assert.equal(await credentialStore('feishu').get('bogus'), '')
})

test('插件能写回续期后的令牌，写没声明的键报错；空串清掉', async () => {
  const s = credentialStore('feishu')
  await s.set('refreshToken', 'r-new-refresh-token')
  assert.deepEqual((await credentialHints('feishu')).refreshToken, { tail: 'oken' })
  await assert.rejects(s.set('nope', '1'), /nope/)
  await saveCredentials('feishu', { refreshToken: '' })
  assert.equal((await credentialHints('feishu')).refreshToken, undefined)
})

test('没有备用登录项的工具什么都不存', async () => {
  assert.deepEqual(await saveCredentials('github', { token: 'ghp_x' }), {})
})
