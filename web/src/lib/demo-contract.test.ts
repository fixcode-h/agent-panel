/**
 * 演示后端和正式后端的接口契约（A9）：最常用的四个接口（任务列表、任务详情、子对话、发消息）
 * 用 shared/task-api-contract.ts 的同一份 schema 校验；正式后端那一侧见 server/task-api-contract.test.ts。
 * 演示版少了字段时，界面在演示和界面检查里走的分支就和真机不一样，以前只能靠截图碰巧看出来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  ChildListContract,
  SendMessageContract,
  TaskListContract,
  TaskPageContract,
} from '../../../shared/task-api-contract.ts'

// 演示后端存在 localStorage 里：node 里没有，换成内存的一份；模拟等待按 100 倍缩短（见 demo-speed.ts）
const store = new Map<string, string>([['agent-panel-demo-speed', '100']])
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
})
// 演示后端用了 import.meta.glob（自带技能的文件），只有经 Vite 转换才能加载：按演示构建的别名和 define 起一个不监听端口的 Vite
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const vite = await createServer({
  configFile: false,
  root: r('../..'),
  logLevel: 'error',
  appType: 'custom',
  resolve: { alias: { '@': r('..'), '@shared': r('../../../shared') } },
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})
const { handle } = (await vite.ssrLoadModule('/src/lib/demo-backend.ts')) as typeof import('./demo-backend.ts')
test.after(() => vite.close())

const check = (
  schema: { safeParse: (x: unknown) => { success: boolean; error?: unknown } },
  x: unknown,
  what: string,
) => {
  const r = schema.safeParse(x)
  assert.ok(r.success, `${what}的返回形状和正式后端对不上：${JSON.stringify(r.error, null, 1)?.slice(0, 1500)}`)
}

/** 页面点发送时自己生成的消息 id（接口要求是 UUID） */
const MSG_ID = '00000000-0000-4000-8000-00000000c0de'

test('演示后端的任务列表、详情、子对话、发消息：返回形状和正式后端同一份契约', async () => {
  const projects = (await handle('GET', '/projects', undefined)) as { id: string }[]
  const lists = await Promise.all(projects.map((p) => handle('GET', `/tasks?projectId=${p.id}`, undefined)))
  for (const list of lists) check(TaskListContract, list, '任务列表')
  const tasks = lists.flat() as { id: string }[]
  assert.ok(tasks.length > 0, '演示数据里要有对话')

  // 找一个有子对话的父对话：详情、子对话都拿它测
  let parent = ''
  let kids: unknown[] = []
  for (const t of tasks) {
    kids = (await handle('GET', `/tasks/${t.id}/children`, undefined)) as unknown[]
    if (kids.length) {
      parent = t.id
      break
    }
  }
  assert.ok(parent, '演示数据里要有带子对话的父对话')
  check(ChildListContract, kids, '子对话列表')
  check(TaskPageContract, await handle('GET', `/tasks/${parent}?limit=40`, undefined), '任务详情')

  const sent = (await handle('POST', `/tasks/${parent}/messages`, {
    text: '契约测试的消息',
    messageId: MSG_ID,
  })) as { messages: { id: string }[] }
  check(SendMessageContract, sent, '发消息')
  assert.ok(
    sent.messages.some((m) => m.id === MSG_ID),
    '发出的消息按页面给的 id 记进对话',
  )
})
