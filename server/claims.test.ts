import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childFilesInfo, collisions, createClaims, normClaimPath, overlaps, scopeOverlaps } from './claims.ts'

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

test('独立分支模式：两边改同一个文件只提示合并时按 git merge 处理，不认领也不劝拆', () => {
  const both = scopeOverlaps(
    ['web/src/components/usage/UsageSection.tsx'],
    [
      { title: '用量面板', files: ['web/src/components/usage/UsageSection.tsx'] },
      { title: '成本模块', files: ['web/src/components/usage/CostCard.tsx'] },
    ],
  )
  assert.deepEqual(
    both,
    [{ path: 'web/src/components/usage/UsageSection.tsx', with: '用量面板' }],
    '只留重叠的那个，同一个文件被多个子对话改过不重复列',
  )
  const [info] = childFilesInfo({ isolation: 'worktree', granted: [], held: [], both })
  assert.match(info, /git merge/, '说明合并时按 git merge 处理')
  assert.match(info, /核对内容/, '合并后核对内容，免得静默丢掉一方的改动')
  assert.ok(!/没有认领|等那边做完|拆开范围/.test(info), '没有认领、等待、拆范围这类限制性话术')
})

test('独立分支模式：没有重叠时不提示任何文件相关的话', () => {
  assert.deepEqual(childFilesInfo({ isolation: 'worktree', granted: [], held: [], both: [] }), [])
})

test('共用目录模式：认领和没认领的提示保持原样', () => {
  const lines = childFilesInfo({
    isolation: 'claim',
    granted: ['src/a.ts'],
    held: [{ path: 'src/b.ts', by: '评价模块' }],
    both: [{ path: 'src/a.ts', with: '首页轮播' }],
  })
  assert.deepEqual(lines, [
    '已替它认领：src/a.ts',
    '这些已经归别的子对话，没有认领：src/b.ts（「评价模块」）。让它等那边做完再改，或者把这部分交给那个子对话',
  ])
})
