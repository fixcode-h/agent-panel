/**
 * 结束对话的 CLI（endLive）：取消等下一句后 CLI 不退出时限时强制停掉，收尾不能一直卡着。
 * 以前子对话收尾在这里无限等，执行位一直占着，父对话再交代任务时卡在「收尾那一刻」。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { StopReason, Task } from '../../shared/schema.ts'
import type { TasksScope } from './scope.ts'
import type { Live } from './types.ts'

// 进程登记在 DATA_DIR 下（放弃执行时会按登记杀进程）：import 之前指到临时目录，不碰本机的数据目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'keepalive-data-'))
const { createKeepAlive, STOP_WATCH_MS } = await import('./keepalive.ts')

/** stopAt：第几次停止时进程才结束（1 = 一停就退；2 = 第一次停不下来，要限时后再停一次） */
function rig(stopAt: number) {
  let release: () => void = () => {}
  let stops = 0
  let abandon: () => void = () => {}
  const abandoned = new Promise<void>((r) => (abandon = r))
  const run = new Promise<void>((r) => (release = r))
  const entry = {
    task: {
      id: 'kid',
      status: 'running',
      working: true,
      updatedAt: new Date().toISOString(),
      messages: [],
      steps: [],
      turns: [],
      runs: [],
    } as unknown as Task,
    rev: 0,
    abort: { abort: () => ++stops === stopAt && release() },
    // 和 run.ts 一样：面板放弃这份执行时 done 跟着结束
    done: Promise.race([run, abandoned]),
    abandon,
    abandoned,
  } as unknown as Live
  const saved: Task[] = []
  const live = new Map([['kid', entry]])
  const s = {
    live,
    closeChildren: async () => {},
    release: (e: Live) => live.get(e.task.id) === e && live.delete(e.task.id),
    store: { update: async (_id: string, tk: Task) => void saved.push(structuredClone(tk)) },
    reportToParent: async () => {},
    followUp: async () => {},
    alertOn: () => () => {},
    shuttingDown: false,
  } as unknown as TasksScope
  return { ...createKeepAlive(s), entry, release, stops: () => stops, live, saved }
}

test('取消等待后 CLI 不退出：限时到了按收尾原因强制停掉，不一直等', async () => {
  const r = rig(2)
  const t0 = Date.now()
  // 限时的定时器 unref 了：留一个定时器撑住事件循环
  const hold = setTimeout(() => {}, 5000)
  await r.endLive('kid', r.entry, 'finish', 30)
  clearTimeout(hold)
  assert.ok(Date.now() - t0 < 2000)
  // 第一次停没停下来：到点又停了一次
  assert.equal(r.stops(), 2)
  assert.equal(r.entry.stopReason, 'finish' satisfies StopReason)
})

test('用户已经停下的子对话再被父对话连带停：停止原因还是用户，不改成 parent（实测报告问题 3）', () => {
  const r = rig(99)
  r.stopTask('kid', 'user')
  r.stopTask('kid', 'parent')
  assert.equal(r.entry.stopReason, 'user' satisfies StopReason)
  // 不是连带停的照旧以后来的为准（卡住重开后换人接手）
  const s = rig(99)
  s.stopTask('kid', 'stalled')
  s.stopTask('kid', 'replaced')
  assert.equal(s.entry.stopReason, 'replaced' satisfies StopReason)
})

test('限时内收完就返回，不等满时限', async () => {
  const r = rig(99)
  setTimeout(() => r.release(), 5)
  const t0 = Date.now()
  await r.endLive('kid', r.entry, 'finish', 5000)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(r.stops(), 1)
})

test('强制停止后执行仍收不完：直接收口、让出执行位，父对话再交代任务时能开新的一轮', async () => {
  const r = rig(99)
  // 第一次停下（没有等下一句的 CLI 可取消）也不结束：模拟这一份执行的收尾卡在别处
  const hold = setTimeout(() => {}, 5000)
  const t0 = Date.now()
  await r.endLive('kid', r.entry, 'finish', 30)
  clearTimeout(hold)
  assert.ok(Date.now() - t0 < 2000)
  assert.ok(r.stops() >= 2)
  // 以前只是「不再等它」，执行位一直占着：父对话再交给它的任务被交进这份没有进程的执行里，子对话一直「等待模型」
  assert.equal(r.live.has('kid'), false, '执行位让出来了')
  assert.equal(r.entry.orphaned, true, '标成已放弃，引擎之后收完也不再写盘')
  // done 跟着结束：等它的人（wakeConv、closeChildren）不会一直挂着
  await r.entry.done
  // 收尾停的：这一轮已经答完，按正常结束落盘，不显示成执行中
  const last = r.saved.at(-1)!
  assert.equal(last.status, 'done')
  assert.equal(last.working, false)
})

test('用户停止后进程已经没了：不等引擎收尾，几秒内直接按已停止收口', async () => {
  const r = rig(99)
  const hold = setTimeout(() => {}, 10_000)
  r.stopTask('kid', 'user')
  // 名下没有活着的 CLI 进程（测试里本来就没有）：连着几次看不到就收口
  await Promise.race([r.entry.done, new Promise((res) => setTimeout(res, STOP_WATCH_MS * 6))])
  clearTimeout(hold)
  assert.equal(r.live.has('kid'), false, '执行位让出来了，停止按钮点一次就够')
  const last = r.saved.at(-1)!
  assert.equal(last.status, 'stopped')
  assert.equal(last.stopReason, 'user' satisfies StopReason)
  assert.equal(last.working, false)
})

