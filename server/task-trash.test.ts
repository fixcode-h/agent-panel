/**
 * 对话回收站：删除只做标记（Task.deletedAt），列表和回收站分开列；保留期内能完整恢复，
 * 过期后由启动后的清理任务物理删除；删父对话时子对话一起进去、一起回来。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-trash-'))
process.env.AGENT_PANEL_DATA = dir
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '500'

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask, TRASH_RETENTION_DAYS } = await import('../shared/task.ts')
const { TaskMessage } = await import('../shared/schema.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const DAY_MS = 24 * 60 * 60 * 1000
const at = '2026-10-01T02:00:00.000Z'

const msg = (id: string, role: 'user' | 'agent', text: string) =>
  TaskMessage.parse({ id, role, agentId: '', step: '', text, tools: [], at })

/** 一条有内容的对话：删除、恢复之后还能把消息读出来 */
const make = async (id: string, over: Record<string, unknown> = {}) =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: '看看这个对话' } as never, undefined, '', id),
    id,
    // 已经跑完的对话：别让启动时的迁移给它补一条「面板重启时已中断」
    status: 'done',
    messages: [msg(`${id}-u1`, 'user', '看看这个对话'), msg(`${id}-a1`, 'agent', '看完了，结论在上面')],
    ...over,
  })

const listIds = async (t: ReturnType<typeof api>, parentId = '') =>
  ((await (await t.routes.request(parentId ? `/?parentId=${parentId}` : '/')).json()) as { id: string }[]).map(
    (x) => x.id,
  )
const trashRows = async (t: ReturnType<typeof api>) =>
  (await (await t.routes.request('/trash')).json()) as {
    id: string
    leftDays: number
    children: number
    worktree: string
  }[]

test('删除只进回收站：列表里消失，回收站里能查到还剩几天', async () => {
  await make('trash-a')
  const t = api()
  assert.ok((await listIds(t)).includes('trash-a'), '删之前列表里有')

  assert.equal((await t.routes.request('/trash-a', { method: 'DELETE' })).status, 204)
  assert.ok(!(await listIds(t)).includes('trash-a'), '删之后列表里没有')
  const rows = await trashRows(t)
  const row = rows.find((x) => x.id === 'trash-a')
  assert.ok(row, '回收站里能查到')
  assert.equal(row.leftDays, TRASH_RETENTION_DAYS, '刚删的还有 7 天')
})

test('恢复后回到列表，对话内容一条不少', async () => {
  await make('trash-b')
  const t = api()
  await t.routes.request('/trash-b', { method: 'DELETE' })
  const res = await t.routes.request('/trash-b/restore', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { worktreeCleared: false }, '分支目录还在时不用提示')
  assert.ok((await listIds(t)).includes('trash-b'), '恢复后列表里又有它')
  assert.ok(!(await trashRows(t)).some((x) => x.id === 'trash-b'), '回收站里没有了')
  const full = await t.get('trash-b')
  assert.equal(full?.messages.length, 2, '消息文件没被动过')
  assert.equal(full?.deletedAt, undefined, '删除标记真的清掉了，不是留着等下一次过滤')
})

test('删父对话时子对话一起进回收站：只列父对话，恢复时一起回来', async () => {
  await make('trash-parent')
  await make('trash-kid', { parentTaskId: 'trash-parent' })
  const t = api()
  await t.routes.request('/trash-parent', { method: 'DELETE' })

  const ids = await listIds(t)
  assert.ok(!ids.includes('trash-parent'), '父对话不在列表里')
  assert.ok(!(await listIds(t, 'trash-parent')).includes('trash-kid'), '子对话跟着进回收站，也不在子对话栏里')
  const rows = await trashRows(t)
  assert.ok(!rows.some((x) => x.id === 'trash-kid'), '子对话不单独占一行')
  assert.equal(rows.find((x) => x.id === 'trash-parent')?.children, 1)

  await t.routes.request('/trash-parent/restore', { method: 'POST' })
  assert.ok((await listIds(t)).includes('trash-parent'), '父对话回到列表')
  assert.ok((await listIds(t, 'trash-parent')).includes('trash-kid'), '恢复时子对话一起回来')
})

