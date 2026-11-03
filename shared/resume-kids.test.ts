/**
 * 父对话继续时停着的子对话怎么分（实测报告问题 3）：已交付、待收尾的不拉，用户单独停掉的不拉且写进续接说明。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from './schema.ts'
import { activePlan, applyPlan, bindWait, settleWait } from './plan.ts'
import { kidAccepted, kidsSkipNote, rearmKidWait, sortStoppedKids, type ResumeKid } from './resume-kids.ts'

const kid = (id: string, x: Partial<ResumeKid> = {}): ResumeKid => ({ id, title: id, stopReason: 'parent', ...x })

/** 父对话的计划：一步里挂着等各个子对话的等待 */
function parent(waits: Record<string, 'waiting' | 'ok' | 'failed'>): Pick<Task, 'plans'> {
  return {
    plans: [
      {
        steps: [
          {
            id: 's1',
            title: '派子对话',
            children: [],
            waits: Object.entries(waits).map(([ref, state]) => ({ kind: 'child', ref, label: ref, state })),
          },
        ],
      },
    ],
  } as unknown as Pick<Task, 'plans'>
}

test('父对话已经收下结果的子对话算已交付；还在等、失败或没挂等待的不算', () => {
  const p = parent({ A: 'ok', C: 'failed' })
  assert.equal(kidAccepted(p, 'A'), true)
  assert.equal(kidAccepted(p, 'C'), false)
  assert.equal(kidAccepted(p, 'X'), false)
  assert.equal(kidAccepted({ plans: [] }, 'A'), false)
})

test('继续父对话：只拉被连带打断、活还没交的；用户停的、已交付、待收尾的不拉', () => {
  const p = parent({ A: 'ok', C: 'failed' })
  const kids = [
    kid('A'),
    kid('B', { stopReason: 'user' }),
    kid('C'),
    kid('W', { wrapRequest: { state: 'requested', at: 'x', note: '', tests: '', info: '' } }),
    kid('F', { wrapRequest: { state: 'test-failed', at: 'x', note: '', tests: '', info: '' } }),
    kid('S', { stopReason: 'switch' }),
  ]
  const r = sortStoppedKids(p, kids)
  // 测试没通过退回修的还要它接着改，照样拉
  assert.deepEqual(
    r.resume.map((k) => k.id),
    ['C', 'F'],
  )
  assert.deepEqual(
    r.userStopped.map((k) => k.id),
    ['B'],
  )
  assert.deepEqual(
    r.skipped.map((k) => k.id),
    ['A', 'W'],
  )
  const note = kidsSkipNote(r.userStopped, r.skipped).join('\n')
  assert.match(note, /用户单独停掉的子对话：「B」/)
  assert.match(note, /不要自动交回、重派/)
  assert.match(note, /问要不要一起继续/)
  assert.match(note, /「A」[\s\S]*「W」[\s\S]*不要让它们重做/)
  assert.deepEqual(kidsSkipNote([], []), [])
})

test('子对话重新跑起来：父计划里等它、已收成失败的等待恢复成等待中，那一步不再挂「需要修复」（ADR 0042）', () => {
  const task = { plans: [], steps: [] } as unknown as Pick<Task, 'plans' | 'steps'>
  applyPlan(task, { steps: [{ title: '派子对话', children: [{ title: '改登录' }, { title: '改注册' }] }] })
  bindWait(task, '1.1', { kind: 'child', ref: 'A', label: '改登录' })
  bindWait(task, '1.2', { kind: 'child', ref: 'B', label: '改注册' })
  // 旧数据：子对话停下时等待被收成失败，那一步退回「需要修复」
  settleWait(task, 'child', 'A', false)
  const item = activePlan(task)!.steps[0].children[0]
  assert.equal(item.status, 'running')
  assert.match(item.note, /需要修复/)

  assert.equal(rearmKidWait(task, 'A'), true)
  assert.equal(item.waits[0].state, 'waiting')
  assert.equal(item.status, 'waiting', '那一步接着等')
  assert.equal(item.note, '', '「需要修复」的说明过时了，清掉')
  assert.equal(activePlan(task)!.steps[0].status, 'waiting', '主步骤跟着回到等待中')
  // 没有失败的等待：不改、返回 false（调用方据此不落盘）
  assert.equal(rearmKidWait(task, 'A'), false)
  assert.equal(rearmKidWait(task, 'B'), false)
  // 恢复后子对话做完：结果对得上，这一步完成
  assert.deepEqual(settleWait(task, 'child', 'A', true), [{ title: '改登录', done: true }])
  assert.equal(item.status, 'done')
})

test('继续父对话：整棵树到了用量上限停下的子对话也连带拉起（ADR 0042）', () => {
  const sorted = sortStoppedKids(parent({}), [kid('K', { stopReason: 'budget' })])
  assert.deepEqual(
    sorted.resume.map((k) => k.id),
    ['K'],
  )
})
