import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import {
  approvedBrief,
  bugRecordDraft,
  bugStage,
  decideDiagnosis,
  diagnosisGate,
  diagnosisMarkdown,
  outOfPlan,
  pendingDiagnosis,
  submitDiagnosis,
  updateBugCase,
  type DiagnosisInput,
} from './bug-diagnosis.ts'
import { Diagnosis } from './bug-diagnosis-schema.ts'
import type { Task } from './schema.ts'
import { childWait, convState, diagnosisPending } from './task.ts'

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
  // 快速级别（ADR 0046）：堆栈直达、改一个文件，不要求候选方案和变更时间线；归因照样要写
  level: 'quick',
  attribution: {
    category: 'recent',
    change: 'a1b2c3',
    author: '张三',
    date: '2026-10-30',
    title: '重试改成按秒',
    how: 'blame',
  },
  ...over,
})
let n = 0
const id = () => `id${++n}`
/** 修完的结果：收尾时按它核对回归测试和影响面（ADR 0046） */
const done = (tk: Task, impact: string[] = []) =>
  updateBugCase(tk, {
    result: {
      reproBefore: '超时用例失败',
      reproAfter: '通过',
      regressionTests: ['web/src/lib/login.test.ts'],
      impactChecks: impact.map((area) => ({ area, command: 'npm test', output: '通过' })),
    },
  })
const bugTask = (over: Partial<Task> = {}) =>
  ({ bug: true, diagnoses: [], requests: [], messages: [], changes: [], ...over }) as unknown as Task

