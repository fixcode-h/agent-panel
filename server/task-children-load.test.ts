/**
 * 打开一条有很多子对话的对话（用户报的场景：59 个子对话，`读取子对话` 卡 20 秒以上）：
 * `GET /tasks/:id/children` 不能等子对话独立分支的 git 查询——每个子对话要跑 3~4 条 git，
 * 几十个一起就是上百条，首屏消息和 SSE 首包会跟着一起卡住。
 * 所以第一次先回「还没核对过」的占位值，git 结果在后台补，下一次轮询（4 秒）就到位。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-children-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 子对话条数：每条要跑一次 git，条数是这个接口变慢的乘数 */
const CHILD_COUNT = 6
/**
 * git 单次耗时：真实环境 status 400~760ms。取 500ms 让「有没有等 git」的差距足够大，
 * 并行跑单测时 CPU 抖动也不会把断言抖成假的失败
 */
const GIT_MS = 500
/**
 * 第一次请求的耗时上限必须明显小于「等 git」的耗时，才能证明没在等。
 * 串行等的话 6 个子对话、并发上限 4 至少要两批（GIT_MS * 2），这里留 3 倍余量
 */
const FIRST_MS = 300

const empty = { list: async () => [], get: async () => null }
const projects = {
  list: async () => [],
  get: async (id: string) => (id === 'p1' ? { id: 'p1', name: '项目', path: dir } : null),
}

/** 每个测试一条新实例：缓存跟着实例走，免得前一个测试把状态留给后一个 */
let gitCalls = 0
const makeApp = () =>
  tasksApi({
    agents: empty,
    workflows: empty,
    projects,
    projectCategories: empty,
    // 真实现要几十个真 worktree 才能明显变慢；这里直接让一次 git 睡 300ms，等价于「git 很慢」
    worktreeStatus: async () => {
      gitCalls++
      await sleep(GIT_MS)
      return { exists: true, branch: true, ahead: 1, dirty: 2, merged: false }
    },
  } as never)

const store = createTaskStore()
await store.create({
  ...newTask({ projectId: 'p1', mode: 'workflow', prompt: '父对话' } as never, undefined, '', 'kids-parent'),
  id: 'kids-parent',
  status: 'done',
  title: '父对话',
})
for (let i = 0; i < CHILD_COUNT; i++) {
  const id = `kids-c${i}`
  await store.create({
    ...newTask(
      { projectId: 'p1', mode: 'workflow', prompt: `子对话 ${i}`, parentTaskId: 'kids-parent' } as never,
      undefined,
      '',
      id,
    ),
    id,
    status: 'stopped',
    stopReason: 'user',
    title: `子对话 ${i}`,
    worktree: {
      path: path.join(dir, `wt${i}`),
      branch: `agent-panel/${id}`,
      baseBranch: 'dev',
      state: 'active',
      note: '',
    },
  })
}

type ChildLine = { id: string; unmerged?: boolean; dirty?: number; worktreeChecked: boolean }

/** 先打一个不存在的对话，把任务列表读进内存：第一次请求的冷启动不能算进「等 git」的计时里 */
const warm = async (app: ReturnType<typeof makeApp>) => {
  const res = await app.routes.request('/no-such-task/children')
  assert.equal(res.status, 404)
}

const children = async (app: ReturnType<typeof makeApp>) => {
  const res = await app.routes.request('/kids-parent/children')
  assert.equal(res.status, 200)
  return (await res.json()) as ChildLine[]
}

/** 等后台把每个子对话都补完（下一次轮询的视角）：按「已核对」等，不按 git 起跑的条数等 */
const settle = async (app: ReturnType<typeof makeApp>) => {
  const end = Date.now() + 5_000
  for (let list = await children(app); list.some((c) => !c.worktreeChecked); list = await children(app)) {
    assert.ok(Date.now() < end, '等后台补完超时')
    await sleep(50)
  }
  return children(app)
}

test('子对话的独立分支状态不等 git：先回占位值，后台补完下一次轮询就有', async () => {
  const app = makeApp()
  await warm(app)
  const before = gitCalls

  const began = Date.now()
  const first = await children(app)
  const spent = Date.now() - began

  assert.equal(first.length, CHILD_COUNT)
  assert.ok(spent < FIRST_MS, `不能等 git（等了 ${spent}ms，一次 git 要 ${GIT_MS}ms）`)
  assert.ok(
    first.every((c) => c.worktreeChecked === false),
    '这次还没核对过，要如实告诉界面',
  )
  assert.ok(
    first.every((c) => c.unmerged === undefined && c.dirty === undefined),
    '没核对过时不给结论（不是「已合回 / 0 个文件」）',
  )
  assert.ok(gitCalls > before, '要顺手在后台补，下一次轮询才有值')

  const later = await settle(app)
  assert.ok(
    later.every((c) => c.worktreeChecked),
    '后台补完之后要标成已核对',
  )
  assert.ok(
    later.every((c) => c.unmerged && c.dirty === 2),
    '真实状态：没合回、2 个文件未提交',
  )
  assert.equal(gitCalls - before, CHILD_COUNT, '每个子对话只查一次：TTL 内不再重复查')
})

test('轮询再快也不会把 git 叠成上百条：同一个子对话同时只跑一条', async () => {
  const app = makeApp()
  await warm(app)
  const before = gitCalls

  const lists = await Promise.all([children(app), children(app), children(app)])
  for (const list of lists) {
    assert.equal(list.length, CHILD_COUNT)
    assert.ok(
      list.every((c) => !c.worktreeChecked),
      '后台还没补完时都算没核对过',
    )
  }
  assert.ok(gitCalls - before <= CHILD_COUNT, `${CHILD_COUNT} 个子对话不能叠出更多 git（实际 ${gitCalls - before} 条）`)

  const later = await settle(app)
  assert.ok(later.every((c) => c.worktreeChecked && c.unmerged && c.dirty === 2))
  assert.equal(gitCalls - before, CHILD_COUNT, '三个请求并发也只查了每个子对话一次')
})

test('git 读失败：卡片不给「干净」的结论，判定也不会把它当成已合回', async () => {
  const app = tasksApi({
    agents: empty,
    workflows: empty,
    projects,
    projectCategories: empty,
    // 仓库锁、worktree 被清掉一半这类失败：git 报错，拿不到状态
    worktreeStatus: async () => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git')
    },
  } as never)
  await warm(app)

  // 第一次：谁都没核对过，先回占位值
  const first = await children(app)
  assert.ok(
    first.every((c) => c.worktreeChecked === false),
    '读失败时不能说自己核对过',
  )
  assert.ok(
    first.every((c) => c.unmerged === undefined && c.dirty === undefined),
    '没拿到结果时不能给「已合回 / 0 个文件」这种结论',
  )

  // 等后台那几次都失败完：仍然只能是「不知道」，不能变成「干净」
  await sleep(300)
  const later = await children(app)
  assert.ok(
    later.every((c) => c.worktreeChecked === false),
    '失败不入缓存，下一次还是「没查到」',
  )
  assert.ok(
    later.every((c) => c.unmerged === undefined && c.dirty === undefined),
    '失败不能被当成「没有未提交文件」显示给用户',
  )
})
