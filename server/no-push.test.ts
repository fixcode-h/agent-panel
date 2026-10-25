import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '../shared/schema.ts'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'no-push-data-'))
const { noPushEnv } = await import('./exec/runner.ts')

const wt = { path: '/x', branch: 'b', baseBranch: 'main', state: 'active' } as Task['worktree']

test('子对话的独立分支：git push 被拦下，拉取不受影响；父对话和没开分支的不拦', () => {
  assert.equal(noPushEnv({ parentTaskId: '', worktree: wt } as Task).length, 0, '顶层对话不拦')
  assert.equal(noPushEnv({ parentTaskId: 'p', worktree: null } as Task).length, 0, '没开分支的子对话不拦')
  assert.equal(noPushEnv({ parentTaskId: '', worktree: null } as Task, 'allow').length, 0, '允许推送的项目不拦')
  assert.ok(noPushEnv({ parentTaskId: '', worktree: null } as Task, 'deny').length, '项目设置「不推送」时顶层对话也拦')
  const env = noPushEnv({ parentTaskId: 'p', worktree: wt } as Task)
  assert.ok(env.length)

  const dir = mkdtempSync(path.join(tmpdir(), 'no-push-'))
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
  git(dir, 'init', '-q', '--bare', 'remote.git')
  git(dir, 'clone', '-q', 'remote.git', 'w')
  const w = path.join(dir, 'w')
  git(w, 'commit', '-q', '--allow-empty', '-m', 'x')
  const vars = { ...process.env, ...Object.fromEntries(env.map((x) => [x.key, x.value])) }
  const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: w, env: vars, encoding: 'utf8' })
  assert.notEqual(push.status, 0, '推送失败')
  assert.match(push.stderr, /agent-panel-no-push/)
  const fetch = spawnSync('git', ['fetch', 'origin'], { cwd: w, env: vars, encoding: 'utf8' })
  assert.equal(fetch.status, 0, '拉取照常')
})
