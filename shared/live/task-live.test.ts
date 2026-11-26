import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../i18n.ts'
import { TaskData } from '../schema.ts'
import { taskState } from '../task.ts'
import { taskWaitText } from '../tasks/word.ts'
import { liveActive, liveBusy, liveWaitText, liveWord, taskLiveOf, TaskLive, type LiveRuntime } from './task-live.ts'

setLang('zh')

const task = (over: Record<string, unknown> = {}) =>
  TaskData.parse({ projectId: 'p', title: 't', mode: 'chat', status: 'done', ...over })
const rt = (over: Partial<LiveRuntime> = {}): LiveRuntime => ({
  cliAlive: false,
  jobs: [],
  childrenWorking: 0,
  childrenCli: 0,
  childrenNeeds: 0,
  ...over,
})

test('taskLiveOf 和旧的 taskState 是同一个判定：运行时事实从 rt 来', () => {
  const cases: [Record<string, unknown>, Partial<LiveRuntime>][] = [
    [{}, {}],
    [{ status: 'running', working: true }, { cliAlive: true }],
    [{ status: 'failed' }, {}],
    [{ status: 'stopped', stopReason: 'user' }, {}],
    [{}, { childrenWorking: 2 }],
    [{}, { childrenNeeds: 1 }],
    [{}, { jobs: [{ id: 'j', name: '编译', command: 'make', state: 'running', startedAt: '' }] }],
    [{ status: 'failed' }, { childrenWorking: 1 }],
  ]
  for (const [over, r] of cases) {
    const tk = task(over)
    const live = taskLiveOf(tk, rt(r))
    const legacy = taskState({
      ...tk,
      jobs: r.jobs,
      childrenWorking: r.childrenWorking,
      childrenNeeds: r.childrenNeeds,
    })
    assert.equal(live.state, legacy, JSON.stringify({ over, r }))
    TaskLive.parse(live)
  }
})

test('等什么、短词：等子对话、等后台命令、子对话等你处理', () => {
  const kids = taskLiveOf(task(), rt({ childrenWorking: 1 }))
  assert.equal(kids.state, 'waiting')
  assert.equal(kids.wait, 'children')
  assert.equal(liveWord(kids), '子对话执行中')
  assert.equal(liveWaitText(kids), taskWaitText({ ...task(), childrenWorking: 1 }))
  assert.ok(liveBusy(kids) && liveActive(kids))

  const needs = taskLiveOf(task(), rt({ childrenNeeds: 1 }))
  assert.equal(needs.need, 'children')
  assert.equal(liveWaitText(needs), '子对话等你处理')
  assert.ok(!liveBusy(needs) && liveActive(needs), '等你处理不转圈，但算还在运行')

  const done = taskLiveOf(task(), rt({ cliAlive: true }))
  assert.equal(done.state, 'done')
  assert.equal(done.cliAlive, true, 'CLI 存活照实带上')
  assert.equal(liveWaitText(done), '')
  assert.ok(!liveBusy(undefined) && !liveActive(undefined), '还没拿到 live 时不算在跑')
})

test('名下工作流运行（不是子对话）：在跑算「工作流执行中」归进进行中，等你确认算等你处理', () => {
  // 计划没做完、这一轮说完了：以前只剩「未完成」，侧栏归到日期组里（用户 2026-11-26 报）
  const plan = {
    plans: [
      {
        id: 'p1',
        createdAt: '',
        doneAt: '',
        steps: [
          { id: 'a', title: '设计', status: 'done' },
          { id: 'b', title: '实现', status: 'running' },
        ],
      },
    ],
  }
  assert.equal(taskLiveOf(task(plan), rt()).state, 'unfinished')
  const running = taskLiveOf(task(plan), rt({ runsWorking: 1 }))
  assert.equal(running.state, 'waiting')
  assert.equal(running.wait, 'workflow')
  assert.equal(liveWord(running), '工作流执行中')
  assert.ok(liveBusy(running))
  TaskLive.parse(running)

  const confirm = taskLiveOf(task(plan), rt({ runsNeeds: 1 }))
  assert.equal(confirm.state, 'needs')
  assert.equal(confirm.need, 'workflow')
  assert.equal(liveWord(confirm), '工作流等你确认')
  assert.equal(liveWaitText(confirm), '工作流等你确认')
  TaskLive.parse(confirm)
})
