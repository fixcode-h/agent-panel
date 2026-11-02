/**
 * 状态诊断的判定（shared/lifecycle.ts）：一句话结论、进程为什么不在、各类「卡死」的检查。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import { exitText, lastExit, parseLogLine, verdictOf, type LifeFacts } from './lifecycle.ts'

setLang('zh')

const NOW = Date.parse('2026-11-02T12:00:00Z')
const base = (x: Partial<LifeFacts> = {}): LifeFacts => ({
  kind: 'conversation',
  status: 'running',
  state: 'running',
  working: true,
  awaitingUser: false,
  live: { stop: false },
  held: 0,
  cliAlive: true,
  helpers: 0,
  jobs: 0,
  waitsOn: [],
  ...x,
})
const codes = (f: LifeFacts) => verdictOf(f, NOW).anomalies.map((a) => a.code)

test('日志：按 task-log.ts 的格式解析事件和字段，JSON 包着的值还原；拿最近一次进程退出', () => {
  const l = parseLogLine('2026-11-02 11:59:00.123 [CLI 进程退出] pid=42 code=1 aliveMs=5000 stderr="boom: x=1"')
  assert.equal(l?.event, 'CLI 进程退出')
  assert.deepEqual(l?.fields, { pid: '42', code: '1', aliveMs: '5000', stderr: 'boom: x=1' })
  assert.equal(parseLogLine('    续行的内容'), undefined)
  const lines = [
    parseLogLine('2026-11-02 11:00:00.000 [CLI 进程退出] pid=1 code=0')!,
    parseLogLine('2026-11-02 11:10:00.000 [CLI 进程退出] pid=2 code=null signal=SIGTERM killed=stopped step=a/sub/h1')!,
    parseLogLine('2026-11-02 11:20:00.000 [CLI 进程退出] pid=3 code=137 stderr=oom')!,
  ]
  assert.equal(lastExit(lines)?.pid, 3, '对话自己这一轮：最近一次（步骤不同的不算）')
  assert.deepEqual(lastExit(lines, 'a/sub/h1'), {
    at: lines[1].at,
    pid: 2,
    code: null,
    signal: 'SIGTERM',
    killed: 'stopped',
    aliveMs: undefined,
    stderr: undefined,
  })
})

test('进程为什么不在：面板停的、超时、太久没输出、被信号结束、异常退出、正常说完', () => {
  const at = NOW
  assert.match(exitText({ status: 'stopped', stopReason: 'user', exit: { at, killed: 'stopped' } }), /面板结束了进程/)
  assert.match(exitText({ status: 'failed', exit: { at, killed: 'timeout' } }), /单步时限/)
  assert.match(exitText({ status: 'failed', exit: { at, killed: 'idle' } }), /太久没有任何输出/)
  assert.match(exitText({ status: 'failed', exit: { at, signal: 'SIGKILL' } }), /信号 SIGKILL/)
  assert.match(exitText({ status: 'failed', exit: { at, code: 1, stderr: 'auth' } }), /退出码 1.*auth/)
  assert.match(exitText({ status: 'done', exit: { at, code: 0, aliveMs: 3000 } }), /正常退出（活了 3 秒）/)
  assert.match(exitText({ status: 'done' }), /没有启动过/)
})

test('上一秒还在输出、下一秒「等待模型」：说清请求发出多久没回、CLI 在不在重试、进程还在不在', () => {
  // 请求发出 30 秒还没输出：正常，只写结论
  const short = verdictOf(base({ trace: { requests: 4, requestAt: NOW - 30_000 } }), NOW)
  assert.match(short.headline, /第 4 次请求发出 30 秒，还没有任何输出/)
  assert.deepEqual(short.anomalies, [])
  // 两分钟没输出、也没报重试：网关没回或连接挂住
  assert.deepEqual(codes(base({ trace: { requests: 4, requestAt: NOW - 120_000 } })), ['model-silent'])
  // CLI 在自己重试：结论直接写重试和原因，不报「没回」
  const retry = verdictOf(
    base({ trace: { requests: 4, requestAt: NOW - 120_000, retry: { attempt: 3, error: '529 overloaded', at: NOW } } }),
    NOW,
  )
  assert.match(retry.headline, /第 3 次.*529 overloaded/)
  assert.deepEqual(retry.anomalies, [])
  // 输出到一半停住
  assert.deepEqual(
    codes(
      base({
        trace: { requests: 2, requestAt: NOW - 300_000, firstOutputAt: NOW - 290_000, lastOutputAt: NOW - 200_000 },
      }),
    ),
    ['output-stalled'],
  )
  // 标着在执行，进程却没了：执行位没收口
  assert.deepEqual(codes(base({ cliAlive: false, trace: { requests: 1, requestAt: NOW - 5_000 } })), [
    'working-no-process',
  ])
  // 在跑工具：不算等模型
  assert.match(
    verdictOf(base({ runningTool: 'Bash · npm test', trace: { requests: 1, requestAt: NOW - 500_000 } }), NOW).headline,
    /在跑工具：Bash/,
  )
})

test('这一轮说完了在等子对话：子对话已经不跑了、父对话却没被叫醒要报出来；子对话还在跑只是说明', () => {
  const waiting = base({ working: false, state: 'waiting', waitsOn: [{ id: 'k1', title: '修登录', state: 'running' }] })
  assert.match(verdictOf(waiting, NOW).headline, /在等子对话：「修登录」（执行中）/)
  assert.deepEqual(codes(waiting), [])
  const stuck = base({ working: false, state: 'waiting', waitsOn: [{ id: 'k1', title: '修登录', state: 'done' }] })
  assert.deepEqual(codes(stuck), ['child-idle-parent-waiting'])
  // 父对话这一轮说完、进程退了，计划在等的子对话已经做完：同样报出来
  const parked = base({
    status: 'done',
    state: 'waiting',
    working: false,
    live: undefined,
    cliAlive: false,
    waitsOn: [{ id: 'k1', title: '修登录', state: 'stopped' }],
  })
  assert.ok(codes(parked).includes('child-idle-parent-waiting'))
})

test('全部做完了还显示在等：排着的消息没人接、执行位空占着、残留的排队标记和进程都报出来', () => {
  assert.deepEqual(
    codes(base({ status: 'done', state: 'done', working: false, live: undefined, cliAlive: false, held: 2 })),
    ['held-unhandled'],
  )
  assert.deepEqual(codes(base({ working: false, awaitingUser: false })), ['slot-idle'])
  assert.deepEqual(
    codes(
      base({ status: 'stopped', state: 'stopped', working: false, live: undefined, cliAlive: false, apiWait: true }),
    ),
    ['apiwait-stale'],
  )
  assert.deepEqual(codes(base({ status: 'done', state: 'done', working: false, live: undefined, cliAlive: true })), [
    'process-leftover',
  ])
  assert.deepEqual(codes(base({ status: 'running', live: undefined, working: false, cliAlive: false })), [
    'running-no-slot',
  ])
  // 停在等下一句、进程活着：正常，不报
  assert.deepEqual(codes(base({ working: false, awaitingUser: true })), [])
})

test('停止发出很久还没收完要报；子任务被打断时结论写清还没重新开始', () => {
  assert.deepEqual(codes(base({ live: { stop: true, stopReason: 'user', stopAt: NOW - 8_000 } })), ['stop-slow'])
  assert.deepEqual(codes(base({ live: { stop: true, stopReason: 'user', stopAt: NOW - 1_000 } })), [])
  const helper = verdictOf(
    base({
      kind: 'helper',
      status: 'running',
      state: undefined,
      working: false,
      interrupted: true,
      live: undefined,
      cliAlive: false,
    }),
    NOW,
  )
  assert.match(helper.headline, /被打断了/)
})

test('不报「请求开始」的 CLI（Codex、Pi）：按 CLI 启动时间说等了多久，久了照样报', () => {
  const v = verdictOf(base({ trace: { requests: 0, startedAt: NOW - 20_000 } }), NOW)
  assert.match(v.headline, /CLI 启动 20 秒，还没有任何输出/)
  assert.deepEqual(codes(base({ trace: { requests: 0, startedAt: NOW - 200_000 } })), ['model-silent'])
})

test('计划没做完却停下：推满了说是推满了，没推满说推进没接上；上一轮被截断、没调工具也要说出来', () => {
  const idle = { status: 'running' as const, state: 'done' as const, working: false, awaitingUser: true }
  const plan = { title: '贴到最新', done: 3, total: 7, waiting: 0, open: 4, key: 'aaaa0000' }
  const stalled = (x: Partial<LifeFacts>) => verdictOf(base({ ...idle, plan, ...x }), NOW).anomalies
  assert.match(
    stalled({ nudge: { key: 'aaaa0000', n: 3, max: 3 } }).find((a) => a.code === 'plan-stalled')!.text,
    /推满了 3 次/,
  )
  assert.match(stalled({}).find((a) => a.code === 'plan-stalled')!.text, /也不在等任何结果/)
  // 在等结果、计划已做完：不算停住
  assert.ok(!codes(base({ ...idle, plan: { ...plan, waiting: 1 } })).includes('plan-stalled'))
  assert.ok(!codes(base({ ...idle, plan: { ...plan, open: 0 } })).includes('plan-stalled'))
  assert.deepEqual(
    codes(
      base({
        ...idle,
        trace: { requests: 3, lastTurn: { stopReason: 'max_tokens', endedOn: 'text_delta', tools: 0 } },
      }),
    ),
    ['turn-cut'],
  )
  assert.deepEqual(codes(base({ ...idle, trace: { requests: 3, lastTurn: { stopReason: 'end_turn', tools: 0 } } })), [])
})
