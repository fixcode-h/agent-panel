/**
 * 分析报告挪到右侧功能面板后的判定：哪条回复是报告、是哪种、某一项在当前对话里修过没有。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Task, TaskMessage } from '@shared/schema'
import { EVOLUTION_LANG } from '@shared/task-export'
import { LESSON_REVIEW_LANG } from '@shared/lesson-review'
import { DIAGNOSIS_LANG, parseDiagnosis, stripDiagnosis } from '@shared/diagnosis'
import {
  analysisTiming,
  findReport,
  fixHead,
  fixState,
  isAnalysisTask,
  stripInitJson,
  timingMs,
} from './analysis-report'

const msg = (id: string, role: TaskMessage['role'], text: string) =>
  ({ id, role, text, agentId: '', step: '', tools: [], at: '' }) as unknown as TaskMessage
const task = (messages: TaskMessage[], extra: Partial<Task> = {}) =>
  ({ mode: 'chat', status: 'done', working: false, messages, ...extra }) as Task

const evo = '结论\n\n```' + EVOLUTION_LANG + '\n{"summary":"s","changes":[],"issues":[]}\n```'
const review = '```' + LESSON_REVIEW_LANG + '\n{"items":[]}\n```'

test('认出执行分析和教训评审的报告，取最新的一份', () => {
  assert.equal(findReport(task([msg('u', 'user', '分析'), msg('a', 'agent', '没有报告')])), null)
  assert.equal(findReport(task([msg('u', 'user', '分析'), msg('a', 'agent', evo)]))?.kind, 'run')
  const both = task([
    msg('u', 'user', '分析'),
    msg('a', 'agent', evo),
    msg('u2', 'user', '再评审'),
    msg('b', 'agent', review),
  ])
  assert.equal(findReport(both)?.kind, 'lessons')
  // 排查的结构化结论：认成 diagnosis；证据、修复里的文件补进相关文件，写坏的单条跳过
  const diag =
    '原因\n\n```' +
    DIAGNOSIS_LANG +
    '\n' +
    JSON.stringify({
      rootCause: { title: '没判空' },
      confidence: 'high',
      impacts: [{ text: '白屏', severity: 'high' }, { severity: 'low' }],
      evidence: [{ file: 'a.ts', line: '7', note: '这里' }],
      fixes: [{ file: 'b.ts', change: '判空' }],
      files: ['a.ts'],
    }) +
    '\n```'
  assert.equal(findReport(task([msg('u', 'user', '排查'), msg('a', 'agent', diag)]))?.kind, 'diagnosis')
  const ok = parseDiagnosis(diag)
  assert.ok(ok?.ok)
  assert.deepEqual(ok.value.files, ['a.ts', 'b.ts'])
  assert.equal(ok.value.impacts.length, 1)
  assert.equal(ok.value.evidence[0].line, 7)
  assert.equal(stripDiagnosis(diag), '原因')
  // 写坏了（JSON 不合法、缺根因）不吞掉：给出原文，对话区也照原文留着
  const bad = '```' + DIAGNOSIS_LANG + '\n{"rootCause": {}}\n```'
  const failed = parseDiagnosis(bad)
  assert.ok(failed && !failed.ok && failed.raw === '{"rootCause": {}}')
  assert.equal(stripDiagnosis(bad), bad)
  assert.equal(parseDiagnosis('```' + DIAGNOSIS_LANG + '\n{oops\n```')?.ok, false)
  // 分析用时：有轮次用最近一轮的起止，在跑时从开始算到现在；没有轮次用累计执行时间
  const turn = (startedAt: string, endedAt: string, status: Task['status']) =>
    ({ startedAt, endedAt, status }) as Task['turns'][number]
  const ended = analysisTiming({
    runMs: 999_000,
    runStartedAt: '',
    turns: [turn('2026-01-01T00:00:00Z', '2026-01-01T00:00:46Z', 'done')],
  })
  assert.equal(ended && timingMs(ended), 46_000)
  const live = analysisTiming({ runMs: 0, runStartedAt: '', turns: [turn('2026-01-01T00:00:00Z', '', 'running')] })
  assert.equal(live && timingMs(live, Date.parse('2026-01-01T00:01:05.400Z')), 65_000)
  assert.equal(analysisTiming({ runMs: 0, runStartedAt: '', turns: [] }), undefined)
  assert.equal(timingMs(analysisTiming({ runMs: 12_300, runStartedAt: '', turns: [] })!), 12_000)
})

test('初始化的 JSON 只在初始化对话里算报告', () => {
  const json = '说明\n\n```json\n{"name":"x"}\n```'
  assert.equal(findReport(task([msg('u', 'user', '初始化'), msg('a', 'agent', json)])), null)
  assert.equal(
    findReport(task([msg('u', 'user', '初始化'), msg('a', 'agent', json)], { analysis: 'init' }))?.kind,
    'init',
  )
})

test('正在回复时只看最后一条用户消息之前的报告：点修复后报告还在', () => {
  const tk = task(
    [
      msg('u', 'user', '分析'),
      msg('a', 'agent', evo),
      msg('f', 'user', `${fixHead('登录失败')}\n\n修它`),
      msg('b', 'agent', '正在改…'),
    ],
    { status: 'running', working: true },
  )
  assert.equal(findReport(tk)?.message.id, 'a')
})

test('修复状态：没发过、正在修、修完', () => {
  const base = [msg('u', 'user', '分析'), msg('a', 'agent', evo)]
  assert.equal(fixState(task(base), '登录失败'), 'todo')
  const sent = [...base, msg('f', 'user', `${fixHead('登录失败')}\n\n修它`)]
  assert.equal(fixState(task(sent, { status: 'running', working: true }), '登录失败'), 'working')
  assert.equal(fixState(task([...sent, msg('r', 'agent', '改好了')]), '登录失败'), 'done')
  // 修完又问了别的：仍然算修过
  assert.equal(
    fixState(
      task([...sent, msg('r', 'agent', '好'), msg('q', 'user', '别的')], { status: 'running', working: true }),
      '登录失败',
    ),
    'done',
  )
})

test('分析对话：新对话看 analysis，旧对话看角色', () => {
  const agents = [
    { id: 'an', origin: 'builtin:analyzer' },
    { id: 'w', origin: 'builtin:worker' },
  ]
  assert.equal(isAnalysisTask({ analysis: 'run', agentId: '' }, agents), true)
  assert.equal(isAnalysisTask({ agentId: 'an' }, agents), true)
  assert.equal(isAnalysisTask({ agentId: 'w' }, agents), false)
  assert.equal(isAnalysisTask({ agentId: '' }, agents), false)
})

test('初始化对话的回复在对话区去掉末尾的 JSON', () => {
  assert.equal(stripInitJson('说明\n\n```json\n{"name":"x"}\n```'), '说明')
  assert.equal(stripInitJson('只有说明'), '只有说明')
  assert.equal(stripInitJson('命令\n```\nnpm test\n```'), '命令\n```\nnpm test\n```')
})
