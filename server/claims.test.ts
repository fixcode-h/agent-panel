import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  childFilesInfo,
  collisionNotice,
  collisions,
  createClaims,
  normClaimPath,
  overlaps,
  scopeOverlaps,
  type CollisionChild,
} from './claims.ts'

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

const wt = (state: 'active' | 'merged' | 'discarded') => ({
  path: '/tmp/wt',
  branch: 'agent-panel/x',
  baseBranch: 'dev',
  state,
  note: '',
})

/** 构造一个查碰撞用的子对话：默认和别的子对话共用一个工作目录（没有 worktree） */
const collisionTask = (id: string, over: Partial<Omit<CollisionChild, 'id'>> = {}): CollisionChild => ({
  id,
  parentTaskId: 'root',
  title: id,
  working: true,
  wantsWorktree: false,
  worktree: null,
  changes: [{ path: 'src/a.ts', add: 1, del: 0 }],
  ...over,
})

test('Git 项目里走独立分支的子对话，任何 worktree 状态都不提示文件撞了、也不汇报父对话', () => {
  const peer = collisionTask('兄弟')
  // 已建好、还没开（wantsWorktree）、合并回收后继续（merged）都要静默
  const states: Pick<CollisionChild, 'wantsWorktree' | 'worktree'>[] = [
    { wantsWorktree: false, worktree: wt('active') },
    { wantsWorktree: true, worktree: null },
    { wantsWorktree: false, worktree: wt('merged') },
    { wantsWorktree: true, worktree: wt('merged') },
  ]
  for (const st of states)
    assert.equal(
      collisionNotice(collisionTask('子对话', st), [peer]),
      null,
      `子对话在 ${st.wantsWorktree ? 'wantsWorktree' : ''}${st.worktree?.state ?? 'null'} 状态不应提示`,
    )
})

test('共用工作目录才提示撞了哪些文件：走独立分支的兄弟和不同父对话的不算', () => {
  const peer = collisionTask('兄弟')
  assert.equal(collisionNotice(collisionTask('子对话'), [peer]), 'src/a.ts（「兄弟」也在改）')
  // 兄弟在自己的独立分支里改，碰不到同一个文件
  assert.equal(collisionNotice(collisionTask('子对话'), [{ ...peer, wantsWorktree: true }]), null)
  assert.equal(collisionNotice(collisionTask('子对话'), [{ ...peer, worktree: wt('active') }]), null)
  // 不同父对话、没在执行的兄弟不算
  assert.equal(collisionNotice(collisionTask('子对话'), [{ ...peer, parentTaskId: 'other' }]), null)
  assert.equal(collisionNotice(collisionTask('子对话'), [{ ...peer, working: false }]), null)
  // 自己主动丢弃分支后回到共用目录，仍然提示
  assert.equal(
    collisionNotice(collisionTask('子对话', { worktree: wt('discarded') }), [peer]),
    'src/a.ts（「兄弟」也在改）',
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
