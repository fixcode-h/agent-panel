/**
 * 从 CLI 读模型列表的解析。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandCodeCatalog, parsePiModels } from './models.ts'

test('Command Code：安装包里的模型目录读出上下文窗口和每个模型支持的思考强度', () => {
  const md = [
    '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |',
    '|---|---|---|---|---|---|---|',
    '| `deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1M | off, low, high, max | $0.15/$0.6 · cache $0.003 | Go and above | hybrid reasoning |',
    '| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | 256K | — | $0.95/$4 · cache $0.19 | Go and above | coding |',
    '| `xiaomi/mimo-v2.6-pro` | MiMo V2.6 Pro | 1.05M | low, high, max | $0.435/$0.87 · cache $0.0036 | GOAT and above | coding |',
  ].join('\n')
  assert.deepEqual(
    [...parseCommandCodeCatalog(md)],
    [
      ['deepseek/deepseek-v4.1-flash', { window: 1_000_000, efforts: ['off', 'low', 'high', 'max'] }],
      ['moonshotai/Kimi-K2.7-Code', { window: 256_000, efforts: [] }],
      ['xiaomi/mimo-v2.6-pro', { window: 1_050_000, efforts: ['low', 'high', 'max'] }],
    ],
  )
  // 旧的目录没有 Efforts 列（这一列是价格）时只当不知道强度，不能把价格当成强度
  const old = '| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1M | $0.66/$1.98 | Go | long-context reasoning |'
  assert.deepEqual([...parseCommandCodeCatalog(old)], [['deepseek/deepseek-v4-pro', { window: 1_000_000 }]])
})

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
      maxOutput: 64_000,
      efforts: ['low', 'high'],
    },
    {
      id: 'google/gemini-2.5-flash',
      label: 'gemini-2.5-flash',
      group: 'google',
      contextWindow: 1_000_000,
      maxOutput: 65_500,
      efforts: ['low', 'high'],
    },
    {
      id: 'ollama/qwen2.5-coder:7b',
      label: 'qwen2.5-coder:7b',
      group: 'ollama',
      contextWindow: 128_000,
      maxOutput: 16_400,
      efforts: [],
    },
  ])
  // 一个提供方都没配时只有一句提示，没有模型
  assert.deepEqual(parsePiModels('No models available. Use /login to log into a provider', []), [])
})
