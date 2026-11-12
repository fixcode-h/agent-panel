/**
 * 契约写法的几个基础件：拼地址、「schema 补了默认值」算对不上。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { contractProblems, urlOf } from './define.ts'

test('urlOf：路径参数做编码，查询参数里空值不带', () => {
  assert.equal(urlOf('/tasks/:id/children', { id: 'a b' }), '/tasks/a%20b/children')
  assert.equal(urlOf('/tasks/:id', { id: 'x' }, { limit: 40, before: '' }), '/tasks/x?limit=40')
  assert.equal(urlOf('/tasks', {}, { projectId: undefined }), '/tasks')
  assert.throws(() => urlOf('/tasks/:id', {}), /少了路径参数 id/)
})

test('contractProblems：缺了带默认值的字段也算对不上，多出来的字段不管', () => {
  const S = z.object({
    id: z.string(),
    tags: z.array(z.string()).default([]),
    inner: z.object({ n: z.number().default(0) }),
  })
  assert.deepEqual(contractProblems(S, { id: 'a', tags: [], inner: { n: 1 }, extra: true }), [])
  assert.deepEqual(contractProblems(S, { id: 'a', inner: {} }), [
    '缺字段 .tags（schema 用默认值补上了）',
    '缺字段 .inner.n（schema 用默认值补上了）',
  ])
  assert.deepEqual(contractProblems(z.array(S), [{ id: 'a', tags: [], inner: {} }]), [
    '缺字段 [0].inner.n（schema 用默认值补上了）',
  ])
  // 类型不对直接报 zod 的错
  assert.equal(contractProblems(S, { id: 1 }).length, 1)
})
