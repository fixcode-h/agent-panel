/**
 * 子对话之间要不要提示「文件撞了」：只有共用一个工作目录时才需要。
 * Git 项目里的子对话走独立分支（已建好、还没开、合并回收后继续），撞了是合并时的事，不提醒。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharesWorkdir } from './task.ts'

const wt = (state: 'active' | 'merged' | 'discarded') => ({
  path: '/tmp/wt',
  branch: 'agent-panel/abc',
  baseBranch: 'dev',
  state,
  note: '',
})

test('走独立分支的子对话不算共用工作目录：已建好、还没开、合并回收后继续', () => {
  // 已经有自己的分支目录
  assert.equal(sharesWorkdir({ wantsWorktree: false, worktree: wt('active') }), false)
  // 已经定了要走独立分支，真要改文件时才开：这一轮改的也在之后的分支里
  assert.equal(sharesWorkdir({ wantsWorktree: true, worktree: null }), false)
  // 合并回原分支、工作区删掉后继续对话：面板会按原分支名重建，仍在自己的分支里
  assert.equal(sharesWorkdir({ wantsWorktree: false, worktree: wt('merged') }), false)
  // 合并后继续（重建前）也还是这条对话的分支
  assert.equal(sharesWorkdir({ wantsWorktree: true, worktree: wt('merged') }), false)
})

test('共用父对话目录的才算共用：P4 / 没有版本控制 / 主动丢弃分支', () => {
  // 不是 Git 仓库或项目设成共用目录：从来没设过 wantsWorktree，也没有 worktree
  assert.equal(sharesWorkdir({ wantsWorktree: false, worktree: null }), true)
  // 用户主动丢弃了分支，之后回到父对话的目录里改
  assert.equal(sharesWorkdir({ wantsWorktree: false, worktree: wt('discarded') }), true)
})
