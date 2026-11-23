// 后台作业注册表（server/jobs/registry.ts，ADR 0075）：进度、日志按行号增量取、取消后记成已取消、清除已结束的
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelJob, clearEnded, jobLog, listJobs, onJobs, startJob } from './registry.ts'

test('作业从开始到取消：日志增量取，取消调回调并记成已取消，推送合并成一次整份，清除只清结束的', async () => {
  const pushed: number[] = []
  const off = onJobs((l) => pushed.push(l.length))
  let stopped = false
  const a = startJob({
    source: 'ue',
    projectId: 'p1',
    kind: 'build',
    title: '编译',
    cancel: () => void (stopped = true),
  })
  const b = startJob({ source: 'panel', kind: 'download', title: '下载' })
  a.log('第一行\n第二行\n')
  a.progress({ phase: '编译 C++', done: 1, total: 4 })
  assert.deepEqual(jobLog(a.id)?.lines, ['第一行', '第二行'])
  a.log('第三行')
  assert.deepEqual(jobLog(a.id, 2), { lines: ['第三行'], next: 3 })
  assert.equal((await cancelJob(b.id)).info, 'not-cancelable')
  assert.deepEqual(await cancelJob(a.id), { ok: true, info: '' })
  assert.ok(stopped && a.canceled)
  a.end(false, '被取消')
  b.end(true)
  assert.equal(listJobs({ projectId: 'p1' })[0].status, 'canceled')
  assert.equal((await cancelJob(a.id)).info, 'ended')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(pushed.length, 1, '200 毫秒内的变化合并成一次推送')
  const c = startJob({ source: 'panel', kind: 'scan', title: '扫描' })
  clearEnded()
  assert.deepEqual(
    listJobs().map((j) => j.id),
    [c.id],
  )
  c.end(true)
  off()
})
