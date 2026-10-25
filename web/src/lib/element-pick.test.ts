/** 抓取期间的鼠标按键分派、抓到的引用投给谁（输入框还是剪贴板） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliverPick, pointerIntent, targetsComposer, targetsPickedInput, type PickTargets } from '@/lib/element-pick'

/** PointerEvent.buttons 里的位：左 1、右 2、中 4（按 MouseEvent.button 的编号排） */
const BUTTON_BITS = [1, 4, 2]

/** 一次指针按下 / 松开：button 是要按的那个键，others 是同时按着的其他键 */
const down = (button: number, others = 0) => ({ button, buttons: BUTTON_BITS[button] | others })
const up = (button: number) => ({ button, buttons: 0 })

test('pointerIntent：抓取键按下是抓取，松开也要拦住', () => {
  assert.equal(pointerIntent('middle', 'down', down(1)), 'pick')
  assert.equal(pointerIntent('middle', 'up', up(1)), 'swallow')
  assert.equal(pointerIntent('left', 'down', down(0)), 'pick')
  assert.equal(pointerIntent('left', 'up', up(0)), 'swallow')
  assert.equal(pointerIntent('right', 'down', down(2)), 'pick')
  assert.equal(pointerIntent('right', 'up', up(2)), 'swallow')
})

test('pointerIntent：抓取键之外的键一律放行——抓取期间左键还能点、右键还能弹菜单', () => {
  assert.equal(pointerIntent('middle', 'down', down(0)), 'pass')
  assert.equal(pointerIntent('middle', 'up', up(0)), 'pass')
  assert.equal(pointerIntent('middle', 'down', down(2)), 'pass')
  assert.equal(pointerIntent('middle', 'up', up(2)), 'pass')
  assert.equal(pointerIntent('left', 'down', down(1)), 'pass')
  assert.equal(pointerIntent('left', 'up', up(1)), 'pass')
  assert.equal(pointerIntent('right', 'down', down(0)), 'pass')
  assert.equal(pointerIntent('right', 'up', up(0)), 'pass')
})

test('pointerIntent：两个键同时按着时抓取键不算数，拖拽、刷选中途不会把整页抓走', () => {
  // 左键按着拖动时顺手中键
  assert.equal(pointerIntent('middle', 'down', down(1, 1)), 'pass')
  // 中键按着时顺便按左键
  assert.equal(pointerIntent('middle', 'down', down(0, 4)), 'pass')
  assert.equal(pointerIntent('right', 'down', down(2, 1)), 'pass')
})

test('targetsComposer：只有一个输入框时直接投，多个时要焦点刚在里面才投', () => {
  // 页面上就一个输入框：不管焦点在哪，那里就是唯一的去处
  assert.equal(targetsComposer({ count: 1, focused: false, recent: false }), true)
  // 多个（父对话 + 右栏子对话）：焦点在里面、或者刚在里面待过才投
  assert.equal(targetsComposer({ count: 2, focused: true, recent: false }), true)
  assert.equal(targetsComposer({ count: 2, focused: false, recent: true }), true)
  // 焦点在页面空白处、从来没碰过输入框：不猜，交给剪贴板（需求：找不到就放剪贴板）
  assert.equal(targetsComposer({ count: 2, focused: false, recent: false }), false)
  // 没有任何输入框（首页、项目页、记忆库页）：走剪贴板
  assert.equal(targetsComposer({ count: 0, focused: false, recent: false }), false)
})

test('targetsPickedInput：从哪个输入框的按钮进来就投给哪个，不看焦点', () => {
  // 两个输入框都在（父对话 + 右栏子对话），点的是父对话那个按钮：焦点在子对话里也投父对话
  assert.equal(targetsPickedInput({ pinned: true, pinnedAlive: true, count: 2, focused: false, recent: true }), true)
  assert.equal(targetsPickedInput({ pinned: true, pinnedAlive: true, count: 2, focused: false, recent: false }), true)
  // 目标输入框在抓取期间没了（换了页面、对话被关）：退回剪贴板，不改成猜别的输入框
  assert.equal(targetsPickedInput({ pinned: true, pinnedAlive: false, count: 1, focused: true, recent: true }), false)
  assert.equal(targetsPickedInput({ pinned: true, pinnedAlive: false, count: 0, focused: false, recent: false }), false)
})

test('targetsPickedInput：快捷键进来的没有目标，仍按焦点 / 最近聚焦判', () => {
  assert.equal(targetsPickedInput({ pinned: false, pinnedAlive: false, count: 1, focused: false, recent: false }), true)
  assert.equal(targetsPickedInput({ pinned: false, pinnedAlive: false, count: 2, focused: true, recent: false }), true)
  assert.equal(
    targetsPickedInput({ pinned: false, pinnedAlive: false, count: 2, focused: false, recent: false }),
    false,
  )
  assert.equal(
    targetsPickedInput({ pinned: false, pinnedAlive: false, count: 0, focused: false, recent: false }),
    false,
  )
})

test('deliverPick：优先投给开启抓取时的那个输入框', async () => {
  const got: string[] = []
  const targets: PickTargets = {
    composer: (text) => {
      got.push(text)
      return true
    },
    clipboard: () => Promise.reject(new Error('不该走剪贴板')),
  }
  assert.equal(await deliverPick('引用', targets), 'composer')
  assert.deepEqual(got, ['引用'])
})

test('deliverPick：没有输入框、输入框不收、输入框那边报错都退回剪贴板', async () => {
  const texts: string[] = []
  const clipboard = (text: string) => {
    texts.push(text)
    return Promise.resolve()
  }
  assert.equal(await deliverPick('a', { composer: undefined, clipboard }), 'clipboard')
  assert.equal(await deliverPick('b', { composer: () => false, clipboard }), 'clipboard')
  assert.equal(
    await deliverPick('c', {
      composer: () => {
        throw new Error('编辑器还没挂上')
      },
      clipboard,
    }),
    'clipboard',
  )
  assert.deepEqual(texts, ['a', 'b', 'c'])
})

test('deliverPick：剪贴板写失败时抛出，交给调用方提示用户手动复制', async () => {
  await assert.rejects(
    deliverPick('引用', { composer: undefined, clipboard: () => Promise.reject(new Error('没有权限')) }),
    /没有权限/,
  )
})
