// scripts/secret-check.mjs 的测试：样本都在运行时拼接，避免这个文件自己被扫描命中
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { entropy, FILE_RULES, isPlaceholder, looksRandom, mask, scanText } from './secret-check.mjs'

const randomish = 'A1b2C3d4' + 'E5f6G7h8' + 'I9j0K1l2' + 'M3n4O5p6'
const base64ish = 'Zx9Qw8Er7Ty6' + 'Ui5Op4As3Df2' + 'Gh1Jk0Lm' + 'nBv9'

test('常见格式的密钥都能认出', () => {
  assert.deepEqual(
    scanText('OPENAI_KEY=' + 'sk-' + randomish).map((h) => h.rule),
    ['sk- 开头的 API key'],
  )
  assert.deepEqual(
    scanText('key=' + 'sk-ant-' + randomish).map((h) => h.rule),
    ['sk- 开头的 API key'],
  )
  assert.deepEqual(
    scanText('token: ' + 'ghp_' + randomish).map((h) => h.rule),
    ['GitHub 令牌'],
  )
  assert.deepEqual(
    scanText('Authorization: ' + 'Bearer ' + base64ish).map((h) => h.rule),
    ['Bearer 令牌'],
  )
  assert.deepEqual(
    scanText('-----BEGIN ' + 'RSA PRIVATE KEY-----').map((h) => h.rule),
    ['私钥块'],
  )
  assert.deepEqual(
    scanText('api_key: ' + 'AKIA' + 'ABCDEFGHIJKLMNOP').map((h) => h.rule),
    ['AWS 访问密钥'],
  )
})

test('没有前缀的随机串按熵识别', () => {
  const hits = scanText('token = ' + randomish)
  assert.deepEqual(
    hits.map((h) => h.rule),
    ['高熵随机串'],
  )
  assert.ok(entropy(randomish) >= 4.5)
  assert.ok(looksRandom(randomish))
})

test('占位符、示例和常量名不算密钥', () => {
  const placeholder = 'sk-' + 'x'.repeat(24)
  assert.equal(scanText('api_key: ' + placeholder).length, 0)
  assert.equal(scanText('api_key=your-api-key-here').length, 0)
  assert.equal(scanText('api_key=AGENT_PANEL_API_KEY').length, 0)
  assert.equal(scanText('const apiKey = process.env.OPENAI_API_KEY').length, 0)
  assert.ok(isPlaceholder(placeholder))
  assert.ok(isPlaceholder('sk-ant-' + 'y'.repeat(4) + 'xxxxxxxxxxxxxxxx'))
})

test('行尾写 secret-check-ok 的行跳过', () => {
  assert.equal(scanText('api_key: ' + 'sk-' + randomish + ' // secret-check-ok 测试夹具').length, 0)
})

test('lock 文件和路径不按高熵误报', () => {
  const integrity = '"integrity": "sha512-' + base64ish + base64ish + '=="'
  assert.deepEqual(scanText(integrity, { highEntropy: false }), [])
  assert.equal(scanText('/ComfyUI/ComfyUI_00001_.png').length, 0)
  assert.equal(scanText('const id = "1234567890abcdef1234567890abcdef"').length, 0)
})

test('输出只留前后几位，不泄露完整值', () => {
  const value = 'sk-' + randomish
  const shown = mask(value)
  assert.ok(!shown.includes(value))
  assert.ok(shown.startsWith('sk-A1b'))
  assert.ok(shown.includes('共 35 字符'))
})

test('不该进仓库的文件名会被发现', () => {
  const matches = (name) => FILE_RULES.some((r) => r.re.test(name))
  assert.ok(matches('.env'))
  assert.ok(matches('server/.env.local'))
  assert.ok(matches('certs/server.pem'))
  assert.ok(matches('keys/service.key'))
  assert.ok(matches('id_rsa'))
  assert.ok(!matches('.env.example'))
  assert.ok(!matches('.env.sample'))
  assert.ok(!matches('web/src/index.ts'))
})
