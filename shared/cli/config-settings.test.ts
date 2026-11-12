import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigSetting, getAt, readValue, setAt, writeValue } from './config-settings.ts'
import { getCli } from '../clis.ts'
import piSpec from '../clis/pi.json' with { type: 'json' }

/** ADR 0050：CLI 自己配置文件里的设置项只写改过的键，恢复默认删掉，别的键原样保留 */

test('点分路径：没有的上级自动建，删掉后空的上级一并删；上级被写成别的类型时不覆盖', () => {
  const data: Record<string, unknown> = { keep: 1, retry: { baseDelayMs: 2000 } }
  assert.ok(setAt(data, 'retry.maxRetries', 5))
  assert.ok(setAt(data, 'codemode.mode', 'only'))
  assert.equal(getAt(data, 'retry.maxRetries'), 5)
  assert.ok(setAt(data, 'codemode.mode', undefined))
  assert.deepEqual(data, { keep: 1, retry: { baseDelayMs: 2000, maxRetries: 5 } }, '空的 codemode 删掉')
  assert.ok(setAt(data, 'images.blockImages', undefined), '本来就没有的删了也算成功')
  assert.equal(setAt({ retry: 3 }, 'retry.enabled', true), false)
  assert.equal(getAt({ retry: 3 }, 'retry.enabled'), undefined)
})

test('值的换算：秒和毫秒按 scale 换、超出范围和类型不对的不写；文件里类型不对的当没写过；Pi 的每项都有英文', () => {
  const pi = getCli('pi')!.configSettings!
  const idle = pi.find((s) => s.id === 'idleTimeout')!
  assert.deepEqual(writeValue(idle, 600), { value: 600_000 })
  assert.equal(readValue(idle, 300_000), 300)
  assert.deepEqual(writeValue(idle, 99_999), { error: 'range' })
  const transport = pi.find((s) => s.id === 'transport')!
  assert.deepEqual(writeValue(transport, 'carrier-pigeon'), { error: 'choice' })
  assert.equal(readValue(transport, 'websocket'), 'websocket')
  assert.equal(
    readValue(
      pi.find((s) => s.id === 'retry')!,
      'yes',
    ),
    undefined,
  )
  assert.equal(
    ConfigSetting.safeParse({ id: 'a', label: 'A', file: 'f', at: 'a', type: 'number', default: 'x' }).success,
    false,
  )
  const en = piSpec.i18n.en as Record<string, string>
  for (const s of piSpec.configSettings)
    for (const text of [s.label, s.hint, ...(s.choices ?? []).map((c) => c.label)].filter((x) => /[一-鿿]/.test(x)))
      assert.ok(en[text], `没有英文：${text}`)
})
