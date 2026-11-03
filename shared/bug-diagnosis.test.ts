import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import {
  decideDiagnosis,
  diagnosisGate,
  diagnosisMarkdown,
  outOfPlan,
  pendingDiagnosis,
  submitDiagnosis,
  type DiagnosisInput,
} from './bug-diagnosis.ts'
import type { Task } from './schema.ts'

/** Bug 先交诊断报告、用户确认了方案再改（ADR 0045） */
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
  ...over,
})
let n = 0
const id = () => `id${++n}`
const bugTask = (over: Partial<Task> = {}) =>
  ({ bug: true, diagnoses: [], requests: [], messages: [], changes: [], ...over }) as unknown as Task

test('交诊断报告：挂成等用户确认的请求，对话里记一条可点开的报告；不是父对话派来的 Bug 不收', () => {
  assert.equal(submitDiagnosis(bugTask({ bug: false }), input(), id).ok, false)
  const tk = bugTask({ changes: [{ path: 'web/src/lib/login.ts' }] as Task['changes'] })
  const r = submitDiagnosis(tk, input(), id)
  assert.ok(r.ok && r.version === 1)
  assert.match(r.info, /结束这一轮.*确认之前不要改任何文件/)
  assert.equal(tk.requests.length, 1)
  assert.equal(tk.requests[0].purpose, 'diagnosis')
  assert.equal(tk.requests[0].version, 1)
  assert.match(tk.requests[0].detail, /## 根因（已证实）\nmax 用的是秒/)
  assert.match(
    tk.requests[0].detail,
    /## 交报告前已改动的文件\n- `web\/src\/lib\/login\.ts`/,
    '确认之前就动了手的要摆出来',
  )
  assert.equal(tk.messages.at(-1)?.bugReport, 1)
  // 还在等确认时再交：不收
  assert.match(submitDiagnosis(tk, input(), id).info, /还在等用户确认/)
})

test('诊断报告缺小节、没写要改的文件：不收，说清缺什么', () => {
  const tk = bugTask()
  assert.match(
    submitDiagnosis(tk, input({ evidence: '', verify: ' ' }), id).info,
    /evidence（证据链）、verify（验证计划）/,
  )
  assert.match(submitDiagnosis(tk, input({ files: [] }), id).info, /files 要写方案里要改的文件/)
  assert.equal(tk.diagnoses?.length, 0)
})

test('用户标疑问：退回的话按编号列出；新一版要逐条回答疑问和改方案，补充信息不用答；上一版作废', () => {
  const tk = bugTask()
  submitDiagnosis(tk, input(), id)
  assert.equal(decideDiagnosis(tk, 1, { approve: false, notes: [], overall: '' }, id).ok, false, '退回要有意见')
  const r = decideDiagnosis(
    tk,
    1,
    {
      approve: false,
      notes: [
        { quote: 'max 用的是秒', kind: 'question', comment: '配置里写的是毫秒吧？' },
        { quote: '', kind: 'info', comment: '上周升级过 axios' },
        { quote: 'login.ts:44', kind: 'change', comment: '顺便把 api.ts 的重试也统一' },
      ],
      overall: '',
    },
    id,
  )
  assert.ok(r.ok)
  assert.match(r.message, /1\. \[疑问\]「max 用的是秒」：配置里写的是毫秒吧？/)
  assert.match(r.message, /2\. \[补充信息\]：上周升级过 axios/)
  assert.match(r.message, /只处理被问到的几条/)
  assert.equal(tk.requests.length, 0, '处理了就收起')
  assert.equal(decideDiagnosis(tk, 1, { approve: true, notes: [], overall: '' }, id).ok, false, '同一版不能处理两次')
  // 新一版漏答第 3 条（改方案）：不收；第 2 条是补充信息，不用答
  assert.match(submitDiagnosis(tk, input({ answers: [{ id: 1, answer: '查了，是秒' }] }), id).info, /还没回答：3/)
  const v2 = submitDiagnosis(
    tk,
    input({
      answers: [
        { id: 1, answer: '查了 config.ts:8，单位是秒' },
        { id: 3, answer: 'api.ts 的重试一起改，加进 files' },
      ],
      files: ['web/src/lib/login.ts', 'web/src/lib/api.ts'],
    }),
    id,
  )
  assert.ok(v2.ok && v2.version === 2)
  assert.equal(tk.diagnoses?.[0].status, 'superseded')
  assert.equal(pendingDiagnosis(tk)?.version, 2)
  assert.match(
    tk.requests[0].detail,
    /## 回答上一版的意见\n1\. \*\*疑问\*\*「max 用的是秒」：配置里写的是毫秒吧？\n {3}- 回答：查了 config\.ts:8/,
  )
})

test('收尾核对：要有用户确认过的最新方案，改动不超出方案里的文件（测试、文档、翻译不算）', () => {
  const tk = bugTask()
  assert.match(diagnosisGate(tk, []), /先用 submit_diagnosis 交诊断报告/)
  submitDiagnosis(tk, input(), id)
  assert.match(diagnosisGate(tk, []), /还在等用户确认/)
  const ok = decideDiagnosis(tk, 1, { approve: true, notes: [], overall: '先别动 UI' }, id)
  assert.ok(ok.ok)
  assert.match(ok.message, /只改方案里的文件：`web\/src\/lib\/login\.ts`/)
  assert.match(ok.message, /整体意见：先别动 UI/)
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/lib/login.test.ts', 'docs/x.md']), '')
  assert.match(
    diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/App.tsx']),
    /不在用户确认的方案（第 1 版）里：web\/src\/App\.tsx/,
  )
  assert.equal(diagnosisGate({ bug: false }, ['any.ts']), '', '不是 Bug 子对话不核对')
  assert.deepEqual(outOfPlan(['./src/a/b.ts', 'src/c.ts'], ['src/a/']), ['src/c.ts'], '方案写目录时目录下的都算')
})

test('报告渲染：根因没证实要标出来，空的小节不写', () => {
  const md = diagnosisMarkdown({
    ...input({ confirmed: false, risk: '' }),
    version: 1,
    at: '',
    status: 'pending',
    notes: [],
    overall: '',
    before: [],
  })
  assert.match(md, /## 根因（假设，还没证实）/)
  assert.doesNotMatch(md, /影响和风险|交报告前已改动/)
})
