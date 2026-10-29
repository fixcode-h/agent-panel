/**
 * 分析报告挪到右侧功能面板后的判定：哪条回复是报告、是哪种、某一项在当前对话里修过没有。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Task, TaskMessage } from '@shared/schema'
import { EVOLUTION_LANG } from '@shared/task-export'
import { LESSON_REVIEW_LANG } from '@shared/lesson-review'
import { DIAGNOSIS_LANG, fixApplicable, parseDiagnosis, replaceFix, stripDiagnosis } from '@shared/diagnosis'
import { setLang } from '@shared/i18n'
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
      evidence: [
        { kind: 'problem', file: 'a.ts', line: '7', note: '这里' },
        { kind: 'oops', file: 'c.ts' },
      ],
      fixes: [{ file: 'b.ts', change: '判空' }],
      files: ['a.ts'],
    }) +
    '\n```'
  assert.equal(findReport(task([msg('u', 'user', '排查'), msg('a', 'agent', diag)]))?.kind, 'diagnosis')
  const ok = parseDiagnosis(diag)
  assert.ok(ok?.ok)
  assert.deepEqual(ok.value.files, ['a.ts', 'c.ts', 'b.ts'])
  assert.equal(ok.value.impacts.length, 1)
  assert.equal(ok.value.evidence[0].line, 7)
  // 证据的角色：认得的画标签，写错的当没写，不让整条证据丢掉
  assert.equal(ok.value.evidence[0].kind, 'problem')
  assert.equal(ok.value.evidence[1].kind, undefined)
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

test('一键应用修复：改前原文恰好出现一次才替换，其余写明原因', () => {
  setLang('zh')
  const fix = (before: string, after: string, file = 'a.ts') => ({ file, before, after })
  const src = 'const a = price.toFixed(2)\nconst b = 1\n'
  // 成功：只换那一处，after 里的 $& 不当替换模式
  assert.deepEqual(replaceFix(src, fix('price.toFixed(2)', "fmt('$&')")), {
    ok: true,
    text: "const a = fmt('$&')\nconst b = 1\n",
  })
  // 匹配不到；改后的内容已经在文件里时说明可能已经改过
  const none = replaceFix(src, fix('price.toFixed(3)', 'qqq'))
  assert.ok(!none.ok && /找不到改前的原文/.test(none.error) && !/已经改过/.test(none.error))
  const done = replaceFix(src, fix('price.toFixed(9)', 'const b = 1'))
  assert.ok(!done.ok && /已经改过/.test(done.error))
  // 多处匹配不猜
  const many = replaceFix('x\nx\n', fix('x', 'y'))
  assert.ok(!many.ok && /不止一处/.test(many.error))
  // 缺原文、缺改后内容、缺文件：逐条报原因，按钮也不把它们算进「N 处」
  for (const f of [fix('', 'y'), fix('x', ''), fix('x', 'y', '')]) {
    assert.equal(replaceFix('x', f).ok, false)
    assert.equal(fixApplicable(f), false)
  }
  assert.equal(fixApplicable(fix('x', 'y')), true)
  // CRLF 的文件：AI 抄的是 LF，按 CRLF 找到并用 CRLF 写回，不留混合换行
  assert.deepEqual(replaceFix('a\r\nb\r\nc\r\n', fix('a\nb', 'a\nB\nb')), { ok: true, text: 'a\r\nB\r\nb\r\nc\r\n' })
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
