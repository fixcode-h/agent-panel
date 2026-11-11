import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 开放给插件的面板模块（插件接口 3）：清单 shared/plugins/host-modules.json 是插件构建时的依据，
 * 面板这边网页、服务端两张表必须和它一字不差，不然插件构建能过、在面板里取不到模块。只读源码文本，不加载这些模块。
 */
const list = JSON.parse(readFileSync('shared/plugins/host-modules.json', 'utf8')) as { web: string[]; server: string[] }
const keys = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^ {2}'([\w/.-]+)': /gm)].map((m) => m[1]).sort()

test('网页的开放模块表和清单一致', () => {
  assert.deepEqual(keys('web/src/plugins/host-modules.ts'), [...list.web].sort())
})

test('服务端的开放模块表和清单一致', () => {
  assert.deepEqual(keys('server/plugins/host-modules.ts'), [...list.server].sort())
})

test('清单里的模块都在', () => {
  for (const k of [...list.web, ...list.server])
    assert.ok(existsSync(`${k}.ts`) || existsSync(`${k}.tsx`), `${k} 不存在：改名或删掉时同步清单和插件`)
})
