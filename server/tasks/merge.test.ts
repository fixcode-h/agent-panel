/**
 * 子对话收尾（server/tasks/merge.ts）：submit_merge 的各道校验、finish_child 合回独立分支、
 * 冲突时退回子对话且保留分支、父对话目录挡路时留给父对话处理、分支上没有新改动、合并途中 / 父对话测试中的重复收尾，
 * 以及共用目录没请求收尾就不收。
 *
 * 为什么这样搭：merge.ts 只做编排（校验、先提交、记收尾请求、按结果改状态和通知），真正的 git 合并在
 * TasksScope.integrate（children.ts）里，它要整套 tasksApi 闭包才建得起来。这里给一个最小的假 scope，
 * integrate 直接调 children.ts 用的同一个 integrateBranch（worktree-integrate.ts）在真实的临时仓库上合，
 * 这样「提交到分支 → 合进原目录 → 冲突 / 挡路撤回」走的是真实 git 和真实文案，断言的是 merge.ts 自己的状态流转。
 * 运行：npx tsx --test server/tasks/merge.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
// 这个工具包会先把数据目录指到临时目录、清掉外面的 GIT_DIR 等变量、固定中文，再加载 worktree.ts
import { createWorktree, git, project, removeWorktree, tid } from '../exec/worktree-test-kit.ts'
import type { Task as TaskT } from '../../shared/schema.ts'
import type { TasksScope } from './scope.ts'

// 下面这些模块（日志、附件等）加载时会读数据目录：必须在上面的工具包设好 AGENT_PANEL_DATA 之后再加载
const { Task, TaskStep, PlanStep, TaskPlan } = await import('../../shared/schema.ts')
const { createMerge } = await import('./merge.ts')
const { createClaims } = await import('../claims.ts')
const { integrateBranch } = await import('../exec/worktree-integrate.ts')

const REVIEWER = 'a-reviewer'
const at = '2026-10-31T00:00:00.000Z'

/** 计划：改代码、评审都做完，只剩面板标的「合回」 */
function plan(extra: Parameters<typeof PlanStep.parse>[0][] = []) {
  return TaskPlan.parse({
    id: 'plan-1',
    createdAt: at,
    steps: [
      { id: '1', title: '改代码', status: 'done' },
      { id: '2', title: '评审本次改动', status: 'done', review: true },
      ...extra,
      { id: '9', title: '合回', status: 'pending', wrapUp: 'merge' },
    ],
  })
}

/** 一次通过的评审（spawn_agents 派出去的子任务） */
const review = () =>
  TaskStep.parse({
    id: 'kid/sub/r1',
    parentId: 'kid',
    slot: 'sub',
    title: '评审改动',
    agentId: REVIEWER,
    status: 'done',
    output: '验收结论：通过',
  })

const task = (over: Record<string, unknown>) =>
  Task.parse({ projectId: 'p', mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...over })

/**
 * 最小的 TasksScope：只放 merge.ts 用到的名字，调用都记下来供断言。
 * integrate 和 children.ts 一样调 integrateBranch：换分支 / 挡路检查 → 试合并 → 冲突撤回 / 没有新改动 / 提交
 */
function rig(repo: string, tasks: TaskT[]) {
  const map = new Map(tasks.map((x) => [x.id, x]))
  const jobs: { name: string; state: string }[] = []
  const woke: { id: string; text: string }[] = []
  const toChild: { id: string; text: string }[] = []
  const advanced: string[] = []
  const integrated: string[] = []
  const claims = createClaims()
  const s = {
    live: new Map(),
    claims,
    store: {
      get: async (id: string) => map.get(id) ?? null,
      list: async () => [...map.values()],
      update: async (id: string, tk: TaskT) => void map.set(id, tk),
    },
    background: { list: () => jobs, occupants: () => [] },
    deps: {
      agents: { list: async () => [{ id: REVIEWER, name: '评审', origin: 'builtin:reviewer' }] },
      projects: { get: async () => null },
    },
    parentTesting: () => false,
    reportedState: new Map(),
    reportKey: (tk: TaskT, state: string) => `${tk.id}:${state}`,
    peerOf: async (from: TaskT, rel: string, kind: string, subject: string) => ({
      id: from.id,
      title: from.title,
      name: '',
      rel,
      kind,
      subject,
    }),
    wakeConv: async (id: string, text: string) => void woke.push({ id, text }),
    alertOn: () => () => undefined,
    noteParent: async () => {},
    advanceChildTo: async (id: string) => {
      advanced.push(id)
      return { holds: [], info: '' }
    },
    mergeLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
    integrate: async (tk: TaskT) => {
      integrated.push(tk.id)
      return integrateBranch(repo, tk.worktree!, tk.title)
    },
    sendToChild: async (_parent: string, id: string, text: string) => void toChild.push({ id, text }),
    parentTestStepsOf: async () => [],
    startQueue: new Set(),
    childUnmerged: async () => false,
    taskDir: async () => repo,
  } as unknown as TasksScope
  return { m: createMerge(s), map, jobs, woke, toChild, advanced, integrated, claims }
}

