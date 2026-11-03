import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docsFirst } from './docs-first.ts'

const lookup = (have: string[]) => async (modules: string[]) => ({
  root: '/p/docs',
  found: Object.fromEntries(modules.filter((m) => have.includes(m)).map((m) => [m, `docs/modules/${m}/README.md`])),
  missing: modules.filter((m) => !have.includes(m)),
})

test('先建模块文档：有模块没文档就拦下并说清下一步，都有就把路径附进派单', async () => {
  const block = await docsFirst({ modules: ['calc', 'docs/modules/web/'] }, lookup(['web']), true)
  assert.match(block.block!, /还没有模块文档：calc/)
  assert.match(block.block!, /\{"task": "模块分析"\}/)
  assert.match(block.block!, /skip_docs/)
  const ok = await docsFirst({ modules: ['web'] }, lookup(['web']), true)
  assert.equal(ok.block, undefined)
  assert.match(ok.note!, /- web：docs\/modules\/web\/README\.md/)
})

test('先建模块文档：写了理由、角色关了开关、没写 modules、宿主查不了文档时都放行', async () => {
  const skip = await docsFirst({ modules: ['calc'], skipDocs: '分析失败' }, lookup([]), true)
  assert.equal(skip.block, undefined)
  assert.match(skip.note!, /没先建文档：分析失败/)
  assert.equal((await docsFirst({ modules: ['calc'] }, lookup([]), false)).block, undefined)
  assert.deepEqual(await docsFirst({}, lookup([]), true), {})
  assert.deepEqual(await docsFirst({ modules: ['calc'] }, undefined, true), {})
})
