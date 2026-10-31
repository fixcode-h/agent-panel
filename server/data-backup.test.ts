import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 导入会写数据目录：换成临时目录，不碰真实的用户数据
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-backup-'))
process.env.AGENT_PANEL_DATA = path.join(dir, 'data')

const { Hono } = await import('hono')
const { dataApi, withoutSecrets, withLocalSecrets } = await import('./data.ts')
const { Settings } = await import('../shared/schema.ts')

const app = () => {
  const a = new Hono()
  const sampler = { snapshot: async () => ({}) } as unknown as Parameters<typeof dataApi>[0]['memory']
  a.route('/data', dataApi({ running: () => 0, memory: sampler }))
  return a
}

const backup = (files: Record<string, string>, kinds = ['settings']) => ({
  app: 'agent-panel',
  version: 1,
  exportedAt: '2025-01-01T00:00:00.000Z',
  kinds,
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])),
})

test('导入：带反斜杠、冒号的路径一律拒，不会在 Windows 上写出数据目录', async () => {
  for (const rel of ['config/..\\..\\..\\evil.txt', 'settings.json:stream', 'C:/evil.txt', '..\\evil.txt']) {
    const res = await app().request('/data/import', {
      method: 'POST',
      body: JSON.stringify(backup({ [rel]: 'x' })),
    })
    assert.equal(res.status, 400, `${rel} 应该被拒`)
  }
  assert.ok(!existsSync(path.join(dir, 'evil.txt')))
})

test('导出去掉全部密钥，导入时沿用本机的值', () => {
  const s = Settings.parse({
    apis: [{ id: 'a1', name: 'x', apiKey: 'sk-xxxx' }],
    webSearch: { key: 'your-api-key' },
    clis: { claude: { env: [{ key: 'TOKEN', value: 'your-api-key' }] } },
    remoteAccess: { tunnelToken: 'tok' },
  })
  const b64 = withoutSecrets(Buffer.from(JSON.stringify(s)).toString('base64'))
  assert.ok(b64)
  const out = Settings.parse(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))
  assert.equal(out.apis[0].apiKey, '')
  assert.equal(out.webSearch.key, '')
  assert.equal(out.clis.claude.env[0].value, '')
  assert.equal(out.clis.claude.env[0].key, 'TOKEN', '变量名保留，值清空')
  assert.equal(out.remoteAccess.tunnelToken, '')
  const back = withLocalSecrets(out, s)
  assert.equal(back.apis[0].apiKey, 'sk-xxxx')
  assert.equal(back.webSearch.key, 'your-api-key')
  assert.equal(back.clis.claude.env[0].value, 'your-api-key')
  assert.equal(back.remoteAccess.tunnelToken, 'tok')
})

test('导出时设置解析不了：整份不导出，不把原文连密钥带出去', () => {
  assert.equal(withoutSecrets(Buffer.from('{not json').toString('base64')), null)
})
