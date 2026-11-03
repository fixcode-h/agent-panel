/**
 * Codex 的思考摘要：设置里的下拉选项（CLI 定义 options 里带 choices 的那种），选中的值填进 model_reasoning_summary。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from './clis.ts'
import { CliSpec } from './cli-spec.ts'
import codex from './clis/codex.json' with { type: 'json' }
import { Settings } from './schema.ts'
import { cliSettings, optionValue } from './settings.ts'

const opts = { model: 'gpt-6-astra', permission: 'workspace-write', extraArgs: [] }
const summaryArg = (args: string[]) => args.find((a) => a.startsWith('model_reasoning_summary='))

test('Codex 设置里有「思考摘要」下拉：四种取值、默认 auto，选中的值填进 model_reasoning_summary', () => {
  const o = getCli('codex')!.options!.find((x) => x.id === 'reasoningSummary')!
  assert.deepEqual(
    o.choices.map((c) => c.id),
    ['auto', 'concise', 'detailed', 'none'],
  )
  assert.equal(o.default, 'auto')
  const codex = getCli('codex')!
  for (const v of ['auto', 'concise', 'detailed', 'none'])
    assert.equal(
      summaryArg(codex.buildArgs({ ...opts, options: { reasoningSummary: v } })),
      `model_reasoning_summary="${v}"`,
    )
  // 没给设置时不加（调用方都会经过 cliSettings 带上默认值）
  assert.equal(summaryArg(codex.buildArgs(opts)), undefined)
})

test('旧设置没有这一项时按默认 auto；存的值不在可选项里也退回默认；开关照旧', () => {
  const s = Settings.parse({})
  assert.equal(cliSettings(s, 'codex').options.reasoningSummary, 'auto')
  const o = getCli('codex')!.options!.find((x) => x.id === 'reasoningSummary')!
  assert.equal(optionValue(o, 'detailed'), 'detailed')
  assert.equal(optionValue(o, 'bogus'), 'auto')
  assert.equal(optionValue(o, true), 'auto')
  // 开关照旧：存了布尔值就用，没存用默认
  const pi = getCli('pi')!.options!.find((x) => x.id === 'offline')!
  assert.equal(optionValue(pi, false), false)
  assert.equal(optionValue(pi, undefined), true)
  assert.equal(
    cliSettings(s, 'pi').env.some((e) => e.key === 'PI_OFFLINE'),
    true,
  )
  // 定义里下拉选项的默认值要是可选项之一
  const opt = (d: string) => ({ id: 'a', label: 'A', default: d, choices: [{ id: 'y', label: 'Y' }] })
  assert.equal(CliSpec.safeParse({ ...codex, options: [opt('z')] }).success, false)
  assert.equal(CliSpec.safeParse({ ...codex, options: [opt('y')] }).success, true)
})
