/**
 * 插件依赖（插件接口 10）：最低版本怎么读、缺哪些、依赖链断了时连带不加载、谁依赖谁。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import { dependentsOf, minVersion, splitByRequires, unmetRequires } from './requires.ts'

setLang('zh')

test('依赖：最低版本只认下限，缺的和太旧的都列出来', () => {
  assert.equal(minVersion('>=1.2.0'), '1.2.0')
  assert.equal(minVersion('^1.2.0'), '1.2.0')
  assert.equal(minVersion('*'), '')
  const have = [
    { id: 'comfy', version: '1.0.0' },
    { id: 'video', version: '2.0.0-beta.1' },
  ]
  assert.deepEqual(unmetRequires('ui-design', { comfy: '>=1.0.0', video: '>=2.0.0', ue: '1.0.0' }, have), [
    { id: 'video', min: '2.0.0', current: '2.0.0-beta.1' },
    { id: 'ue', min: '1.0.0', current: '' },
  ])
  assert.deepEqual(unmetRequires('comfy', { comfy: '>=9.0.0' }, have), [], '依赖自己的不算')
})

test('依赖：链上有一环缺了，后面依赖它的也不加载，并写明缺什么', () => {
  const { ok, bad } = splitByRequires([
    { id: 'a', version: '1.0.0', requires: { b: '>=1.0.0' } },
    { id: 'b', version: '1.0.0', requires: { c: '>=1.0.0' } },
    { id: 'd', version: '1.0.0' },
  ])
  assert.deepEqual(
    ok.map((p) => p.id),
    ['d'],
  )
  assert.match(bad.get('b')!, /缺少依赖插件 c/)
  assert.match(bad.get('a')!, /缺少依赖插件 b/)
  assert.deepEqual(dependentsOf('b', [{ id: 'a', requires: { b: '1' } }, { id: 'd' }]), ['a'])
})
