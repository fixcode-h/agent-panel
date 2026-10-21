import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collisions, createClaims, normClaimPath, overlaps } from './claims.ts'

test('认领路径统一写法，目录包含文件也算重叠', () => {
  assert.equal(normClaimPath('.\\src\\a.ts'), 'src/a.ts')
  assert.equal(normClaimPath('./web/'), 'web')
  assert.ok(overlaps('src', 'src/a.ts'))
  assert.ok(overlaps('src/a.ts', 'src/a.ts'))
  assert.ok(!overlaps('src/a.ts', 'src/ab.ts'))
})

test('同一个父对话下，别的子对话占着的文件认领不到，释放后才能拿到', () => {
  const c = createClaims()
  const a = { taskId: 'a', title: '首页轮播' }
  const b = { taskId: 'b', title: '评价模块' }
  assert.deepEqual(c.claim('root', a, ['src/home', 'README.md']).granted, ['src/home', 'README.md'])
  const r = c.claim('root', b, ['src/home/Banner.tsx', 'src/detail'])
  assert.deepEqual(r.granted, ['src/detail'])
  assert.deepEqual(r.held, [{ path: 'src/home/Banner.tsx', by: '首页轮播', byId: 'a' }])
  // 自己重复认领不冲突
  assert.deepEqual(c.claim('root', a, ['src/home']).held, [])
  // 不同父对话互不影响
  assert.deepEqual(c.claim('other', b, ['src/home']).held, [])
  assert.equal(c.release('root', 'a'), 2)
  assert.deepEqual(c.claim('root', b, ['src/home/Banner.tsx']).held, [])
  assert.deepEqual(
    c.list('root').map((x) => x.path),
    ['src/detail', 'src/home/Banner.tsx'],
  )
})

test('一轮改动和其他正在执行的子对话改的文件撞了就列出来', () => {
  assert.deepEqual(
    collisions(
      ['src/a.ts', 'src/b.ts'],
      [
        { title: '甲', files: ['src/a.ts'] },
        { title: '乙', files: ['src/c.ts'] },
      ],
    ),
    [{ path: 'src/a.ts', with: '甲' }],
  )
})
