import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  childFilesInfo,
  createClaims,
  forgetClaims,
  holdTurn,
  holderState,
  holdsClaims,
  normClaimPath,
  overlaps,
  ownP4Files,
  rebuildClaims,
  releaseUnchanged,
  scopeOverlaps,
  shrinkClaims,
  type ClaimTask,
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

const wt = (state: 'active' | 'merged' | 'discarded') => ({
  path: '/tmp/wt',
  branch: 'agent-panel/x',
  baseBranch: 'dev',
  state,
  note: '',
})

/** 构造一个认领判定用的子对话：默认和兄弟共用一个工作目录（没有 worktree）、还没交出去 */
const kid = (id: string, over: Partial<ClaimTask> = {}): ClaimTask => ({
  id,
  title: id,
  parentTaskId: 'root',
  resolved: false,
  deletedAt: undefined,
  archived: false,
  stopReason: undefined,
  wantsWorktree: false,
  worktree: null,
  changes: [{ path: 'src/a.ts', add: 1, del: 0 }],
  ...over,
})
const owners = (c: ReturnType<typeof createClaims>, root = 'root') =>
  c
    .list(root)
    .map((x) => `${x.path}:${x.taskId}`)
    .sort()

test('共用目录：一轮结束认领不放、改过的记到名下，release_files 不放改过的，submit_merge 收缩到改过的，验收才全放', () => {
  const c = createClaims()
  c.claim('root', { taskId: 'A', title: 'A' }, ['src/a.ts', 'src/b.ts', 'docs'])
  // 一轮结束：没认领就改了的 src/extra.ts 也记到 A 名下
  const a = kid('A', {
    changes: [
      { path: 'src/a.ts', add: 1, del: 0 },
      { path: 'src/extra.ts', add: 1, del: 0 },
    ],
  })
  assert.deepEqual(holdTurn(c, a), [])
  const r = c.claim('root', { taskId: 'B', title: 'B' }, ['src/extra.ts', 'src/c.ts'])
  assert.deepEqual(r.granted, ['src/c.ts'])
  assert.deepEqual(r.held, [{ path: 'src/extra.ts', by: 'A', byId: 'A' }], '停下没验收的兄弟名下的文件照样拿不到')
  // release_files 不写 paths：只让出没改过的
  assert.equal(releaseUnchanged(c, a, ['src/a.ts']), 0, '改过的不让提前放')
  assert.equal(releaseUnchanged(c, a, ['src/b.ts']), 1)
  c.claim('root', { taskId: 'A', title: 'A' }, ['src/b.ts'])
  // submit_merge：声明了没碰的（src/b.ts、docs）让出来，改过的留到验收
  shrinkClaims(c, a)
  assert.deepEqual(owners(c), ['src/a.ts:A', 'src/c.ts:B', 'src/extra.ts:A'])
  // completeChild：彻底完成才全放
  c.release('root', 'A')
  assert.deepEqual(c.claim('root', { taskId: 'B', title: 'B' }, ['src/extra.ts']).granted, ['src/extra.ts'])
  // 认领被拒时写明对方状态：不在内存里的、停下的、等验收的
  assert.match(holderState(undefined), /不在执行/)
  assert.match(holderState({ working: false, wrapRequest: undefined }), /已停下/)
  assert.match(
    holderState({ working: false, wrapRequest: { state: 'requested', at: '', note: '', tests: '', info: '' } }),
    /验收/,
  )
})

test('Git 项目里走独立分支的子对话，任何 worktree 状态都不记认领、不算撞、也不汇报父对话', () => {
  // 已建好、还没开（wantsWorktree）、合并回收后继续（merged）都要静默
  const states: Partial<ClaimTask>[] = [
    { wantsWorktree: false, worktree: wt('active') },
    { wantsWorktree: true, worktree: null },
    { wantsWorktree: false, worktree: wt('merged') },
    { wantsWorktree: true, worktree: wt('merged') },
  ]
  for (const st of states) {
    const c = createClaims()
    holdTurn(c, kid('兄弟'))
    assert.deepEqual(
      holdTurn(c, kid('子对话', st)),
      [],
      `子对话在 ${st.wantsWorktree ? 'wantsWorktree' : ''}${st.worktree?.state ?? 'null'} 状态不应提示`,
    )
    assert.deepEqual(owners(c), ['src/a.ts:兄弟'])
  }
})

