/**
 * 打开对话页时的两个热接口：`POST /seen` 只回「这一轮看到哪」、`POST /presence` 只判在不在。
 * 它们以前都走 `current()`（读 + 校验整份对话，实测 2MB / 611 条要 91–133ms），`/seen` 还把完整任务
 * 2.4MB 原样回给前端，而前端只拿它换一个 turnSeenAt。这里钉住两件事：返回结构，以及不碰对话文件。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-seen-'))
process.env.AGENT_PANEL_DATA = dir
// `/seen` 会把没人看的对话排进回收计时（生产里是 30–60 分钟）：测试里设短，用例结束就清掉，不让进程挂着
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '500'
process.env.AGENT_PANEL_PRESENCE_UNREAD_GRACE_MS = '500'

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')
const { TaskMessage } = await import('../shared/schema.ts')
const { forgetPresence } = await import('./presence.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const at = '2026-10-01T02:00:00.000Z'
const msgFile = (id: string) => path.join(dir, 'tasks', 'chats', `${id}.messages.json`)
/** 用过就清掉回收计时：不然测试文件要等它到点才能退出 */
test.afterEach(() => {
  for (const id of ['seen-only', 'seen-keeps-messages', 'seen-twice', 'presence-lite']) forgetPresence(id)
})

const msg = (id: string, role: 'user' | 'agent', text: string) =>
  TaskMessage.parse({ id, role, agentId: '', step: '', text, tools: [], at })

/** 一个已经完成一轮、还没看过的对话（消息文件里带上 Agent 的回复，被覆盖时能看出来） */
const make = async (id: string, over: Record<string, unknown> = {}) =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: '看看这个对话' } as never, undefined, '', id),
    id,
    turnDoneAt: at,
    turnSeenAt: '',
    messages: [msg(`${id}-u1`, 'user', '看看这个对话'), msg(`${id}-a1`, 'agent', '看完了，结论在上面')],
    ...over,
  })

test('/seen 只回「这一轮看到哪」，不把整份对话传回来', async () => {
  await make('seen-only')
  const t = api()
  const res = await t.routes.request('/seen-only/seen', { method: 'POST', body: '{}' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { turnSeenAt: at }, '返回里只有这一个字段')
})

test('/seen 只改任务本身：对话文件一个字节都没被重写', async () => {
  const before = await make('seen-keeps-messages')
  const file = msgFile('seen-keeps-messages')
  const bytes = readFileSync(file)
  const mtime = statSync(file).mtimeMs
  const updatedAt = before.updatedAt

  const res = await api().routes.request('/seen-keeps-messages/seen', { method: 'POST', body: '{}' })
  assert.equal(res.status, 200)

  // 落盘：看过的时间写上，列表顺序（updatedAt）不动
  const saved = (await createTaskStore().getMeta('seen-keeps-messages'))!
  assert.equal(saved.turnSeenAt, at)
  assert.equal(saved.updatedAt, updatedAt, '只是记「看过了」，不算任务有更新')
  // 不能靠 store.update 传一份不完整的 messages 进去：那样会把完整对话覆盖成任务文件里那几条用户消息
  assert.equal(readFileSync(file).equals(bytes), true, '对话文件内容没变')
  assert.equal(statSync(file).mtimeMs, mtime, '对话文件没有被重写')
})

test('/seen 已经看过：不改任何东西，仍然只回 turnSeenAt', async () => {
  await make('seen-twice', { turnSeenAt: at })
  const t = api()
  const res = await t.routes.request('/seen-twice/seen', { method: 'POST', body: '{}' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { turnSeenAt: at })
})

test('/presence 只判在不在：不改对话文件，任务不存在时 404', async () => {
  await make('presence-lite')
  const file = msgFile('presence-lite')
  const mtime = statSync(file).mtimeMs
  const t = api()
  const ok = await t.routes.request('/presence-lite/presence', {
    method: 'POST',
    body: JSON.stringify({ viewerId: 'tab-a', active: true }),
  })
  assert.equal(ok.status, 204)
  assert.equal(statSync(file).mtimeMs, mtime, '心跳不碰对话文件')

  const missing = await t.routes.request('/no-such-task/presence', {
    method: 'POST',
    body: JSON.stringify({ viewerId: 'tab-a', active: true }),
  })
  assert.equal(missing.status, 404)
})

test('updateMeta：内存里读过的完整对话跟着更新，不会把旧值再写回去', async () => {
  await make('meta-full-cache')
  const read = createTaskStore()
  // 先读一次完整对话，把它放进 full 缓存
  const full = (await read.get('meta-full-cache'))!
  assert.equal(full.messages.length, 2)
  await read.updateMeta('meta-full-cache', { turnSeenAt: at }, { keepUpdatedAt: true })
  const again = (await read.get('meta-full-cache'))!
  assert.equal(again.turnSeenAt, at, '缓存里那份也跟着改了')
  assert.equal(again.messages.length, 2, '对话没有被任务文件里那几条用户消息顶掉')
  // 再开一个 store 从磁盘读：meta 只写任务文件，对话仍然从 `.messages.json` 里补齐
  const fresh = (await createTaskStore().get('meta-full-cache'))!
  assert.equal(fresh.turnSeenAt, at)
  assert.equal(fresh.messages.length, 2, '落盘后的对话还是完整的两条')
})
