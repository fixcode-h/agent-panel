import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BUILTIN_MODEL_CATALOG } from '../../shared/models/catalog.ts'

// 补充目录写在数据目录里：用临时目录，不碰本机的 ~/.agent-panel
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-discover-'))
const { discoverPrompt, modelDiscoverApi, parseDiscovered } = await import('./model-discover.ts')
const { modelCatalogApi } = await import('./model-catalog.ts')

test('联网检查的回复：models 列表整理成目录记录，坏的单条跳过，images 照写', () => {
  const list = parseDiscovered({
    models: [
      {
        vendor: 'openai',
        id: 'gpt-6.2-sol',
        context: '1,050,000',
        maxOutput: 128000,
        protocols: ['responses', 'chat'],
        efforts: ['low', 'max', 'none'],
        images: true,
        source: 'https://developers.openai.com/',
      },
      { vendor: 'x', id: '' },
      'garbage',
    ],
  })
  assert.equal(list.length, 1)
  assert.equal(list[0].context, 1_050_000)
  assert.deepEqual(list[0].protocols, ['openai-responses', 'openai-chat'])
  assert.deepEqual(list[0].efforts, ['low', 'max'])
  assert.equal(list[0].images, true)
  // 直接给数组也认；没有列表的报错
  assert.equal(parseDiscovered([{ vendor: 'deepseek', id: 'deepseek-v5' }]).length, 1)
  assert.throws(() => parseDiscovered({ answer: 'none' }))
})

test('联网检查的提示词带上目录里每家已有的模型，让 Agent 只列没有的', () => {
  const p = discoverPrompt(BUILTIN_MODEL_CATALOG, '2026-11-18')
  assert.match(p, /今天是 2026-11-18/)
  assert.match(p, /openai：.*gpt-6\.2-astra/)
  assert.match(p, /google：.*（无）/)
})

test('勾选的候选写进补充目录、读目录时标成补充；删掉后不再有；空列表不收', async () => {
  const app = modelDiscoverApi()
  const post = (url: string, body: unknown) =>
    app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const entry = { vendor: 'openai', id: 'gpt-test-x', context: 1000, maxOutput: 100 }
  const added = (await (await post('/entries', { entries: [entry] })).json()) as { entries: { id: string }[] }
  assert.ok(added.entries.some((e) => e.id === 'gpt-test-x'))
  const info = (await (await modelCatalogApi().request('/')).json()) as { userKeys: string[]; builtinUpdated: string }
  assert.deepEqual(info.userKeys, ['openai:gpt-test-x'])
  assert.match(info.builtinUpdated, /^\d{4}-\d{2}-\d{2}$/)
  const removed = (await (await post('/entries/remove', { vendor: 'openai', id: 'gpt-test-x' })).json()) as {
    entries: { id: string }[]
  }
  assert.ok(!removed.entries.some((e) => e.id === 'gpt-test-x'))
  assert.equal((await post('/entries', { entries: [] })).status, 400)
})
