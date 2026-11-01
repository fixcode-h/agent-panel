import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireInstanceLock } from './instance-lock.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'agent-panel-lock-'))

test('单实例锁：第二个实例拿不到，释放后能拿', () => {
  const d = dir()
  const a = acquireInstanceLock(d)
  assert.ok(a.ok)
  // 用一个活着的 node 进程（父进程）模拟另一个实例
  const b = acquireInstanceLock(d, { pid: process.ppid || 1 })
  assert.equal(b.ok, false, '活着的实例占着锁')
  assert.equal(!b.ok && b.holder.pid, process.pid)
  a.release()
  assert.ok(!existsSync(path.join(d, 'panel.lock')))
  const c = acquireInstanceLock(d)
  assert.ok(c.ok)
  c.release()
})

test('单实例锁：持有者进程已经不在（崩溃、强杀）就接管', () => {
  const d = dir()
  // 起一个立刻退出的进程，拿到一个确定已经死掉的 pid
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  writeFileSync(path.join(d, 'panel.lock'), JSON.stringify({ pid: Number(gone.stdout), startedAt: 'x' }))
  const r = acquireInstanceLock(d)
  assert.ok(r.ok, '过期锁被接管')
  r.release()
})

test('单实例锁：锁文件写坏了也当过期锁', () => {
  const d = dir()
  writeFileSync(path.join(d, 'panel.lock'), '{bad')
  const r = acquireInstanceLock(d)
  assert.ok(r.ok)
  r.release()
})