test('交诊断报告：记成等用户确认的一版，对话算执行中（不是等你处理的请求）；不是父对话派来的 Bug 不收', () => {
  assert.equal(submitDiagnosis(bugTask({ bug: false }), input(), id).ok, false)
  const tk = bugTask({ changes: [{ path: 'web/src/lib/login.ts' }] as Task['changes'] })
  const r = submitDiagnosis(tk, input(), id)
  assert.ok(r.ok && r.version === 1)
  assert.match(r.info, /结束这一轮.*确认之前不要改任何文件/)
  assert.equal(tk.requests.length, 0, '不挂成等你处理的请求：用户要的是子对话还在转圈')
  assert.equal(pendingDiagnosis(tk)?.version, 1)
  assert.ok(diagnosisPending(tk))
  assert.equal(convState({ status: 'done', diagnosis: diagnosisPending(tk) }), 'running', '等确认期间算执行中')
  // 用户停下了：报告还在等确认，但对话不再算在跑（停止按钮点了要有变化，用户报过）
  assert.equal(convState({ status: 'stopped', stopReason: 'user', diagnosis: true }), 'stopped')
  assert.deepEqual(childWait({ ...tk, status: 'done', working: false, steps: [], parentAsks: [] } as Task), {
    kind: 'diagnosis',
    version: 1,
  })
  const md = diagnosisMarkdown(tk.diagnoses![0])
  assert.match(md, /## 根因（已证实）\nmax 用的是秒/)
  assert.match(md, /## 交报告前已改动的文件\n- `web\/src\/lib\/login\.ts`/, '确认之前就动了手的要摆出来')
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
  assert.ok(!diagnosisPending(tk), '处理了就不再算等确认')
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
    diagnosisMarkdown(tk.diagnoses![1], tk.diagnoses![0]),
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
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /result 记下修完的结果/, '修完要记结果')
  assert.ok(done(tk).ok)
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/lib/login.test.ts', 'docs/x.md']), '')
  assert.match(
    diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/App.tsx']),
    /不在用户确认的方案（第 1 版）里：web\/src\/App\.tsx/,
  )
  assert.equal(diagnosisGate({ bug: false }, ['any.ts']), '', '不是 Bug 子对话不核对')
  assert.deepEqual(outOfPlan(['./src/a/b.ts', 'src/c.ts'], ['src/a/']), ['src/c.ts'], '方案写目录时目录下的都算')
})

test('报告渲染：根因没证实要标出来，空的小节不写', () => {
  const md = diagnosisMarkdown(
    Diagnosis.parse({ ...input({ confirmed: false, risk: '' }), version: 1, at: '', status: 'pending' }),
  )
  assert.match(md, /## 根因（假设，还没证实）/)
  assert.doesNotMatch(md, /影响和风险|交报告前已改动/)
})

const standard = (over: Partial<DiagnosisInput> = {}) =>
  input({
    level: 'standard',
    stack: [{ file: 'web/src/lib/login.ts', line: 40, fn: 'retry', note: '按 max 判断要不要重试' }],
    timeline: [
      { at: '2026-10-30', source: 'a1b2c3', kind: 'change', text: '重试上限改成按秒', abnormal: true },
      { at: '10:02:01', source: 'login.ts:44', kind: 'event', text: 'retry 3' },
    ],
    consistency: [{ observation: '只在超时时出现', explanation: '只有超时分支走重试' }],
    impact: [
      { area: '登录重试', effect: '上限改成次数', verify: 'login.test.ts' },
      { area: '接口重试', effect: '共用常量', verify: 'api.test.ts' },
    ],
    options: [
      {
        id: 'A',
        title: '改成次数常量',
        change: 'login.ts:44',
        files: ['web/src/lib/login.ts'],
        covers: '登录',
        misses: '接口重试',
      },
      {
        id: 'B',
        title: '统一重试工具',
        change: '抽到 retry.ts',
        files: ['web/src/lib/retry.ts'],
        covers: '登录和接口',
      },
    ],
    chosen: { id: 'A', why: '改动最小、一处就修全登录', whyNotOthers: 'B 要动接口层，超出这次的问题' },
    ...over,
  })

test('按级别检查（ADR 0046）：标准级别要变更时间线、一致性、影响面、两个方案和选定理由；缺什么说清，可以降级', () => {
  const tk = bugTask()
  const bad = submitDiagnosis(tk, input({ level: 'standard' }), id).info
  assert.match(bad, /标准级别的诊断报告还缺：.*kind: change.*consistency.*impact.*options 至少两个/)
  assert.match(bad, /level 降成 quick 并在 levelNote 写理由/)
  assert.match(
    submitDiagnosis(tk, standard({ chosen: { id: 'C', why: 'x', whyNotOthers: 'y' } }), id).info,
    /chosen\.id 要对上/,
  )
  assert.match(submitDiagnosis(tk, standard({ level: 'deep' }), id).info, /hypotheses 至少两个假设/)
  assert.match(
    submitDiagnosis(tk, input({ attribution: undefined }), id).info,
    /attribution 要写版本归因/,
    '找到根因就要写引入点；查不到写 unknown 加说明',
  )
  assert.ok(
    submitDiagnosis(tk, input({ attribution: { category: 'unknown', how: 'none', note: '仓库没有历史' } }), id).ok,
  )
})

test('档案草稿：随查随记、按阶段提示还缺什么，交报告时自动带上；不是用户报的 Bug 不收', () => {
  assert.equal(updateBugCase(bugTask({ bug: false }), { symptom: 'x' }).ok, false)
  const tk = bugTask()
  assert.equal(bugStage(tk), '立案')
  assert.equal(updateBugCase(tk, {}).ok, false, '没写字段要说清能写什么')
  const r1 = updateBugCase(tk, { symptom: '登录转圈', stack: standard().stack, level: 'standard' })
  assert.ok(r1.ok)
  assert.match(r1.info, /已记进档案：symptom、level、stack。现在在「定位」/)
  assert.match(r1.info, /交诊断报告前还要补/)
  updateBugCase(tk, { timeline: standard().timeline })
  assert.equal(bugStage(tk), '时间线')
  // 交报告只补还没记的：草稿里的调用栈、时间线自动带上
  const { stack: _s, timeline: _t, level: _l, ...rest } = standard()
  const r = submitDiagnosis(tk, rest, id)
  assert.ok(r.ok, r.info)
  const d = tk.diagnoses![0]
  assert.equal(d.stack.length, 1)
  assert.equal(d.timeline.length, 2)
  assert.equal(d.level, 'standard')
  assert.equal(bugStage(tk), '等你确认')
  const md = diagnosisMarkdown(d)
  assert.match(md, /## 时间线\n\| 时间 \| 类别 \| 来源 \| 内容 \|/)
  assert.match(md, /\*\*异常\*\* 重试上限改成按秒/)
  assert.match(md, /## 引入点\n引入于 `a1b2c3`《重试改成按秒》（张三，2026-10-30）/)
  assert.doesNotMatch(diagnosisMarkdown(d, undefined, { author: false }), /张三/, '设置里关掉作者只写提交号')
  assert.match(md, /### 方案 A：改成次数常量（选定）/)
  assert.match(md, /\*\*为什么不选别的\*\*：B 要动接口层/)
})

test('收尾：影响面每一条都要有验证记录，回归测试要记下', () => {
  const tk = bugTask()
  assert.ok(submitDiagnosis(tk, standard(), id).ok)
  assert.ok(decideDiagnosis(tk, 1, { approve: true, notes: [], overall: '' }, id).ok)
  assert.equal(bugStage(tk), '修复')
  done(tk, ['登录重试'])
  assert.equal(bugStage(tk), '收尾')
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /这些影响面还没有验证记录：接口重试/)
  done(tk, ['登录重试', ' 接口 重试 '])
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts']), '', '影响面按名字对，忽略空白')
})

test('评审对照和 Bug 记录草稿（ADR 0046）：只取用户确认过的那一版', () => {
  const tk = bugTask({ title: '登录超时后一直转圈' } as Partial<Task>)
  assert.equal(approvedBrief(tk), '')
  assert.ok(submitDiagnosis(tk, standard(), id).ok)
  assert.equal(approvedBrief(tk), '', '还没确认的不给评审')
  assert.equal(bugRecordDraft(tk), '')
  decideDiagnosis(tk, 1, { approve: true, notes: [], overall: '' }, id)
  const brief = approvedBrief(tk)
  assert.match(brief, /## 用户确认的诊断报告（第 1 版）/)
  assert.match(brief, /选定方案 A：改成次数常量——login\.ts:44/)
  assert.match(brief, /  - 接口重试：共用常量（验证：api\.test\.ts）/)
  done(tk, ['登录重试', '接口重试'])
  const rec = bugRecordDraft(tk)
  assert.match(rec, /^# 登录超时后一直转圈\n\n- 状态：已修复（web\/src\/lib\/login\.test\.ts）/)
  assert.match(rec, /- 入口：`web\/src\/lib\/login\.ts:40` retry/)
  assert.match(rec, /- 引入：a1b2c3 《重试改成按秒》 2026-10-30（recent，blame）/)
  assert.match(rec, /\n\n## 修复\n\n改成次数常量：login\.ts:44/)
  assert.match(rec, /- 接口重试：npm test → 通过/)
})
