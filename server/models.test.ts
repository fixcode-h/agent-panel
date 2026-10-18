/**
 * 从 CLI 读模型列表的解析。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePiModels } from './models.ts'

test('Pi：pi --list-models 的表格换成 provider/model，带上下文窗口和思考强度', () => {
  const out = [
    'provider   model                 context  max-out  thinking  images',
    'anthropic  claude-sonnet-4-6     1M       64K      yes       yes   ',
    'google     gemini-2.5-flash      1.0M     65.5K    yes       yes   ',
    'ollama     qwen2.5-coder:7b      128K     16.4K    no        no    ',
  ].join('\n')
  assert.deepEqual(parsePiModels(out, ['low', 'high']), [
    {
      id: 'anthropic/claude-sonnet-4-6',
      label: 'claude-sonnet-4-6',
      group: 'anthropic',
      contextWindow: 1_000_000,
      efforts: ['low', 'high'],
    },
    {
      id: 'google/gemini-2.5-flash',
      label: 'gemini-2.5-flash',
      group: 'google',
      contextWindow: 1_000_000,
      efforts: ['low', 'high'],
    },
    { id: 'ollama/qwen2.5-coder:7b', label: 'qwen2.5-coder:7b', group: 'ollama', contextWindow: 128_000, efforts: [] },
  ])
  // 一个提供方都没配时只有一句提示，没有模型
  assert.deepEqual(parsePiModels('No models available. Use /login to log into a provider', []), [])
})