/** 一个在独立分支里干活的子对话和它的父对话；分支开在真实的临时仓库上 */
async function setup(over: Record<string, unknown> = {}) {
  const repo = project()
  const id = tid()
  const wt = await createWorktree(repo, id, 'kid')
  const base = git(repo, 'rev-parse', 'HEAD').toString().trim()
  const parent = task({ id: 'root', title: '父对话' })
  const kid = task({
    id,
    parentTaskId: 'root',
    title: '子对话',
    worktree: wt,
    baseRef: base,
    steps: [review()],
    plans: [plan()],
    messages: [{ id: 'u1', role: 'user', text: '加一个 b.txt', at }],
    ...over,
  })
  const r = rig(repo, [parent, kid])
  return { repo, wt, parent, kid, ...r, cleanup: () => removeWorktree(repo, wt, true) }
}

const handoff = { files: 'b.txt — 新加的文件' }
const tests = 'npm run test:unit 通过'

/** 读文件内容、换行统一成 LF：Windows 上 Git 默认 core.autocrlf=true，合并后检出到原目录的是 CRLF */
const readText = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

test('submit_merge：不是子对话、没写 tests、后台命令没跑完、计划没做完时都不收', async () => {
  const x = await setup()
  try {
    assert.match((await x.m.submitMerge('root', '', tests, false, handoff)).info, /只有子对话/)
    assert.match((await x.m.submitMerge(x.kid.id, '', '', false, handoff)).info, /tests 里写上/)
    x.jobs.push({ name: '单测', state: 'running' })
    const bg = await x.m.submitMerge(x.kid.id, '', tests, false, handoff)
    assert.equal(bg.ok, false)
    assert.match(bg.info, /后台还有命令没跑完（「单测」）/)
    x.jobs.length = 0
    x.map.get(x.kid.id)!.plans = [plan([{ id: '3', title: '补测试', status: 'running' }])]
    const left = await x.m.submitMerge(x.kid.id, '', tests, false, handoff)
    assert.equal(left.ok, false)
    assert.match(left.info, /计划还有步骤没做完（3「补测试」）/)
    // 被拒的请求不能留下收尾记录，也不能叫起父对话
    assert.equal(x.map.get(x.kid.id)!.wrapRequest, undefined)
    assert.deepEqual(x.woke, [])
  } finally {
    await x.cleanup()
  }
})

test('submit_merge：独立分支没派过评审时被评审门禁拦下；交接要点缺必填项时也不收', async () => {
  const x = await setup({ steps: [] })
  try {
    const r = await x.m.submitMerge(x.kid.id, '', tests, false, handoff)
    assert.equal(r.ok, false)
    assert.match(r.info, /还没有真的派过「评审」/)
    x.map.get(x.kid.id)!.steps = [review()]
    const h = await x.m.submitMerge(x.kid.id, '', tests, false, {})
    assert.equal(h.ok, false)
    assert.match(h.info, /handoff 里还缺「关键文件和模块」/)
    assert.equal(x.map.get(x.kid.id)!.wrapRequest, undefined)
  } finally {
    await x.cleanup()
  }
})

