/**
 * 标签页标题里的「(n)」不能跟着 task.working 一闪一闪：
 * task.working 在一轮结束到下一轮开始之间会短暂变 false（CLI 报 result、停在等下一句），
 * 直接用模拟时钟回放这种抖动序列，断言标题只在真的变化时改一次，而且任务真停了一定回落。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang, t } from '@shared/i18n'
import {
  countWorking,
  initialTitleState,
  nextTitleState,
  settleFor,
  TITLE_SETTLE_DOWN,
  TITLE_SETTLE_UP,
  titleFor,
  titleWait,
} from '@/lib/title-count'

setLang('zh')

const PLAIN = t('Agent 面板')
const at = (n: number) => `(${n}) ${PLAIN}`

/** 定时器到点后多久再算一次：hook 里由 setTimeout 决定，这里按 50ms 一步走 */
const TICK = 50

/**
 * 模拟 notify.ts 里的 useRunningTitle：push 相当于一次推送，run 相当于定时器到点后反复重算，
 * jump 相当于后台标签页的定时器被拖慢、切回页面时才重算一次。
 */
class TitleClock {
  private now = 0
  private state: ReturnType<typeof initialTitleState>
  private count: number
  /** 每次标题真的变了就记一条，用来断言没有来回切 */
  readonly titles: string[] = []

  constructor(count = 0) {
    this.count = count
    this.state = initialTitleState(count, 0)
    this.titles.push(titleFor(this.state.shown))
  }

  get shown() {
    return this.state.shown
  }

  push(count: number) {
    this.count = count
    this.apply()
  }

  run(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK) {
      this.now += TICK
      this.apply()
    }
  }

  jump(ms: number) {
    this.now += ms
    this.apply()
  }

  private apply() {
    const next = nextTitleState(this.state, this.count, this.now)
    if (next.shown !== this.state.shown) this.titles.push(titleFor(next.shown))
    this.state = next
  }
}

test('working 抖十几下，标题只在开头变成 (1) 一次，之后不再来回切', () => {
  const clock = new TitleClock(0)
  clock.push(1)
  // 新起的任务立刻显示，不用等
  assert.deepEqual(clock.titles, [PLAIN, at(1)])
  for (let i = 0; i < 12; i++) {
    // 报 result / 等下一句交替：每 300ms 抖一次
    clock.push(i % 2 === 0 ? 0 : 1)
    clock.run(300)
  }
  assert.equal(clock.shown, 1)
  assert.deepEqual(clock.titles, [PLAIN, at(1)])
})

test('任务真的停了，数字在 1~2 秒内消失，中间不闪', () => {
  const clock = new TitleClock(1)
  clock.push(0)
  clock.run(1000)
  assert.equal(clock.shown, 1, '还没稳够时间，不能把数字撤掉（否则就是闪烁）')
  clock.run(1000)
  assert.equal(clock.shown, 0)
  assert.deepEqual(clock.titles, [at(1), PLAIN])
})

test('多任务：加一个稳 400ms 才改，减一个等更久才改', () => {
  const clock = new TitleClock(1)
  clock.push(2)
  clock.run(200)
  assert.equal(clock.shown, 1)
  clock.run(300)
  assert.equal(clock.shown, 2)
  clock.push(1)
  clock.run(TITLE_SETTLE_UP + 100)
  assert.equal(clock.shown, 2, '减任务可能只是这一轮做完了，等得比加任务久')
  clock.run(TITLE_SETTLE_DOWN)
  assert.equal(clock.shown, 1)
  assert.deepEqual(clock.titles, [at(1), at(2), at(1)])
})

test('数量抖动期间不会去点定时器追一个没稳的值', () => {
  const state = nextTitleState(initialTitleState(1, 0), 2, 0)
  assert.equal(titleWait(state, 0), TITLE_SETTLE_UP)
  // 目标又变回 1：和已显示的一致，不用再等
  const back = nextTitleState(state, 1, 100)
  assert.equal(back.shown, 1)
  assert.equal(titleWait(back, 100), undefined)
})

test('切走再切回：后台定时器被拖慢，切回来按当前状态立刻重算', () => {
  const clock = new TitleClock(1)
  clock.push(0)
  assert.equal(clock.shown, 1)
  // 后台待了 5 分钟，定时器一直没跑
  clock.jump(5 * 60 * 1000)
  assert.equal(clock.shown, 0, '切回来不能停在旧数字上')
  assert.deepEqual(clock.titles, [at(1), PLAIN])
  // 后台期间新起了两个任务，切回来时账要一次对上
  clock.push(2)
  assert.equal(clock.shown, 2)
})

test('打开页面时已经有任务在跑，标题直接带数量', () => {
  assert.equal(initialTitleState(2, 1000).shown, 2)
  assert.equal(titleFor(2), at(2))
  assert.equal(titleFor(0), PLAIN)
  assert.equal(settleFor(0, 3), 0, '0 → n 不等，免得刚启动的任务迟迟不显示')
})

test('只算 CLI 真的在处理的任务：预热、等下一句都不算', () => {
  assert.equal(countWorking([{ working: true }, { working: false }, { working: true }]), 2)
  assert.equal(countWorking([]), 0)
})
