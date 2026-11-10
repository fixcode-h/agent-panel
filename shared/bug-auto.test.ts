import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import {
  bugStage,
  decideDiagnosis,
  diagnosisGate,
  submitDiagnosis,
  updateBugCase,
  type DiagnosisInput,
} from './bug-diagnosis.ts'
import { autoBlock, autoOn } from './bug-auto.ts'
import { diagnosisCard } from './bug-diagnosis-card.ts'
import type { Recheck } from './bug-diagnosis-schema.ts'
import { phaseFeedback } from './bug-phase.ts'
import type { Task } from './schema.ts'

/** 确认次数按风险收放（分析稿 B2）：没有要注意的自动通过、复核通过时修复和验证合成一次确认 */
setLang('zh')

let n = 0
const id = () => `a${++n}`
const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  symptom: '登录超时后一直转圈',
  repro: 'npm test -- login.test.ts：超时用例失败',
  location: 'web/src/lib/login.ts:40 retry',
  evidence: '日志「[login] retry 3」← login.ts:44 retries < max 永远为真',
  rootCause: 'max 用的是秒，retries 按次数累加',
  confirmed: true,
  fix: 'login.ts:44 把 max 换成次数上限常量',
  files: ['web/src/lib/login.ts'],
  verify: 'login.test.ts 的超时用例改前失败、改后通过',
  level: 'quick',
  // 把握高、类别明确：决策卡上没有「要注意」
  attribution: { category: 'recent', change: 'a1b2c3', author: '张三', how: 'blame', confidence: 'high' },
  rating: { tier: 'low', percent: 95, why: '写错了常量名' },
  ...over,
})
const fixInput = (over: Partial<DiagnosisInput> = {}) =>
  input({
    phase: 'fix',
    changes: [{ file: 'web/src/lib/login.ts', what: 'max 换成次数上限', why: 'retries 按次数累加' }],
    ...over,
  })
const bugTask = () => ({ bug: true, diagnoses: [], requests: [], messages: [], changes: [] }) as unknown as Task
const ok = (r: { ok: boolean; info?: string; error?: string }) => assert.ok(r.ok, r.info ?? r.error ?? '')
const yes = { approve: true, notes: [], overall: '' }
const yesAuto = { ...yes, autoNext: true }
const last = (tk: Task) => tk.diagnoses!.at(-1)!

/** 回归测试命令记进档案：交修复时带上，面板复核 */
const withCommands = (tk: Task) =>
  ok(
    updateBugCase(tk, {
      result: {
        reproBefore: '超时用例失败',
        reproAfter: '通过',
        regressionTests: ['web/src/lib/login.test.ts'],
        commands: ['npm test -- login.test.ts'],
      },
    }),
  )
const recheck = (pass: boolean): Recheck => ({
  state: 'done',
  why: '',
  at: 'x',
  items: [
    {
      command: 'npm test -- login.test.ts',
      skip: '',
      before: { code: 1, out: 'FAIL', ms: 10, timedOut: false, error: '' },
      after: { code: pass ? 0 : 1, out: pass ? 'PASS' : 'FAIL', ms: 10, timedOut: false, error: '' },
    },
  ],
})

test('同意时勾了「后面几步没有要注意的就自动通过」：之后没有要注意的一版当场通过，返回里带着用户同意时的那段话', () => {
  const tk = bugTask()
  ok(
    submitDiagnosis(
      tk,
      input({
        phase: 'cause',
        level: 'standard',
        timeline: [{ kind: 'change', text: 'a1b2c3' }],
        consistency: [{ observation: '一直转圈', explanation: '重试不停' }],
      }),
      id,
    ),
  )
  ok(decideDiagnosis(tk, last(tk).version, yesAuto, id))
  assert.equal(last(tk).autoNext, true)
  assert.ok(autoOn(tk.diagnoses!))
  const r = submitDiagnosis(tk, input({ phase: 'plan' }), id)
  ok(r)
  const d = last(tk)
  assert.equal(d.status, 'approved')
  assert.equal(d.auto, true)
  // 交给它的话和用户点「确认方案」时一样，不用结束这一轮等用户
  assert.match(r.info, /已替用户通过/)
  assert.ok(r.info.includes(phaseFeedback(d)))
  assert.doesNotMatch(r.info, /现在结束这一轮/)
  assert.match(tk.messages.at(-1)!.text, /面板自动通过了/)
  // 决策卡写「面板自动通过」，和用户亲手点的分开
  assert.equal(diagnosisCard(d, { list: tk.diagnoses }).status.text, '面板自动通过')
})

