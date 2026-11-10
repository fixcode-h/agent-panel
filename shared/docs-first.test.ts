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

test('先建模块文档：写了理由、角色关了开关、宿主查不了文档时放行；没写 modules 要它写上', async () => {
  const skip = await docsFirst({ modules: ['calc'], skipDocs: '分析失败' }, lookup([]), true)
  assert.equal(skip.block, undefined)
  assert.match(skip.note!, /没先建文档：分析失败/)
  assert.equal((await docsFirst({ modules: ['calc'] }, lookup([]), false)).block, undefined)
  assert.match((await docsFirst({}, lookup([]), true)).block!, /要写 modules/, '开着开关又没写 modules：拦下要它写')
  assert.deepEqual(await docsFirst({ skipDocs: '只写文档' }, lookup([]), true), {})
  assert.deepEqual(await docsFirst({}, lookup([]), false), {})
  assert.deepEqual(await docsFirst({ modules: ['calc'] }, undefined, true), {})
})

test('用户报的 Bug 不等文档：照建子对话，派单写明文档在并行建，返回里叫协调器同时派「文档」（分析稿 B11）', async () => {
  const r = await docsFirst({ modules: ['calc', 'web'], bug: true }, lookup(['web']), true)
  assert.equal(r.block, undefined)
  assert.match(r.note!, /- web：docs\/modules\/web\/README\.md/)
  assert.match(r.note!, /- calc/)
  assert.match(r.note!, /不用等它/)
  assert.match(r.info!, /还没有模块文档：calc/)
  assert.match(r.info!, /现在就用 spawn_agents/)
  assert.match(r.info!, /\{"task": "模块分析"\}/)
  // 没写 modules 照样要它写上（拦一下不用等，只是补参数）
  assert.match((await docsFirst({ bug: true }, lookup([]), true)).block!, /要写 modules/)
})