test('撞了按认领表判：停下等验收的兄弟也算，走独立分支的兄弟和不同父对话的不算', () => {
  const c = createClaims()
  // 兄弟这一轮早结束了（不在跑），改动还没被父对话验收
  holdTurn(c, kid('兄弟'))
  assert.deepEqual(
    holdTurn(
      c,
      kid('子对话', {
        changes: [
          { path: 'src/a.ts', add: 1, del: 0 },
          { path: 'b.ts', add: 1, del: 0 },
        ],
      }),
    ),
    [{ path: 'src/a.ts', by: '兄弟', byId: '兄弟' }],
  )
  assert.deepEqual(owners(c), ['b.ts:子对话', 'src/a.ts:兄弟'], '不覆盖兄弟的')
  // 兄弟在自己的独立分支里改，碰不到同一个文件
  const d = createClaims()
  holdTurn(d, kid('兄弟', { wantsWorktree: true }))
  holdTurn(d, kid('别家', { parentTaskId: 'other' }))
  assert.deepEqual(holdTurn(d, kid('子对话')), [])
  // 自己主动丢弃分支后回到共用目录，仍然算
  assert.equal(holdTurn(d, kid('后来', { worktree: wt('discarded') })).length, 1)
  // 已经交出去的（彻底完成）不再记
  assert.deepEqual(holdTurn(d, kid('完成了', { resolved: true, changes: [{ path: 'z.ts', add: 1, del: 0 }] })), [])
})

test('换人接手转给接手的，删除 / 归档放掉（父对话整组丢），重启按记录补回，P4 没写 files 时只分自己名下的', () => {
  const c = createClaims()
  c.hold('root', { taskId: 'A', title: 'A' }, ['src/a.ts', 'src/dir'])
  assert.equal(c.transfer('root', 'A', { taskId: 'A2', title: 'A（接手）' }), 2)
  assert.equal(c.claim('root', { taskId: 'A2', title: 'A（接手）' }, ['src/dir/x.ts']).granted.length, 1)
  assert.equal(c.claim('root', { taskId: 'B', title: 'B' }, ['src/a.ts']).held[0].by, 'A（接手）')
  // P4：名下的认领 ∪ 改过的，目录写成 dir/...，兄弟的不带
  assert.deepEqual(
    ownP4Files(c, kid('A2', { changes: [{ path: './src/new.ts', add: 1, del: 0 }] }), (p) => p === 'src/dir').sort(),
    ['src/a.ts', 'src/dir/...', 'src/dir/x.ts', 'src/new.ts'],
  )
  forgetClaims(c, { id: 'A2', parentTaskId: 'root' })
  assert.deepEqual(owners(c), [])
  c.hold('root', { taskId: 'B', title: 'B' }, ['b.ts'])
  forgetClaims(c, { id: 'root', parentTaskId: '' })
  assert.deepEqual(owners(c), [], '父对话删除 / 归档：整组丢')

  const at = (n: number) => `2026-11-0${n}T00:00:00.000Z`
  const r = createClaims()
  rebuildClaims(r, [
    { ...kid('后建', { stopReason: 'user' }), createdAt: at(2) },
    // 用户停下：改动还在共用目录里没交出去，照样占着；先建的先占
    { ...kid('A', { stopReason: 'user' }), createdAt: at(1) },
    ...(
      [
        { resolved: true },
        { deletedAt: 'x' },
        { archived: true },
        { stopReason: 'replaced' },
        { worktree: wt('active') },
        { parentTaskId: '' },
      ] as Partial<ClaimTask>[]
    ).map((o, i) => ({ ...kid(`x${i}`, { ...o, changes: [{ path: `f${i}.ts`, add: 1, del: 0 }] }), createdAt: at(3) })),
  ])
  assert.deepEqual(owners(r), ['src/a.ts:A'])
  assert.equal(holdsClaims(kid('x', { stopReason: 'parent' })), true, '跟着父对话停下的也还占着')
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