test('有「要注意」的照常停下，对话里写一行为什么；推翻之前结论的、不用改代码的也停', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  ok(decideDiagnosis(tk, last(tk).version, yesAuto, id))
  // 引入点把握低：决策卡上有「引入点还没定下来」
  ok(
    submitDiagnosis(
      tk,
      input({ phase: 'plan', attribution: { category: 'recent', change: 'a1', how: 'blame', confidence: 'low' } }),
      id,
    ),
  )
  assert.equal(last(tk).status, 'pending')
  assert.match(tk.messages.at(-1)!.text, /没有自动通过：有要注意的：引入点还没定下来/)
  // 没勾的那次同意把设置关掉
  ok(decideDiagnosis(tk, last(tk).version, yes, id))
  assert.equal(autoOn(tk.diagnoses!), false)
  // 不用改代码的结论不自动通过
  const t2 = bugTask()
  ok(submitDiagnosis(t2, input({ phase: 'cause' }), id))
  ok(decideDiagnosis(t2, last(t2).version, yesAuto, id))
  const d = { ...last(t2), status: 'pending' as const, noFix: { kind: 'config' as const, how: '改配置' } }
  const b = autoBlock(d, [...t2.diagnoses!, d])
  assert.ok(!b.ok && b.why?.includes('不用改代码'))
})

test('修复写了回归测试命令：自动通过等面板复核；复核通过才通过，验证合在这一次', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  ok(decideDiagnosis(tk, last(tk).version, yesAuto, id))
  withCommands(tk)
  const r = submitDiagnosis(tk, fixInput(), id)
  ok(r)
  const d = last(tk)
  // 交修复时还没复核：停着，不写「没有自动通过」（复核完再判）
  assert.equal(d.status, 'pending')
  assert.deepEqual(d.result?.commands, ['npm test -- login.test.ts'])
  assert.match(r.info, /这一轮结束后面板会在改前的代码/)
  const blocked = autoBlock(d, tk.diagnoses!)
  assert.ok(!blocked.ok && blocked.wait)
  d.recheck = recheck(false)
  const failed = autoBlock(d, tk.diagnoses!)
  assert.ok(!failed.ok && failed.why?.includes('复核回归测试没通过'))
  d.recheck = recheck(true)
  assert.ok(autoBlock(d, tk.diagnoses!).ok)
})

test('复核过「改前失败、改后通过」：用户确认修复就同时算验证通过，能直接收尾；没复核的照旧要验证', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  ok(decideDiagnosis(tk, last(tk).version, yes, id))
  withCommands(tk)
  ok(submitDiagnosis(tk, fixInput(), id))
  last(tk).recheck = recheck(true)
  ok(decideDiagnosis(tk, last(tk).version, yes, id))
  const d = last(tk)
  assert.equal(d.merged, true)
  assert.match(tk.messages.at(-1)!.text, /验证一起通过/)
  assert.match(phaseFeedback(d), /不再交 phase: verify/)
  assert.equal(bugStage(tk), '收尾')
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts']), '')

  const plain = bugTask()
  ok(submitDiagnosis(plain, input({ phase: 'plan' }), id))
  ok(decideDiagnosis(plain, last(plain).version, yes, id))
  ok(submitDiagnosis(plain, fixInput(), id))
  ok(decideDiagnosis(plain, last(plain).version, yes, id))
  assert.ok(!last(plain).merged)
  assert.match(diagnosisGate(plain, ['web/src/lib/login.ts']), /还要验证/)
})
