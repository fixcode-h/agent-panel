/**
 * 插件用到的开放模块和面板清单核对（插件框架改进 B1）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hostModulesError, missingHostModules } from './host-modules-check.ts'

const list = { web: ['web/src/lib/api'], server: ['server/log'], serverPackages: ['zod'] }

test('用到的模块面板都开放了（含第三方包）：不缺', () => {
  assert.deepEqual(
    missingHostModules({ hostModules: { web: ['web/src/lib/api'], server: ['server/log', 'zod'] } }, list),
    [],
  )
})

test('旧插件没写 hostModules：不核对', () => {
  assert.deepEqual(missingHostModules({}, list), [])
})

test('面板没开放的模块：按端列出来，报错写明要升级面板', () => {
  const miss = missingHostModules({ hostModules: { web: ['web/src/lib/new'], server: ['zod', 'server/new'] } }, list)
  assert.deepEqual(miss, ['web:web/src/lib/new', 'server:server/new'])
  assert.match(hostModulesError(miss), /web:web\/src\/lib\/new.*升级面板/)
  assert.equal(hostModulesError([]), '')
})
