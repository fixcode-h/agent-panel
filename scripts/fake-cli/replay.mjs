/**
 * 假 CLI 的回放模式：把录下来的 Claude Code stream-json 输出（真实 CLI 的原始输出，或用
 * scripts/replay-from-export.mjs 从面板导出的对话包转出来的）按原来的时序一轮一轮吐给面板。
 *
 * 用法：FAKE_REPLAY=<录像.jsonl>，或者把录像路径写进 `<FAKE_CLI_LOG>.replay-src`（e2e 只让一段用例回放时用）；
 * 只对 Claude Code 的一次性执行生效。面板每启动一次 CLI 就回放下一轮，
 * 一轮到 `result` 那一行为止；第几轮记在 `<FAKE_CLI_LOG>.replay`。录像用完还被调用时报一条错误结果，
 * 不悄悄成功：用例能看出面板多跑了一轮。
 *
 * 录像每行一个 JSON，就是 CLI 的输出；可以带 `_t`（这一行在本轮开始后多少毫秒出现），回放时按
 * FAKE_REPLAY_SPEED 倍速（默认 10）等到那个时间再吐，没有 `_t` 时每行隔 5ms。`_t` 不会吐给面板。
 *
 * 为什么要它：卡住、转圈这类 Bug 依赖 CLI 吐事件的顺序和间隔，假 CLI 手写的固定输出复现不出来。
 * 用户报一条，就把那段对话导出、转成录像存进 scripts/e2e/fixtures/replay/，在 e2e 里回放成回归用例。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 录像切成轮：每轮到 result 为止（含）；末尾没收尾的那段也算一轮 */
export function replayTurns(text) {
  const turns = []
  let cur = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const obj = JSON.parse(line)
    cur.push(obj)
    if (obj.type === 'result') {
      turns.push(cur)
      cur = []
    }
  }
  if (cur.length) turns.push(cur)
  return turns
}

/** 一行要等多久才吐：有 _t 时按倍速等到那个时间点（相对上一行），没有时固定间隔 */
export function replayDelays(lines, speed = 10, gap = 5) {
  let last = 0
  return lines.map((l) => {
    if (typeof l._t !== 'number') return gap
    const wait = Math.max(0, (l._t - last) / speed)
    last = l._t
    return wait
  })
}

/** 回放下一轮。write 收一行字符串（不带换行）；返回这一轮的序号（从 0 起），录像用完时返回 -1 */
export async function replayTurn({ file, state, write, speed = 10, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const turns = replayTurns(readFileSync(file, 'utf8'))
  const n = existsSync(state) ? Number(readFileSync(state, 'utf8')) || 0 : 0
  writeFileSync(state, String(n + 1))
  const turn = turns[n]
  if (!turn) {
    write(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: `回放录像只有 ${turns.length} 轮，面板却启动了第 ${n + 1} 轮`,
      }),
    )
    return -1
  }
  const delays = replayDelays(turn, speed)
  for (let i = 0; i < turn.length; i++) {
    await wait(delays[i])
    const { _t, ...line } = turn[i]
    write(JSON.stringify(line))
  }
  return n
}
