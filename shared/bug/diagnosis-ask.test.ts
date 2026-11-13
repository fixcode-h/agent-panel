import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import { decideDiagnosis, submitDiagnosis, type DiagnosisInput } from './diagnosis.ts'
import { compareReports, conclusionChanged, splitSections } from './diagnosis-compare.ts'
import { labelOf, verOf } from './phase.ts'
import type { Task } from '../schema.ts'

/**
 * 诊断报告的提问、补充出新一版（用户 2026-11-13 定，设计稿「诊断报告-提问补充出新版」）：
 * 退回分「提问 / 补充」和「不认同」两种意图；按提问重出的是小版本 N.1；新旧两份能逐节对比
 */
setLang('zh')

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  symptom: '登录超时后一直转圈',
  repro: 'npm test -- login.test.ts：超时用例失败',
  location: 'web/src/lib/login.ts:40 retry → api.ts:12 fetch',
  evidence: '日志「[login] retry 3」← login.ts:44 retries < max 永远为真',
  rootCause: 'max 用的是秒，retries 按次数累加',
  confirmed: true,
  excluded: '后端超时：日志里请求 200ms 就回来了',
  fix: 'login.ts:44 把 max 换成次数上限常量',
  files: ['web/src/lib/login.ts'],
  risk: '只影响登录重试',
  verify: 'login.test.ts 的超时用例改前失败、改后通过',
  answers: [],
  level: 'quick',
  attribution: {
    category: 'recent',
    change: 'a1b2c3',
    author: '张三',
    date: '2026-10-30',
    title: '重试改成按秒',
    how: 'blame',
  },
  rating: { tier: 'low', percent: 95, why: '写错了常量名' },
  phase: 'cause',
  ...over,
})
let n = 0
const id = () => `id${++n}`
const bugTask = () =>
  ({ bug: { kind: 'report', diagnoses: [] }, requests: [], messages: [], changes: [] }) as unknown as Task
const ok = (r: { ok: boolean; info?: string; error?: string }) => assert.ok(r.ok, r.info ?? r.error ?? '')
const ask = {
  approve: false,
  notes: [
    { quote: 'max 用的是秒', kind: 'question' as const, comment: '为什么是秒？' },
    { quote: '', kind: 'info' as const, comment: '只在弱网下出现' },
  ],
  overall: '',
}

test('提问、补充：不当成否决，要它据此重出一版；对话里写几个问题几条补充', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input(), id))
  const r = decideDiagnosis(tk, 1, { ...ask, intent: 'ask' }, id)
  assert.ok(r.ok)
  assert.doesNotMatch(r.message, /否决|不认同/)
  assert.match(r.message, /没有否定这版结论；据此重新出一版/)
  assert.match(r.message, /补充信息：当成新证据.*重新评估/s)
  assert.match(r.message, /stance: used/)
  assert.equal(tk.bug!.diagnoses![0].intent, 'ask')
  assert.match(tk.messages.at(-1)!.text, /你对第 1 版的根因提了1 个问题、1 条补充，要它据此出新一版/)
})

test('不传意图：根因页算提问（验证页算不认同，见 diagnosis.test.ts「第几版」）', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input(), id))
  ok(decideDiagnosis(tk, 1, ask, id))
  assert.equal(tk.bug!.diagnoses![0].intent, 'ask')
})