test('submit_merge：先把没提交的改动提交到子对话分支，记下收尾请求、交接摘要，并叫起父对话', async () => {
  const x = await setup()
  try {
    writeFileSync(path.join(x.wt.path, 'b.txt'), 'b\n')
    const r = await x.m.submitMerge(x.kid.id, '加文件', tests, false, handoff)
    assert.equal(r.ok, true, r.info)
    assert.match(r.info, /已请父对话收尾/)
    // 改动已经在分支上成了一个提交，工作区是干净的
    assert.equal(git(x.wt.path, 'status', '--porcelain').toString().trim(), '')
    assert.match(git(x.wt.path, 'log', '--oneline', '-1').toString(), /Agent 面板：子对话 — 加文件/)
    const kid = x.map.get(x.kid.id)!
    assert.equal(kid.wrapRequest?.state, 'requested')
    assert.equal(kid.wrapRequest?.tests, tests)
    // 交接摘要带上面板补的事实：分支名、改动文件
    assert.match(kid.handoff!.text, new RegExp(x.wt.branch))
    assert.match(kid.handoff!.text, /b\.txt/)
    assert.equal(kid.plans.at(-1)!.steps.at(-1)!.status, 'waiting')
    assert.equal(x.woke.length, 1)
    assert.equal(x.woke[0].id, 'root')
    assert.match(x.woke[0].text, /【收尾请求】/)
    assert.match(x.woke[0].text, /调用 finish_child/)
  } finally {
    await x.cleanup()
  }
})

test('finish_child：子对话没请求收尾时不合并', async () => {
  const x = await setup()
  try {
    writeFileSync(path.join(x.wt.path, 'b.txt'), 'b\n')
    const r = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(r.ok, false)
    assert.match(r.info, /还没请求收尾/)
    assert.deepEqual(x.integrated, [])
    assert.equal(existsSync(path.join(x.repo, 'b.txt')), false)
  } finally {
    await x.cleanup()
  }
})

test('finish_child：合回成功时改动进了原目录，收尾步骤标完成、收尾请求清掉，再交给 advanceChildTo 收口', async () => {
  const x = await setup()
  try {
    writeFileSync(path.join(x.wt.path, 'b.txt'), 'b\n')
    assert.equal((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).ok, true)
    const r = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(r.ok, true, r.info)
    assert.match(r.info, /已把子对话「子对话」合回/)
    assert.equal(readText(path.join(x.repo, 'b.txt')), 'b\n')
    const kid = x.map.get(x.kid.id)!
    assert.equal(kid.wrapRequest, undefined)
    assert.equal(kid.plans.at(-1)!.steps.at(-1)!.status, 'done')
    assert.match(kid.messages.at(-1)!.text, /【父对话收尾】已合回原分支/)
    // 删分支、置完成不在这里做：只走 advanceChildTo（见 docs/lessons/child-wrapup.md）
    assert.deepEqual(x.advanced, [x.kid.id])
    assert.ok(existsSync(x.wt.path))
    assert.equal(x.m.merging.size, 0)
  } finally {
    await x.cleanup()
  }
})

test('finish_child：和原分支冲突时退回子对话，分支和目录都留着，原目录不变', async () => {
  const x = await setup()
  try {
    writeFileSync(path.join(x.wt.path, 'README.md'), '# 子对话改的\n')
    assert.equal((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).ok, true)
    // 父对话这边同一行也改了并提交：合并必然冲突
    writeFileSync(path.join(x.repo, 'README.md'), '# 父对话改的\n')
    git(x.repo, 'commit', '-qam', 'parent edit')
    const head = git(x.repo, 'rev-parse', 'HEAD').toString().trim()
    const r = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(r.ok, false)
    // 只有真冲突算 conflict：界面的「用 AI 合并」按钮只在这时给
    assert.equal(r.kind, 'conflict')
    assert.match(r.info, /没能合回子对话「子对话」/)
    assert.match(r.info, /已经退回给它处理/)
    assert.match(r.info, /README\.md/)
    // 原目录还在合并前的提交上、没有留下合了一半的状态
    assert.equal(git(x.repo, 'rev-parse', 'HEAD').toString().trim(), head)
    assert.equal(readText(path.join(x.repo, 'README.md')), '# 父对话改的\n')
    assert.equal(git(x.repo, 'status', '--porcelain').toString().trim(), '')
    const kid = x.map.get(x.kid.id)!
    assert.equal(kid.wrapRequest?.state, 'failed')
    assert.match(kid.wrapRequest!.info, /冲突/)
    // 收尾步骤退回进行中，写清没合回
    const wrap = kid.plans.at(-1)!.steps.at(-1)!
    assert.equal(wrap.status, 'running')
    assert.match(wrap.note, /没能合回/)
    // 错误交给子对话，不收口、不删分支
    assert.equal(x.toChild.length, 1)
    assert.match(x.toChild[0].text, /没能合回原分支/)
    assert.deepEqual(x.advanced, [])
    assert.ok(existsSync(x.wt.path))
    assert.notEqual(git(x.repo, 'branch', '--list', x.wt.branch).toString().trim(), '')
    assert.equal(x.m.merging.size, 0)
    // 退回之后再收尾：没重新请求就不收
    const again = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(again.ok, false)
    assert.match(again.info, /上次没合进去/)
  } finally {
    await x.cleanup()
  }
})