test('过期清理：超过 7 天的已删除对话被物理删除，没过期的留着', async () => {
  await make('trash-expired')
  await make('trash-fresh')
  const t = api()
  await t.routes.request('/trash-expired', { method: 'DELETE' })
  await t.routes.request('/trash-fresh', { method: 'DELETE' })
  // 造一条 7 天前删的（保留期刚好走完）
  await store.updateMeta('trash-expired', {
    deletedAt: new Date(Date.now() - TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
  })

  // 新建一个从磁盘重新读的实例：上面那一行是测试自己的 store 写的盘
  const fresh = api()
  assert.equal(await fresh.cleanupTrash(), 1, '只删到期的那条')
  assert.equal(await fresh.get('trash-expired'), null, '任务记录已经没了')
  const rows = await trashRows(fresh)
  assert.ok(
    rows.some((x) => x.id === 'trash-fresh'),
    '没到期的还在回收站里',
  )
  assert.ok(!rows.some((x) => x.id === 'trash-expired'), '到期的那条从回收站里消失')
})

test('永久删除不经过回收站，直接清掉任务记录', async () => {
  await make('trash-perm')
  const t = api()
  await t.routes.request('/trash-perm', { method: 'DELETE' })
  const res = await t.routes.request('/trash-perm/permanent', { method: 'DELETE' })
  assert.equal(res.status, 204)
  assert.equal(await t.get('trash-perm'), null)
  assert.ok(!(await trashRows(t)).some((x) => x.id === 'trash-perm'), '回收站里也没了')
})

test('永久删除才会清掉聊天的工作目录，进回收站时留着（7 天内能恢复）', async () => {
  await make('trash-chat-dir')
  // 聊天的工作目录在数据目录的 chats/<id>（见 server/store.ts 的 CHATS_DIR），执行时会建出来
  const chatDir = path.join(dir, 'chats', 'trash-chat-dir')
  mkdirSync(chatDir, { recursive: true })
  const t = api()
  await t.routes.request('/trash-chat-dir', { method: 'DELETE' })
  assert.ok(existsSync(chatDir), '进回收站时工作目录还留着')
  await t.routes.request('/trash-chat-dir/permanent', { method: 'DELETE' })
  assert.ok(!existsSync(chatDir), '永久删除时工作目录一起删掉')
})

test('进了回收站的对话读不到：旧链接和 AI 窗口的轮询都靠它判「已关闭」', async () => {
  await make('trash-unreadable')
  const t = api()
  assert.equal((await t.routes.request('/trash-unreadable')).status, 200, '删之前读得到')
  await t.routes.request('/trash-unreadable', { method: 'DELETE' })
  assert.equal((await t.routes.request('/trash-unreadable')).status, 404, '删之后当不存在')
  await t.routes.request('/trash-unreadable/restore', { method: 'POST' })
  assert.equal((await t.routes.request('/trash-unreadable')).status, 200, '恢复后又能读到')
})

test('恢复时分支目录已经不在：如实回报，worktree 置空（按共用目录继续）', async () => {
  await make('trash-gone-branch', {
    worktree: {
      path: path.join(dir, 'worktrees', 'not-there'),
      branch: 'agent-panel/gone',
      baseBranch: 'dev',
      state: 'active',
      note: '',
    },
  })
  const t = api()
  await t.routes.request('/trash-gone-branch', { method: 'DELETE' })
  const res = await t.routes.request('/trash-gone-branch/restore', { method: 'POST' })
  assert.deepEqual(await res.json(), { worktreeCleared: true }, '界面靠这个字段提示用户要重新执行')
  const full = await t.get('trash-gone-branch')
  assert.equal(full?.worktree, null, '不能留一个指向不存在目录的分支（置空后按共用目录继续）')
  assert.equal(full?.stopReason, 'delete', '恢复后的对话写「删除时结束」，不是「归档时结束」或「已暂停」')
})
