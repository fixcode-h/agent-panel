/**
 * 内存紧张时自动释放空闲会话：只放没开着页面、停在等下一句的；冷却期内不连着放；阈值 0 关掉；macOS 不判。
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

// 进程登记、日志都在 DATA_DIR 下：import 之前指到临时目录，不碰本机的数据目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'idle-release-data-'))
const { createIdleRelease, freeMemoryPercent, shouldReleaseForMemory, MEMORY_RELEASE_COOLDOWN_MS } =
  await import('./idle-release.ts')
const { setViewer, forgetPresence } = await import('../presence.ts')

const live = (id: string, t: Partial<Task>): Live =>
  ({
    task: { id, title: id, cli: 'claude', updatedAt: '2026-11-11T00:00:00Z', awaitingUser: true, working: false, ...t },
  }) as unknown as Live

function rig() {
  const stopped: [string, StopReason][] = []
  const map = new Map<string, Live>([
    ['idle', live('idle', {})],
    ['open', live('open', {})],
    ['busy', live('busy', { awaitingUser: false, working: true })],
    ['parent', live('parent', {})],
    ['kid', live('kid', { parentTaskId: 'parent', awaitingUser: false, working: true })],
  ])
  const s = { live: map, stopTask: (id: string, r: StopReason) => stopped.push([id, r]) } as unknown as TasksScope
  return { stopped, idle: createIdleRelease(s) }
}

test('可用内存比例：macOS 不判，其余按 free / total', () => {
  assert.equal(freeMemoryPercent('darwin', 1, 100), null)
  assert.equal(freeMemoryPercent('win32', 5, 100), 5)
  assert.equal(freeMemoryPercent('linux', 5, 0), null)
})

test('判定：阈值 0 关掉、够用不放、冷却期内不放', () => {
  const base = { percent: 5, threshold: 10, now: 10 * 60_000, lastRelease: 0 }
  assert.equal(shouldReleaseForMemory(base), true)
  assert.equal(shouldReleaseForMemory({ ...base, threshold: 0 }), false)
  assert.equal(shouldReleaseForMemory({ ...base, percent: 12 }), false)
  assert.equal(shouldReleaseForMemory({ ...base, percent: null }), false)
  assert.equal(shouldReleaseForMemory({ ...base, lastRelease: base.now - MEMORY_RELEASE_COOLDOWN_MS + 1 }), false)
})

test('内存紧张时只放没开着页面的空闲会话，名下有子对话在跑的父对话不动', async () => {
  setViewer('open', 'v1', true)
  try {
    const { stopped, idle } = rig()
    const now = Date.now()
    const got = await idle.checkMemory({ now, percent: 4, threshold: 10 })
    assert.deepEqual(
      got.map((x) => x.id),
      ['idle'],
    )
    assert.deepEqual(stopped, [['idle', 'idle']])
    // 冷却期内再判一次：不再放
    assert.deepEqual(await idle.checkMemory({ now: now + 1000, percent: 4, threshold: 10 }), [])
    assert.equal(stopped.length, 1)
    // 内存够用 / 阈值 0：什么都不放
    const other = rig()
    assert.deepEqual(await other.idle.checkMemory({ now, percent: 30, threshold: 10 }), [])
    assert.deepEqual(await other.idle.checkMemory({ now, percent: 1, threshold: 0 }), [])
    assert.equal(other.stopped.length, 0)
  } finally {
    forgetPresence('open')
  }
})