// 父对话目录挡路（审计 F2）：以前和冲突一样退回并叫醒子对话，子对话动不了父对话的目录，两边互相等或来回空转
test('finish_child：父对话目录挡路（暂存区、未提交改动 / 未跟踪文件重叠、换了分支、没做完的合并）时留给父对话，清掉后再收就合进去', async () => {
  const scenes = ['staged', 'dirty', 'untracked', 'branch', 'merge-head'] as const
  for (const scene of scenes) {
    const x = await setup()
    try {
      writeFileSync(path.join(x.wt.path, 'README.md'), '# 子对话改的\n')
      writeFileSync(path.join(x.wt.path, 'new.txt'), 'kid\n')
      assert.equal((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).ok, true)
      const base = x.wt.baseBranch!
      // 每种挡路：怎么造出来、父对话看到的说法里要点名什么、父对话按说法怎么清掉
      const how = {
        staged: {
          make: () => (writeFileSync(path.join(x.repo, 'staged.txt'), 'x\n'), git(x.repo, 'add', 'staged.txt')),
          name: /staged\.txt/,
          clear: () => git(x.repo, 'commit', '-qm', 'parent staged'),
        },
        dirty: {
          make: () => writeFileSync(path.join(x.repo, 'README.md'), '# 父对话没提交的\n'),
          name: /README\.md/,
          clear: () => git(x.repo, 'stash', '-q'),
        },
        untracked: {
          make: () => writeFileSync(path.join(x.repo, 'new.txt'), 'parent\n'),
          name: /new\.txt/,
          clear: () => git(x.repo, 'stash', '-q', '-u'),
        },
        branch: {
          make: () => git(x.repo, 'switch', '-q', '-c', 'feature-x'),
          name: new RegExp(`「feature-x」[\\s\\S]*git switch ${base}`),
          clear: () => git(x.repo, 'switch', '-q', base),
        },
        'merge-head': {
          make: () => {
            git(x.repo, 'switch', '-q', '-c', 'side')
            writeFileSync(path.join(x.repo, 's.txt'), 's\n')
            git(x.repo, 'add', '.')
            git(x.repo, 'commit', '-qm', 's')
            git(x.repo, 'switch', '-q', base)
            git(x.repo, 'merge', '--no-commit', '--no-ff', 'side')
          },
          name: /MERGE_HEAD/,
          clear: () => git(x.repo, 'merge', '--abort'),
        },
      }[scene]
      how.make()
      const r = await x.m.finishChild(x.parent, x.kid.id)
      assert.equal(r.ok, false, scene)
      assert.equal(r.kind, scene === 'branch' ? 'branch' : 'blocked', scene)
      assert.match(r.info, /原因在你的目录，不在子对话/, scene)
      assert.match(r.info, how.name, scene)
      assert.match(r.info, /再调用 finish_child/, scene)
      // 一行原因带上具体文件（暂存区那条以前只剩冒号，文件名被截掉）
      if (scene !== 'branch' && scene !== 'merge-head') assert.match(r.why ?? '', how.name, scene)
      const kid = x.map.get(x.kid.id)!
      assert.equal(kid.wrapRequest?.state, 'requested', `${scene}：收尾请求留着`)
      const wrap = kid.plans.at(-1)!.steps.at(-1)!
      assert.equal(wrap.status, 'waiting', scene)
      assert.match(wrap.note, /父对话的目录挡住了合并/, scene)
      assert.deepEqual(x.toChild, [], `${scene}：不叫醒子对话，叫醒会清掉收尾请求`)
      assert.deepEqual(x.advanced, [], scene)
      how.clear()
      const again = await x.m.finishChild(x.parent, x.kid.id)
      assert.equal(again.ok, true, `${scene}：${again.info}`)
      assert.equal(readText(path.join(x.repo, 'README.md')), '# 子对话改的\n', scene)
      assert.equal(x.map.get(x.kid.id)!.wrapRequest, undefined, scene)
      assert.deepEqual(x.advanced, [x.kid.id], scene)
    } finally {
      await x.cleanup()
    }
  }
})

