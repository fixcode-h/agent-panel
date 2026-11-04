import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from './clis.ts'
import { builtinState, resourceState, setBuiltin, setResource } from './package-config.ts'

/** ADR 0050 第四期：插件里按类型开关资源、CLI 自带扩展的开关，只改相关的那一项 */
test('资源开关：关掉写空数组、打开删掉；只剩来源时写回字符串，用户手写的筛选原样留着；找不到包不改', () => {
  const list: unknown[] = ['npm:a', { source: 'npm:b', extensions: ['x.ts'] }]
  assert.ok(setResource(list, 'npm:a', 'skills', false))
  assert.deepEqual(list[0], { source: 'npm:a', skills: [] })
  assert.deepEqual(resourceState(list[0], ['skills', 'prompts']), { skills: false, prompts: true })
  assert.ok(setResource(list, 'npm:a', 'skills', true))
  assert.equal(list[0], 'npm:a', '只剩来源写回字符串')
  assert.ok(setResource(list, 'npm:b', 'prompts', false))
  assert.deepEqual(list[1], { source: 'npm:b', extensions: ['x.ts'], prompts: [] })
  assert.ok(setResource(list, 'npm:b', 'extensions', true), '非空的筛选不当成关')
  assert.deepEqual((list[1] as { extensions: string[] }).extensions, ['x.ts'])
  assert.equal(setResource(list, 'npm:zzz', 'skills', false), false)
})

test('内置扩展：关掉在 extensions 里加 -builtin:名字，打开去掉；别的项原样', () => {
  const spec = getCli('pi')!.packages!.builtins!
  const arr = setBuiltin(['./mine.ts'], spec, 'mcp', false)
  assert.deepEqual(arr, ['./mine.ts', '-builtin:mcp'])
  assert.equal(builtinState(arr, spec).mcp, false)
  assert.equal(builtinState(arr, spec).codemode, true)
  assert.deepEqual(setBuiltin(arr, spec, 'mcp', true), ['./mine.ts'])
  assert.equal(builtinState(undefined, spec)['llama.cpp'], true)
})