test('小版本：按提问重出是 1.1、1.2；不认同后它坚持原结论也是小版本；推翻了才是第 2 版', () => {
  const tk = bugTask()
  const list = () => tk.bug!.diagnoses!
  const last = () => list().at(-1)!
  const answers = [
    { id: 1, answer: '查了 config.ts:8，单位是秒' },
    { id: 2, answer: '弱网下重试更多，正好触发', stance: 'used' },
  ]
  ok(submitDiagnosis(tk, input(), id))
  assert.equal(verOf(last(), list()), '1')
  ok(decideDiagnosis(tk, 1, { ...ask, intent: 'ask' }, id))
  const r = submitDiagnosis(tk, input({ answers }), id)
  ok(r)
  assert.match(r.info, /已交第 1\.1 版的根因/)
  assert.deepEqual(labelOf(last(), list()), { ver: '1.1', round: 1 })
  ok(decideDiagnosis(tk, 2, { ...ask, intent: 'reject' }, id))
  ok(submitDiagnosis(tk, input({ answers }), id))
  assert.equal(verOf(last(), list()), '1.2', '证据够、坚持原根因：还是小版本')
  ok(decideDiagnosis(tk, 3, { ...ask, intent: 'reject' }, id))
  ok(
    submitDiagnosis(
      tk,
      input({
        phase: 'evidence',
        confirmed: false,
        answers,
        rootCause: '假设：重试次数和秒数混用',
        hypotheses: [
          { id: 'H1', text: '单位混用', status: 'open', basis: '代码里 max 来自 config' },
          { id: 'H2', text: '后端超时', status: 'excluded', basis: '日志里请求 200ms 就回来了' },
        ],
        logPlan: [
          {
            id: 'L1',
            file: 'web/src/lib/login.ts:44',
            fn: 'retry',
            print: "console.log('[排查-登录] L1', retries, max)",
            hypothesis: 'H1：单位混用',
          },
          {
            id: 'L2',
            file: 'web/src/lib/login.ts:30',
            fn: 'login',
            print: "console.log('[排查-登录] L2 进入', reqId)",
            hypothesis: '路标',
          },
        ],
        collect: {
          steps: ['打开登录页', '断网后点登录'],
          filter: '[排查-登录]',
          expect: 'max 大于 10 说明是秒',
          outcomes: [
            { see: 'L1 的 max 大于 10', means: 'H1 成立：max 是秒' },
            { see: 'L1 的 max 小于 10', means: 'H1 不成立' },
          ],
        },
      }),
      id,
    ),
  )
  assert.equal(verOf(last(), list()), '2', '回到论证：结论推翻，升大版本')
})

test('报告对比：按小节切开，改了的标出逐行差异，没改的不列行；代码块里的 # 不算标题', () => {
  const a = '## 结论\n根因是秒\n\n## 影响面\n只影响登录\n\n```sh\n## 不是标题\n```'
  const b = '## 结论\n根因是秒和次数混用\n\n## 影响面\n只影响登录\n\n```sh\n## 不是标题\n```\n\n## 证据链\n日志第 12 行'
  assert.deepEqual(
    splitSections(a).map((s) => s.title),
    ['结论', '影响面'],
  )
  const c = compareReports(a, b)
  assert.deepEqual(
    c.map((s) => [s.title, s.state]),
    [
      ['结论', 'changed'],
      ['影响面', 'same'],
      ['证据链', 'added'],
    ],
  )
  assert.deepEqual(
    c[0].lines.filter((l) => l.kind !== 'ctx'),
    [
      { kind: 'del', text: '根因是秒' },
      { kind: 'add', text: '根因是秒和次数混用' },
    ],
  )
  assert.deepEqual(
    compareReports(b, a, ['结论']).map((s) => [s.title, s.state]),
    [
      ['影响面', 'same'],
      ['证据链', 'removed'],
    ],
  )
})

test('结论变没变只按档案字段比：根因、选定方案、文件', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input(), id))
  ok(decideDiagnosis(tk, 1, { ...ask, intent: 'ask' }, id))
  ok(
    submitDiagnosis(
      tk,
      input({
        answers: [
          { id: 1, answer: '是秒' },
          { id: 2, answer: '用上了', stance: 'used' },
        ],
        whatChanged: '补了弱网下的说明',
      }),
      id,
    ),
  )
  const [a, b] = tk.bug!.diagnoses!
  assert.equal(conclusionChanged(a, b), false, '只补说明：结论没变')
  assert.equal(conclusionChanged(a, { ...b, rootCause: '后端慢' }), true)
  assert.equal(conclusionChanged(a, { ...b, files: ['web/src/lib/api.ts'] }), true)
})