test('用户停止后引擎自己很快收完：不重复收口', async () => {
  const r = rig(1)
  r.stopTask('kid', 'user')
  await r.entry.done
  r.live.delete('kid')
  await new Promise((res) => setTimeout(res, STOP_WATCH_MS * 4))
  assert.equal(r.entry.orphaned, undefined, '引擎正常收完的不当成放弃')
  assert.equal(r.saved.length, 0)
})

test('子对话完成后保留：默认 5 分钟；CLI 没停在等下一句上时不留，由收尾马上结束', async () => {
  const { Settings } = await import('../../shared/schema.ts')
  assert.equal(Settings.parse({}).childDoneKeepMinutes, 5)
  // 坏值退回默认，不让整份设置读不出来
  assert.equal(Settings.parse({ childDoneKeepMinutes: -1 }).childDoneKeepMinutes, 5)
  const r = rig(1)
  // 测试里没有等下一句的 CLI（进程早退了）：没有可留的，交回 false 让 completeChild 照常结束
  assert.equal(await r.keepDoneChild('kid', r.entry), false)
  assert.equal(r.keepingDone('kid'), false)
})

test('停止后马上点「继续」：先等正在停下的那一份收完，不当成「任务正在执行」拒掉；没在停的不等', async () => {
  const { settleBefore } = await import('./helpers.ts')
  const hold = setTimeout(() => {}, 10_000)
  // 正在执行、没人停它：不等（继续执行照旧按「正在执行」拒）
  const busy = rig(99)
  const t0 = Date.now()
  await settleBefore(busy.entry)
  assert.ok(Date.now() - t0 < 200)
  assert.equal(busy.live.has('kid'), true)
  // 刚点了停止、进程已经没了、引擎还没收完：等到收口、执行位让出来再往下走
  const r = rig(99)
  r.stopTask('kid', 'user')
  await settleBefore(r.entry)
  clearTimeout(hold)
  assert.equal(r.live.has('kid'), false, '等完执行位已经空了，继续执行能直接占到')
  assert.equal(r.saved.at(-1)?.status, 'stopped')
})

test('停父对话：在等子任务的子对话按「随父对话停」收口（继续时会被拉起），停在等下一句的照常结束不标停止', async () => {
  const hold = setTimeout(() => {}, 10_000)
  const mk = (id: string, awaitingUser: boolean) => {
    let abandon: () => void = () => {}
    const abandoned = new Promise<void>((r) => (abandon = r))
    let stops = 0
    const e = {
      task: {
        id,
        parentTaskId: 'p',
        status: 'running',
        working: false,
        awaitingUser,
        updatedAt: new Date().toISOString(),
        messages: [],
        steps: [],
        turns: [],
        runs: [],
      } as unknown as Task,
      rev: 0,
      abort: { abort: () => void stops++ },
      done: abandoned,
      abandon,
      abandoned,
    } as unknown as Live
    return { e, stops: () => stops }
  }
  // helperKid：派出的子任务还在跑，它停在等子任务上；idleKid：这一轮说完了，停在等下一句
  const helperKid = mk('k1', false)
  const idleKid = mk('k2', true)
  const live = new Map([
    ['k1', helperKid.e],
    ['k2', idleKid.e],
  ])
  const saved: Task[] = []
  const tasks = [{ id: 'p' }, { id: 'k1', parentTaskId: 'p' }, { id: 'k2', parentTaskId: 'p' }]
  const s = {
    live,
    closeChildren: async () => {},
    release: (e: Live) => live.get(e.task.id) === e && live.delete(e.task.id),
    store: {
      list: async () => tasks,
      get: async (id: string) => tasks.find((x) => x.id === id),
      update: async (_id: string, tk: Task) => void saved.push(structuredClone(tk)),
    },
    reportToParent: async () => {},
    followUp: async () => {},
    alertOn: () => () => {},
    shuttingDown: false,
  } as unknown as TasksScope
  const k = createKeepAlive(s)
  await k.stopTree('p')
  assert.equal(helperKid.e.stop, true, '等子任务的子对话被停下（中断子任务），不是只取消等待')
  assert.equal(helperKid.e.stopReason, 'parent' satisfies StopReason)
  assert.ok(!idleKid.e.stop, '停在等下一句的不标停止：这一轮已经正常说完')
  // 进程没了几秒内收口：原因是随父对话停，父对话继续时 resumeKids 会把它拉起来（以前被记成用户停的就不拉）
  await Promise.race([helperKid.e.done, new Promise((r) => setTimeout(r, STOP_WATCH_MS * 6))])
  clearTimeout(hold)
  const last = saved.filter((x) => x.id === 'k1').at(-1)!
  assert.equal(last.status, 'stopped')
  assert.equal(last.stopReason, 'parent' satisfies StopReason)
})
