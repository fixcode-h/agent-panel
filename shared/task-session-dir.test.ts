import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameDir, sessionMoved } from './task.ts'

const worktree = 'C:\\Users\\17787\\.agent-panel\\worktrees\\55f6571a-c89b-4ce5-ac64-be0f87e6eefb'
const project = 'E:\\Project\\agent-panel'

test('sameDir：Windows 路径的大小写、分隔符、末尾斜杠都不影响判定', () => {
  assert.equal(sameDir(project, 'e:/project/agent-panel'), true)
  assert.equal(sameDir(project, 'E:\\Project\\agent-panel\\'), true)
  assert.equal(sameDir(project, 'e:/project/agent-panel/'), true)
  assert.equal(sameDir(project, worktree), false)
  assert.equal(sameDir('', project), false)
  assert.equal(sameDir(project, ''), false)
})

test('sessionMoved：会话在别的目录里就算搬过（子任务也按自己那一条记录判定）', () => {
  // 子任务的会话是在原项目目录里开的，这一轮却要在这个目录之外执行：不能再拿它续接
  const task = { sessionDirs: { '@chat/sub/h3': project } }
  assert.equal(sessionMoved(task, '@chat/sub/h3', worktree), true)
  assert.equal(sessionMoved(task, '@chat/sub/h3', 'e:/project/agent-panel/'), false)
})

test('sessionMoved：没记过目录的会话不判为搬过（旧任务交给失败后的重开兜底）', () => {
  assert.equal(sessionMoved({ sessionDirs: {} }, '@chat/sub/h3', worktree), false)
  assert.equal(sessionMoved({ sessionDirs: {}, sessionDir: '' }, '@chat/sub/h3', worktree), false)
})

test('sessionMoved：对话在没有新字段时退回共用的 sessionDir', () => {
  const old = { sessionDirs: {}, sessionDir: project }
  assert.equal(sessionMoved(old, 'agent-1', worktree, true), true)
  assert.equal(sessionMoved(old, 'agent-1', project, true), false)
  // 节点没有 sessionDir 这个兜底：不能因为对话搬过就把每个节点的会话都丢掉
  assert.equal(sessionMoved(old, '@chat/sub/h3', worktree, false), false)
})

test('sessionMoved：新字段按会话分别记，优先于对话共用的 sessionDir', () => {
  const task = { sessionDirs: { '@chat/sub/h3': worktree }, sessionDir: project }
  assert.equal(sessionMoved(task, '@chat/sub/h3', worktree, true), false)
})