test('finish_child：分支上没有新改动时照常收尾，原目录不多出提交', async () => {
  const x = await setup()
  try {
    assert.equal((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).ok, true)
    const head = git(x.repo, 'rev-parse', 'HEAD').toString().trim()
    const r = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(r.ok, true, r.info)
    assert.match(r.info, /分支上没有新的改动/)
    assert.equal(git(x.repo, 'rev-parse', 'HEAD').toString().trim(), head)
    assert.equal(x.map.get(x.kid.id)!.wrapRequest, undefined)
    assert.deepEqual(x.advanced, [x.kid.id])
  } finally {
    await x.cleanup()
  }
})

test('合并途中、父对话测试中、已经完成时都不重复收尾；合并途中子对话也不能再请求', async () => {
  const x = await setup()
  try {
    writeFileSync(path.join(x.wt.path, 'b.txt'), 'b\n')
    assert.equal((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).ok, true)
    x.m.merging.add(x.kid.id)
    const busy = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(busy.ok, false)
    assert.match(busy.info, /正在合并/)
    assert.match((await x.m.submitMerge(x.kid.id, '', tests, false, handoff)).info, /父对话正在合并你的分支/)
    x.m.merging.delete(x.kid.id)
    const kid = x.map.get(x.kid.id)!
    kid.wrapRequest = { ...kid.wrapRequest!, state: 'testing' }
    assert.match((await x.m.finishChild(x.parent, x.kid.id)).info, /等结果，不要重复收尾/)
    kid.resolved = true
    const done = await x.m.finishChild(x.parent, x.kid.id)
    assert.equal(done.ok, true)
    assert.match(done.info, /已经完成了/)
    assert.deepEqual(x.integrated, [])
    // 别人名下的子对话不收
    const other = task({ id: 'other-root', title: '别的父对话' })
    assert.match((await x.m.finishChild(other, x.kid.id)).info, /找不到这个子对话/)
  } finally {
    await x.cleanup()
  }
})

test('共用目录的子对话：改了文件但没请求收尾时不收；请求过后验收标完成，不做 git 合并，认领收缩到改过的文件', async () => {
  const repo = project()
  const parent = task({ id: 'root', title: '父对话' })
  const kid = task({
    id: 'shared-kid',
    parentTaskId: 'root',
    title: '共用目录',
    steps: [review()],
    plans: [plan()],
    changes: [{ path: 'b.txt', add: 1, del: 0 }],
  })
  const x = rig(repo, [parent, kid])
  x.claims.claim('root', { taskId: kid.id, title: kid.title }, ['b.txt', 'c.txt'])
  const r = await x.m.finishChild(parent, kid.id)
  assert.equal(r.ok, false)
  assert.match(r.info, /改了 1 个文件，还没请求收尾/)
  assert.deepEqual(x.advanced, [])
  // 共用目录照样过评审、测试、交接；通过后请父对话「验收」而不是合回
  const sub = await x.m.submitMerge(kid.id, '', tests, false, handoff)
  assert.equal(sub.ok, true, sub.info)
  assert.match(sub.info, /已请父对话验收/)
  // 交了就不再改：声明了没碰的 c.txt 让出来，改过的 b.txt 留到父对话验收（completeChild 才放）
  assert.deepEqual(
    x.claims.list('root').map((c) => `${c.path}:${c.taskId}`),
    ['b.txt:shared-kid'],
  )
  assert.match(x.woke[0].text, /共用目录/)
  const ok = await x.m.finishChild(parent, kid.id)
  assert.equal(ok.ok, true, ok.info)
  assert.match(ok.info, /已验收并标完成/)
  assert.deepEqual(x.integrated, [])
  assert.deepEqual(x.advanced, [kid.id])
  assert.equal(x.map.get(kid.id)!.wrapRequest, undefined)
})
