import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  closeMiniTask,
  dockStateOf,
  minimizeBackRoute,
  miniTaskState,
  minimizeTask,
  resetMiniTask,
  shownInPage,
  taskRoute,
} from './mini-task.ts'

// 「转成弹窗」只记一个对话：再最小化另一个就把它换掉，屏幕上不会同时有两个对话浮条

describe('mini-task 只有一个', () => {
  beforeEach(() => resetMiniTask())

  it('开始没有收起来的对话', () => {
    assert.equal(miniTaskState().task, undefined)
  })

  it('收起一个对话后记下它', () => {
    minimizeTask({ id: 'a', projectId: 'p1' })
    assert.deepEqual(miniTaskState().task, { id: 'a', projectId: 'p1' })
  })

  it('再收起另一个对话：只剩后一个（同时最多一个对话浮条）', () => {
    minimizeTask({ id: 'a', projectId: 'p1' })
    minimizeTask({ id: 'b', projectId: 'p1' })
    assert.deepEqual(miniTaskState().task, { id: 'b', projectId: 'p1' })
  })

  it('Chat 里的对话不带项目，照样替换掉项目里的那个', () => {
    minimizeTask({ id: 'a', projectId: 'p1' })
    minimizeTask({ id: 'chat-1' })
    assert.deepEqual(miniTaskState().task, { id: 'chat-1' })
  })

  it('关掉浮条只是不显示，对话本身不在这一份状态里', () => {
    minimizeTask({ id: 'a', projectId: 'p1' })
    closeMiniTask()
    assert.equal(miniTaskState().task, undefined)
  })
})

describe('mini-task 路由', () => {
  it('项目里的对话展开回项目里那个对话', () => {
    assert.deepEqual(taskRoute({ id: 'a', projectId: 'p1' }), { page: 'projects', id: 'p1', sub: 'a' })
  })

  it('Chat 里的对话展开回聊天', () => {
    assert.deepEqual(taskRoute({ id: 'chat-1' }), { page: 'chat', id: 'chat-1' })
  })

  it('收起后停在列表页：项目里的回项目首页', () => {
    assert.deepEqual(minimizeBackRoute({ projectId: 'p1' }), { page: 'projects', id: 'p1' })
  })

  it('收起后 Chat 里的回新聊天页，不是那个对话', () => {
    assert.deepEqual(minimizeBackRoute({}), { page: 'chat' })
  })
})

// 浮条状态：等你处理 / 失败 不能并进「已结束」，否则用户以为跑完了
// 只造 taskFacts / taskState 读到的字段（status / steps / working / requests / stopReason…），
// 完整 Task 有几十个字段、与判定无关。注意：以后 taskFacts 新增字段时这里不会报错，只会静默算错，
// 加字段时记得同步这个工厂（真实数据走 useData().tasks 的完整摘要，不受影响）
const task = (extra: Record<string, unknown> = {}) =>
  ({ status: 'done', steps: [], working: false, ...extra }) as unknown as Parameters<typeof dockStateOf>[0]

describe('mini-task 浮条状态', () => {
  it('对话不在列表里时是「对话已关闭」', () => {
    assert.equal(dockStateOf(undefined), 'gone')
  })

  it('跑完的对话是「已完成」', () => {
    assert.equal(dockStateOf(task()), 'done')
  })

  it('正在执行的对话是「进行中」', () => {
    assert.equal(dockStateOf(task({ status: 'running', working: true })), 'running')
  })

  it('在等用户回答的对话是「等你处理」，不是「已结束」', () => {
    assert.equal(dockStateOf(task({ status: 'running', requests: [{ step: '1', at: '' }] })), 'needs')
  })

  it('在跑但同时等你回答：优先显示「等你处理」，不是「进行中」', () => {
    // convState 里 needs 优先于 working；先判 taskBusy 会把它吞成进行中
    assert.equal(dockStateOf(task({ status: 'running', working: true, requests: [{ step: '1', at: '' }] })), 'needs')
  })

  it('执行失败的对话是「失败」，不是「已结束」', () => {
    assert.equal(dockStateOf(task({ status: 'failed' })), 'failed')
  })

  it('停下了的对话是「已结束」', () => {
    assert.equal(dockStateOf(task({ status: 'stopped', stopReason: 'idle' })), 'ended')
  })
})

describe('mini-task 是否已展开在页面上', () => {
  const mini = { id: 't1', projectId: 'p1' }

  it('项目页正显示这个对话：不再是浮条', () => {
    assert.equal(shownInPage(mini, { page: 'projects', id: 'p1', sub: 't1' }), true)
  })

  it('项目页开着别的对话：还是浮条', () => {
    assert.equal(shownInPage(mini, { page: 'projects', id: 'p1', sub: 't2' }), false)
    assert.equal(shownInPage(mini, { page: 'projects', id: 'p1' }), false)
  })

  it('Chat 页正显示这个对话：不再是浮条', () => {
    assert.equal(shownInPage({ id: 'c1' }, { page: 'chat', id: 'c1' }), true)
    assert.equal(shownInPage({ id: 'c1' }, { page: 'chat' }), false)
  })

  it('别的页面（项目首页、设置）不算展开', () => {
    assert.equal(shownInPage(mini, { page: 'projects', id: 'p1' }), false)
    assert.equal(shownInPage(mini, { page: 'home' }), false)
  })
})
