import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  addDock,
  dockSnapshot,
  dockVisible,
  registerDock,
  resetDock,
  subscribeDock,
  topDock,
  unregisterDock,
} from './chat-dock.ts'

// 浮条互斥：屏幕任意时刻最多只显示一个，谁该显示只看登记顺序

describe('chat-dock 登记顺序', () => {
  it('没有浮条时没有栈顶，谁都不该显示', () => {
    assert.equal(topDock([]), undefined)
    assert.equal(dockVisible('ai-fix', []), false)
  })

  it('只登记一个时它在栈顶', () => {
    const ids = registerDock('ai-fix', [])
    assert.deepEqual(ids, ['ai-fix'])
    assert.equal(topDock(ids), 'ai-fix')
    assert.equal(dockVisible('ai-fix', ids), true)
  })

  it('后登记的盖住先登记的：两个浮条同时存在也只显示一个', () => {
    const ids = registerDock('assist', registerDock('ai-fix', []))
    assert.deepEqual(ids, ['ai-fix', 'assist'])
    assert.equal(topDock(ids), 'assist')
    assert.equal(dockVisible('ai-fix', ids), false)
    assert.equal(ids.filter((id) => dockVisible(id, ids)).length, 1)
  })

  it('重复登记同一个 id 只提到栈顶，不留两条', () => {
    const ids = registerDock('ai-fix', registerDock('assist', registerDock('ai-fix', [])))
    assert.deepEqual(ids, ['assist', 'ai-fix'])
    assert.equal(topDock(ids), 'ai-fix')
  })

  it('同 id 的两个实例只显示一个：登记单位是实例号，不是业务 id', () => {
    // AssistDialog 在好几个页面各挂一份，id 都是 'assist'。按业务 id 判的话
    // dockVisible('assist', …) 对两个实例都是 true，互斥就被绕过了、两个浮条一起显示
    const instanceA = 'assist#1'
    const instanceB = 'assist#2'
    const keys = registerDock(instanceB, registerDock(instanceA, []))
    assert.deepEqual(keys, [instanceA, instanceB])
    assert.equal(dockVisible(instanceA, keys), false)
    assert.equal(dockVisible(instanceB, keys), true)
    assert.equal(keys.filter((k) => dockVisible(k, keys)).length, 1, '同 id 也只能显示一个')
  })
})

describe('chat-dock 注销', () => {
  it('注销栈顶后下一个自动露出来', () => {
    const ids = unregisterDock('assist', ['ai-fix', 'assist'])
    assert.deepEqual(ids, ['ai-fix'])
    assert.equal(dockVisible('ai-fix', ids), true)
  })

  it('注销不在栈里的 id 不影响顺序', () => {
    assert.deepEqual(unregisterDock('unknown', ['ai-fix', 'assist']), ['ai-fix', 'assist'])
  })

  it('全部注销后没有浮条显示', () => {
    const ids = unregisterDock('ai-fix', unregisterDock('assist', ['ai-fix', 'assist']))
    assert.deepEqual(ids, [])
    assert.equal(topDock(ids), undefined)
  })
})

describe('chat-dock 单例', () => {
  beforeEach(() => resetDock())

  it('挂载即登记，注销后栈里就没有它了并通知订阅者', () => {
    let notified = 0
    const stop = subscribeDock(() => (notified += 1))
    const off = addDock('mini-task')
    assert.deepEqual(dockSnapshot(), ['mini-task'])
    assert.equal(dockVisible('mini-task'), true)
    assert.equal(notified, 1)
    off()
    assert.deepEqual(dockSnapshot(), [])
    assert.equal(notified, 2)
    // 注销订阅后不再收到通知
    stop()
    addDock('ai-fix')()
    assert.equal(notified, 2)
  })

  it('StrictMode 下挂载、卸载、再挂载只留一条', () => {
    const offFirst = addDock('mini-task')
    offFirst()
    const offSecond = addDock('mini-task')
    assert.deepEqual(dockSnapshot(), ['mini-task'])
    offSecond()
    assert.deepEqual(dockSnapshot(), [])
  })

  it('快照引用在没变化时保持不变：useSyncExternalStore 靠这个判断要不要重渲染', () => {
    // 每次返回新数组（旧实现里的 slice()）会让 React 认为快照一直在变，
    // 渲染 → 读快照 → 又渲染，直接撞 Maximum update depth exceeded（React error #185）
    addDock('mini-task')
    const a = dockSnapshot()
    const b = dockSnapshot()
    assert.equal(a, b)
  })

  it('登记或注销后换成新数组：快照变了才通知界面重渲染', () => {
    const off = addDock('mini-task')
    const before = dockSnapshot()
    off()
    assert.notEqual(dockSnapshot(), before)
  })

  it('两个浮条依次挂载时只显示后挂的，先挂的关上后自动回来', () => {
    const offAi = addDock('ai-fix')
    const offMini = addDock('mini-task')
    assert.equal(dockVisible('ai-fix'), false)
    assert.equal(dockVisible('mini-task'), true)
    offMini()
    assert.equal(dockVisible('ai-fix'), true)
    offAi()
    assert.deepEqual(dockSnapshot(), [])
  })
})
