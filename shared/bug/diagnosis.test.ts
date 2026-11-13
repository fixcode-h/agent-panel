import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import {
  approvedBrief,
  bugRecordDraft,
  bugStage,
  decideDiagnosis,
  diagnosisGate,
  pendingDiagnosis,
  requestLogs,
  settleCleanup,
  submitDiagnosis,
  updateBugCase,
  type DiagnosisInput,
} from './diagnosis.ts'
import { diagnosisMarkdown } from './diagnosis-md.ts'
import { outOfPlan, editScope } from './phase.ts'
import { Diagnosis } from './diagnosis-schema.ts'
import type { Task } from '../schema.ts'
import { childWait, childFlowOf, convState, diagnosisPending } from '../task.ts'
import { applyPlan, openPlan } from '../plan.ts'

/** Bug 先交诊断报告、用户确认了再往下走（ADR 0045）；按阶段走：论证 → 根因 → 修复方案 → 验证（用户 2026-11-05 定的） */
setLang('zh')

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  symptom: '登录超时后一直转圈',
  repro: 'npm test -- login.test.ts：超时用例失败',
  location: 'web/src/lib/login.ts:40 retry → api.ts:12 fetch',
  // 调用栈树（设计稿 2026-11-13）：根因、方案这一版必须有入口和出错点
  stack: [
    { id: 'S1', file: 'web/src/lib/login.ts', line: 40, fn: 'retry', note: '按 max 判断要不要重试' },
    {
      id: 'S2',
      parent: 'S1',
      role: 'fault',
      file: 'web/src/lib/login.ts',
      line: 44,
      fn: 'retries < max',
      cond: { text: 'retries < max', took: '一直为真' },
    },
  ],
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
  rating: { tier: 'low', percent: 95, why: '写错了常量名' },
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
  ({ bug: { kind: 'report', diagnoses: [] }, requests: [], messages: [], changes: [], ...over }) as unknown as Task

const ok = (r: { ok: boolean; info?: string; error?: string }) => assert.ok(r.ok, r.info ?? r.error ?? '')
const yes = { approve: true, notes: [], overall: '' }
/** 用户同意根因：后面就能交修复方案 */
const agreeCause = (tk: Task, over: Partial<DiagnosisInput> = {}) => {
  ok(submitDiagnosis(tk, input({ phase: 'cause', ...over }), id))
  ok(decideDiagnosis(tk, pendingDiagnosis(tk)!.version, yes, id))
}
/** 根因同意、方案确认：后面就能修和交验证 */
const approvePlan = (tk: Task, plan: Partial<DiagnosisInput> = {}, cause: Partial<DiagnosisInput> = {}) => {
  agreeCause(tk, cause)
  ok(submitDiagnosis(tk, input({ phase: 'plan', ...plan }), id))
  ok(decideDiagnosis(tk, pendingDiagnosis(tk)!.version, yes, id))
}
/** 修完交修复（用户 2026-11-10 定）：changes 每个文件写改了什么、为什么 */
const fixInput = (over: Partial<DiagnosisInput> = {}) =>
  input({
    phase: 'fix',
    changes: [
      { file: 'web/src/lib/login.ts', what: 'max 换成次数上限常量', why: 'retries 按次数累加，上限也要按次数' },
    ],
    ...over,
  })
/** 交修复、用户看过代码确认：后面就能交验证 */
const approveFix = (tk: Task) => {
  ok(submitDiagnosis(tk, fixInput(), id))
  ok(decideDiagnosis(tk, pendingDiagnosis(tk)!.version, yes, id))
}
const verifyInput = (over: Partial<DiagnosisInput> = {}) =>
  input({ phase: 'verify', collect: { steps: ['登录一次，等超时'], expect: '超时后提示重试，不再转圈' }, ...over })
const evidenceInput = (over: Partial<DiagnosisInput> = {}) =>
  input({
    phase: 'evidence',
    confirmed: false,
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
        { see: 'L1 的 max 小于等于 10', means: 'H1 排除，看路标 L2 停在哪' },
      ],
    },
    files: [],
    ...over,
  })

test('交诊断报告：记成等用户确认的一版，对话算执行中（不是等你处理的请求）；不是父对话派来的 Bug 不收', () => {
  assert.equal(submitDiagnosis(bugTask({ bug: undefined }), input(), id).ok, false)
  const tk = bugTask({ changes: [{ path: 'web/src/lib/login.ts' }] as Task['changes'] })
  const r = submitDiagnosis(tk, input(), id)
  assert.ok(r.ok && r.version === 1)
  assert.equal(tk.bug!.diagnoses![0].phase, 'cause', '根因证实了、还没同意过：没写 phase 时按根因收')
  assert.match(r.info, /结束这一轮.*用户回复之前不要改任何文件/)
  assert.equal(tk.requests.length, 0, '不挂成等你处理的请求：用户要的是子对话还在转圈')
  assert.equal(pendingDiagnosis(tk)?.version, 1)
  assert.ok(diagnosisPending(tk))
  assert.equal(convState({ status: 'done', diagnosis: diagnosisPending(tk) }), 'running', '等确认期间算执行中')
  // 用户停下了：报告还在等确认，但对话不再算在跑（停止按钮点了要有变化，用户报过）
  assert.equal(convState({ status: 'stopped', stopReason: 'user', diagnosis: true }), 'stopped')
  assert.deepEqual(childWait({ ...tk, status: 'done', working: false, steps: [], parentAsks: [] } as Task), {
    kind: 'diagnosis',
    version: 1,
    rev: 1,
  })
  const md = diagnosisMarkdown(tk.bug!.diagnoses![0])
  assert.match(md, /## 根因（已证实）\nmax 用的是秒/)
  assert.match(
    md,
    /## 交报告前已改动的文件\n> \[!CAUTION\]\n> 这些文件不在你同意过的范围里：\n> - `web\/src\/lib\/login\.ts`/,
    '确认之前就动了手的要摆出来，用警告框',
  )
  // 还在等确认时再交：不收
  assert.match(submitDiagnosis(tk, input(), id).info, /还在等用户确认/)
})

test('各阶段缺小节、没写要改的文件：不收，说清缺什么；方案要先有用户同意的根因', () => {
  const tk = bugTask()
  assert.match(submitDiagnosis(tk, input({ evidence: '' }), id).info, /根因这一版缺这些小节：evidence（证据链）/)
  assert.match(
    submitDiagnosis(tk, input({ phase: 'cause', confirmed: false }), id).info,
    /根因还没证实.*交 phase: evidence/,
  )
  assert.match(submitDiagnosis(tk, input({ phase: 'plan', level: 'standard' }), id).info, /还没有用户同意的根因/)
  assert.match(
    submitDiagnosis(tk, input({ phase: 'plan', confirmed: false }), id).info,
    /快速级别把根因和修复方案合成一版交，根因那一节也要齐：根因还没证实/,
  )
  assert.match(submitDiagnosis(tk, input({ phase: 'verify' }), id).info, /还没有用户确认的修复方案/)
  assert.equal(tk.bug?.diagnoses?.length, 0)
  agreeCause(tk)
  assert.match(submitDiagnosis(tk, input({ verify: ' ' }), id).info, /修复方案缺这些小节：verify（验证计划）/)
  assert.match(submitDiagnosis(tk, input({ files: [] }), id).info, /files 要写方案里要改的文件/)
  ok(submitDiagnosis(tk, input(), id))
  assert.equal(tk.bug!.diagnoses!.at(-1)!.phase, 'plan', '根因同意过：没写 phase 时按修复方案收')
})

test('论证：要日志计划和每种结果说明什么；同意后只放行日志计划里的文件，复现不了请用户复现，贴了日志交给它分析，可以多轮', () => {
  const tk = bugTask()
  assert.match(
    submitDiagnosis(tk, evidenceInput({ logPlan: undefined, collect: undefined }), id).info,
    /logPlan.*collect\.steps/,
  )
  ok(submitDiagnosis(tk, evidenceInput(), id))
  const d = tk.bug!.diagnoses![0]
  assert.deepEqual(d.files, ['web/src/lib/login.ts'], '日志计划里的位置去掉行号算进放行范围')
  assert.match(diagnosisMarkdown(d), /## 日志计划\n\| 编号 \| 位置/)
  assert.match(diagnosisMarkdown(d), /## 结果怎么判\n\| 看到 \| 说明 \|[^]*L1 的 max 大于 10 \| H1 成立/)
  assert.ok('deny' in editScope(tk.bug!.diagnoses!), '等用户同意时不改文件')
  assert.equal(requestLogs(tk, { added: ['L1'] }).ok, false, '还没同意加日志不能请复现')
  const r = decideDiagnosis(tk, 1, yes, id)
  assert.ok(r.ok)
  assert.match(r.message, /只在日志计划里的文件加.*\[排查-<主题>\].*request_logs/s)
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['web/src/lib/login.ts'] })
  assert.match(tk.messages.at(-1)!.text, /你同意了第 1 版的日志计划/)
  assert.equal(bugStage(tk), '论证 · 第 1 轮')
  // 加好日志、自己复现不了：请用户复现，同一版回到等用户
  assert.equal(requestLogs(tk, { added: [] }).ok, false, '要写加了哪几处')
  const rl = requestLogs(tk, { added: ['L1 web/src/lib/login.ts:44'] })
  assert.ok(rl.ok)
  assert.match(rl.info, /第 1 版/, '对话里那一行能认出是哪一版')
  assert.ok(diagnosisPending(tk) && tk.bug!.diagnoses![0].awaiting)
  assert.equal(bugStage(tk), '等你复现')
  assert.match(diagnosisMarkdown(tk.bug!.diagnoses![0]), /## 加好的日志\n- L1 `web\/src\/lib\/login\.ts:44`/)
  assert.match(submitDiagnosis(tk, evidenceInput(), id).info, /在等用户复现贴日志/)
  // 用户贴日志：交给它分析
  assert.equal(decideDiagnosis(tk, 1, { ...yes, approve: false, supply: true }, id).ok, false, '要有日志')
  const sup = decideDiagnosis(
    tk,
    1,
    {
      approve: false,
      supply: true,
      logs: '[排查-登录] retries=3 max=30',
      logFiles: ['app.log'],
      notes: [],
      overall: '',
    },
    id,
  )
  assert.ok(sup.ok)
  assert.equal(tk.bug!.diagnoses![0].status, 'answered')
  assert.match(sup.message, /只分析这一段.*交 phase: cause.*再交一轮 phase: evidence/s)
  assert.match(sup.message, /retries=3 max=30/)
  assert.match(sup.message, /app\.log/)
  assert.match(diagnosisMarkdown(tk.bug!.diagnoses![0]), /## 你贴的日志/)
  assert.ok('deny' in editScope(tk.bug!.diagnoses!), '给了日志先分析，不改文件')
  // 还没定论：第二轮论证（新的日志计划），之后证实了再交根因
  assert.match(submitDiagnosis(tk, evidenceInput({ logPlan: undefined }), id).info, /logPlan/, '每轮要写这一轮的日志')
  assert.match(submitDiagnosis(tk, evidenceInput(), id).info, /next（又一轮论证/, '再加一轮要写清上一轮为什么没定论')
  ok(
    submitDiagnosis(
      tk,
      evidenceInput({ next: '路标停在 api.ts，retries=3 max=30：H1 待定，新怀疑重试计数被重置' }),
      id,
    ),
  )
  assert.equal(tk.bug!.diagnoses![0].status, 'answered', '用户做过的事留着，不改成作废')
  // 面板取日志：引用日志文件、写明从第几行看，不当成贴的日志包进代码块，命中表也不数这句话
  const ref = bugTask()
  ok(submitDiagnosis(ref, evidenceInput(), id))
  ok(decideDiagnosis(ref, 1, { ...yes, approve: true }, id))
  ok(requestLogs(ref, { added: ['L1 web/src/lib/login.ts:44'] }))
  const line = '@/home/me/app.log 从第 412 行往后看：这是复现期间新增的日志（第 412–431 行）。'
  const viaRef = decideDiagnosis(
    ref,
    1,
    { approve: false, supply: true, logs: line, logFiles: ['/home/me/app.log'], notes: [], overall: '' },
    id,
  )
  assert.ok(viaRef.ok)
  assert.ok(!viaRef.message.includes('用户贴的日志'), '不是贴的日志')
  assert.match(viaRef.message, /从第 412 行往后看/)
  assert.match(viaRef.message, /用工具读/)
  const md = diagnosisMarkdown(ref.bug!.diagnoses![0])
  assert.ok(!md.includes('日志计划命中'), '没有日志正文就不出命中表')
  assert.match(md, /`\/home\/me\/app\.log`/)
  ok(decideDiagnosis(tk, 2, { approve: false, supply: true, logs: 'max=30', notes: [], overall: '' }, id))
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  assert.equal(tk.bug!.diagnoses![2].logPlan.length, 0, '根因那一版不带上一轮的日志计划')
})

test('根因：用户否决时可以回到论证；同意了才能交方案，交方案前不改文件', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  const r = decideDiagnosis(
    tk,
    1,
    { approve: false, notes: [{ quote: 'max 用的是秒', kind: 'question', comment: '日志没证明这点' }], overall: '' },
    id,
  )
  assert.ok(r.ok)
  assert.match(r.message, /否决了这版根因.*回到论证.*phase: evidence/s)
  assert.match(tk.messages.at(-1)!.text, /你对第 1 版的根因提了 1 条意见/)
  ok(submitDiagnosis(tk, evidenceInput({ answers: [{ id: 1, answer: '证据确实不够，先加日志' }] }), id))
  assert.equal(tk.bug!.diagnoses![0].status, 'superseded')
  ok(decideDiagnosis(tk, 2, { approve: false, supply: true, logs: 'max=30', notes: [], overall: '' }, id))
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  const agreed = decideDiagnosis(tk, 3, yes, id)
  assert.ok(agreed.ok)
  assert.match(agreed.message, /交 phase: plan.*正式日志/s)
  assert.match(JSON.stringify(editScope(tk.bug!.diagnoses!)), /先交 phase: plan/)
  assert.equal(bugStage(tk), '修复设计')
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
  assert.equal(decideDiagnosis(tk, 1, yes, id).ok, false, '同一版不能处理两次')
  // 新一版漏答第 3 条（改方案）：不收；第 2 条是补充信息，不用答
  assert.match(submitDiagnosis(tk, input({ answers: [{ id: 1, answer: '查了，是秒' }] }), id).info, /还没回答：3/)
  const v2 = submitDiagnosis(
    tk,
    input({
      answers: [
        { id: 1, answer: '查了 config.ts:8，单位是秒' },
        { id: 3, answer: 'api.ts 的重试一起改，加进 files' },
      ],
    }),
    id,
  )
  assert.ok(v2.ok && v2.version === 2)
  assert.equal(tk.bug?.diagnoses?.[0].status, 'superseded')
  assert.equal(pendingDiagnosis(tk)?.version, 2)
  assert.match(
    diagnosisMarkdown(tk.bug!.diagnoses![1], tk.bug!.diagnoses![0]),
    /## 回答你的意见\n1\. \*\*疑问\*\*「max 用的是秒」：配置里写的是毫秒吧？\n {3}- 回答：查了 `config\.ts:8`/,
  )
})

test('确认时写的标注也交给它（以前只带整体意见）', () => {
  const tk = bugTask()
  agreeCause(tk)
  ok(submitDiagnosis(tk, input(), id))
  const r = decideDiagnosis(
    tk,
    2,
    { approve: true, notes: [{ quote: '', kind: 'info', comment: '只在 Windows 上出现过' }], overall: '' },
    id,
  )
  assert.ok(r.ok)
  assert.match(r.message, /用户的标注：\n1\. \[补充信息\]：只在 Windows 上出现过/)
})

test('收尾核对：要有确认过的方案、交过验证且用户给了结果或点了结束，改动不超出方案里的文件（测试、文档、翻译不算）', () => {
  const tk = bugTask()
  assert.match(diagnosisGate(tk, []), /先用 submit_diagnosis 交报告/)
  submitDiagnosis(tk, input(), id)
  assert.match(diagnosisGate(tk, []), /还在等用户/)
  ok(decideDiagnosis(tk, 1, yes, id))
  assert.match(diagnosisGate(tk, []), /还没有用户确认的修复方案/)
  ok(submitDiagnosis(tk, input(), id))
  const ok2 = decideDiagnosis(tk, 2, { approve: true, notes: [], overall: '先别动 UI' }, id)
  assert.ok(ok2.ok)
  assert.match(ok2.message, /只改方案里的文件：`web\/src\/lib\/login\.ts`/)
  assert.match(ok2.message, /整体意见：先别动 UI/)
  assert.match(ok2.message, /交 phase: fix/)
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['web/src/lib/login.ts'] })
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /交 phase: fix/, '修完要先请用户看代码')
  assert.match(submitDiagnosis(tk, verifyInput(), id).info, /先交 phase: fix/, '没确认修复不能交验证')
  approveFix(tk)
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /交 phase: verify/, '确认修复后要验证')
  assert.match(submitDiagnosis(tk, verifyInput(), id).info, /result 记下修完的结果/, '交验证前要记结果')
  ok(done(tk))
  ok(submitDiagnosis(tk, verifyInput(), id))
  assert.equal(bugStage(tk), '等你验证')
  assert.match(diagnosisMarkdown(tk.bug!.diagnoses![3]), /## 你来验证\n1\. 登录一次，等超时/)
  assert.match(diagnosisMarkdown(tk.bug!.diagnoses![3]), /## 自测结果/)
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /还在等用户/)
  const r = decideDiagnosis(tk, 4, { approve: false, supply: true, logs: '提示重试', notes: [], overall: '' }, id)
  assert.ok(r.ok)
  assert.match(r.message, /没问题.*\[排查-.*正式日志.*submit_merge/s)
  assert.equal(bugStage(tk), '收尾')
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/lib/login.test.ts', 'docs/x.md']), '')
  assert.match(
    diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/App.tsx']),
    /不在用户确认的方案（第 1 版）里：web\/src\/App\.tsx/,
  )
  assert.equal(diagnosisGate({}, ['any.ts']), '', '不是 Bug 子对话不核对')
  assert.deepEqual(outOfPlan(['./src/a/b.ts', 'src/c.ts'], ['src/a/']), ['src/c.ts'], '方案写目录时目录下的都算')
})

test('验证：用户可以直接点结束跳过验证；论证时加过日志的文件修完时能改（删临时日志）', () => {
  const tk = bugTask()
  ok(
    submitDiagnosis(
      tk,
      evidenceInput({
        logPlan: [
          { id: 'L1', file: 'web/src/lib/api.ts', print: "console.log('[排查-登录] L1', status)", hypothesis: 'H1' },
        ],
      }),
      id,
    ),
  )
  ok(decideDiagnosis(tk, 1, yes, id))
  approvePlan(tk)
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['web/src/lib/login.ts', 'web/src/lib/api.ts'] })
  approveFix(tk)
  ok(done(tk))
  ok(submitDiagnosis(tk, verifyInput(), id))
  const r = decideDiagnosis(tk, 5, yes, id)
  assert.ok(r.ok)
  assert.match(r.message, /点了结束，跳过验证.*\[排查-.*正式日志.*submit_merge/s)
  assert.match(tk.messages.at(-1)!.text, /你结束了第 1 版的验证/)
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts', 'web/src/lib/api.ts']), '')
})

test('报告渲染：根因没证实要标出来，空的小节不写', () => {
  const md = diagnosisMarkdown(
    Diagnosis.parse({ ...input({ confirmed: false, risk: '' }), version: 1, at: '', status: 'pending' }),
  )
  // 论证这一步根因还只是假设：放在收起的「依据和背景」里，标明没证实；级别是决策卡上的胶囊
  assert.match(md, /### 根因（假设，还没证实）\nmax 用的是秒/)
  assert.match(md, /根因未证实/)
  assert.doesNotMatch(md, /^## 根因|## 级别|影响和风险|交报告前已改动/m)
})

const standard = (over: Partial<DiagnosisInput> = {}) =>
  input({
    level: 'standard',
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

test('按级别检查（ADR 0046）：标准级别的根因要变更时间线、一致性，方案要影响面、两个方案和选定理由；缺什么说清，可以降级', () => {
  const tk = bugTask()
  const bad = submitDiagnosis(tk, input({ level: 'standard' }), id).info
  assert.match(bad, /标准级别的根因还缺：.*kind: change.*consistency/)
  assert.match(bad, /level 降成 quick 并在 levelNote 写理由/)
  assert.match(submitDiagnosis(tk, standard({ level: 'deep' }), id).info, /hypotheses 至少两个假设/)
  assert.match(
    submitDiagnosis(tk, input({ attribution: undefined }), id).info,
    /attribution 要写版本归因/,
    '找到根因就要写引入点；查不到写 unknown 加说明',
  )
  // 根因评级、提交人（用户 2026-11-10）：等级和把握必填；责任在某次代码改动上的要给出提交或提交人
  assert.match(submitDiagnosis(tk, standard({ rating: undefined }), id).info, /rating 要写根因评级/)
  assert.match(
    submitDiagnosis(tk, standard({ attribution: { category: 'recent', how: 'blame' } }), id).info,
    /要写引入的那次提交.*提交人/,
  )
  ok(submitDiagnosis(tk, standard({ attribution: { category: 'unknown', how: 'none', note: '仓库没有历史' } }), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  // 根因是快速级别同意的、方案升到标准：档案里还没有影响面和候选方案
  const tk2 = bugTask()
  agreeCause(tk2)
  assert.match(
    submitDiagnosis(tk2, input({ level: 'standard' }), id).info,
    /标准级别的修复方案还缺：.*impact.*options 至少两个/,
  )
  assert.match(
    submitDiagnosis(tk, standard({ chosen: { id: 'C', why: 'x', whyNotOthers: 'y' } }), id).info,
    /chosen\.id 要对上/,
  )
  ok(submitDiagnosis(tk, standard(), id))
})

test('档案草稿：随查随记、按阶段提示还缺什么，交报告时自动带上；不是用户报的 Bug 不收', () => {
  assert.equal(updateBugCase(bugTask({ bug: undefined }), { symptom: 'x' }).ok, false)
  const tk = bugTask()
  assert.equal(bugStage(tk), '立案')
  assert.equal(updateBugCase(tk, {}).ok, false, '没写字段要说清能写什么')
  const r1 = updateBugCase(tk, { symptom: '登录转圈', stack: standard().stack, level: 'standard' })
  assert.ok(r1.ok)
  assert.match(r1.info, /已记进档案：symptom、level、stack。现在在「定位」/)
  assert.match(r1.info, /下一版是「论证」，交之前还要补/)
  updateBugCase(tk, { timeline: standard().timeline })
  assert.equal(bugStage(tk), '时间线')
  // 交报告只补还没记的：草稿里的调用栈、时间线自动带上
  const { stack: _s, timeline: _t, level: _l, ...rest } = standard()
  const r = submitDiagnosis(tk, rest, id)
  assert.ok(r.ok, r.info)
  const d = tk.bug!.diagnoses![0]
  assert.equal(d.stack.length, 2)
  assert.equal(d.timeline.length, 2)
  assert.equal(d.level, 'standard')
  assert.equal(bugStage(tk), '等你确认')
  const md = diagnosisMarkdown(d)
  assert.match(md, /## 时间线\n\| 时间 \| 类别 \| 来源 \| 内容 \|/)
  assert.match(md, /\*\*异常\*\* 重试上限改成按秒/)
  assert.match(md, /## 引入点\n引入于 `a1b2c3`《重试改成按秒》（张三，2026-10-30）/)
  assert.doesNotMatch(diagnosisMarkdown(d, undefined, { author: false }), /张三/, '设置里关掉作者只写提交号')
  assert.doesNotMatch(md, /### 方案 A/, '根因那一版不摆候选方案')
  ok(decideDiagnosis(tk, 1, yes, id))
  ok(submitDiagnosis(tk, {}, id))
  const plan = diagnosisMarkdown(tk.bug!.diagnoses![1])
  // 候选方案并排成一张表：一列一个方案
  assert.match(plan, /\|  \| 方案 A（选定） \| 方案 B \|/)
  assert.match(plan, /\| \*\*做法\*\* \| 改成次数常量 \|/)
  assert.match(plan, /\*\*为什么不选别的\*\*：B 要动接口层/)
})

test('收尾：影响面每一条都要有验证记录，回归测试要记下', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, standard(), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  ok(submitDiagnosis(tk, standard(), id))
  ok(decideDiagnosis(tk, 2, yes, id))
  assert.equal(bugStage(tk), '修复')
  approveFix(tk)
  assert.equal(bugStage(tk), '验证')
  done(tk, ['登录重试'])
  ok(submitDiagnosis(tk, verifyInput(), id))
  ok(decideDiagnosis(tk, 4, yes, id))
  assert.equal(bugStage(tk), '收尾')
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /这些影响面还没有验证记录：接口重试/)
  done(tk, ['登录重试', ' 接口 重试 '])
  assert.equal(diagnosisGate(tk, ['web/src/lib/login.ts']), '', '影响面按名字对，忽略空白')
})

test('评审对照和 Bug 记录草稿（ADR 0046）：只取用户确认过的修复方案', () => {
  const tk = bugTask({ title: '登录超时后一直转圈' } as Partial<Task>)
  assert.equal(approvedBrief(tk), '')
  ok(submitDiagnosis(tk, standard(), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  assert.equal(approvedBrief(tk), '', '只同意了根因、还没确认方案的不给评审')
  ok(submitDiagnosis(tk, standard(), id))
  assert.equal(bugRecordDraft(tk), '')
  decideDiagnosis(tk, 2, yes, id)
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

test('用户点取消：不再等确认，计划收口成完成，对话不算执行中、等下一句；报告关闭，不能再交新一版', () => {
  const tk = bugTask({ plans: [], steps: [] })
  applyPlan(tk, {
    steps: [{ title: '查根因', status: 'done' }, { title: '交诊断报告', status: 'running' }, { title: '按方案修' }],
  })
  submitDiagnosis(tk, input(), id)
  assert.ok(openPlan(tk), '交报告时计划还没做完')
  const r = decideDiagnosis(tk, 1, { approve: false, cancel: true, notes: [], overall: '先不修' }, id)
  assert.deepEqual(r, { ok: true, message: '' }, '取消不交话给子对话：它停着等用户下一句')
  const d = tk.bug!.diagnoses![0]
  assert.equal(d.status, 'cancelled')
  assert.equal(d.overall, '先不修')
  assert.equal(openPlan(tk), undefined, '计划标记完成')
  assert.ok(tk.plans!.at(-1)!.steps.every((s) => s.status === 'done'))
  assert.equal(diagnosisPending(tk), false)
  assert.equal(convState({ status: 'done', diagnosis: diagnosisPending(tk) }), 'done', '不再算执行中')
  assert.equal(childFlowOf({ ...tk, status: 'done', working: false, parentAsks: [] } as Task).requests, 0)
  assert.match(tk.messages.at(-1)!.text, /你取消了诊断报告第 1 版/)
  assert.equal(bugStage(tk), '已取消')
  assert.match(diagnosisGate(tk, []), /第 1 版点了「不修了」/)
  assert.equal(decideDiagnosis(tk, 1, yes, id).ok, false, '取消过的不能再确认')
  // 不修了的报告关闭（用户 2026-11-07 定）：之后的对话不能再交新一版拉起它
  const v2 = submitDiagnosis(tk, input(), id)
  assert.equal(v2.ok, false)
  assert.match(v2.info, /不修了.*不能再交新一版/)
  assert.equal(tk.bug!.diagnoses!.length, 1)
  assert.equal(tk.bug!.diagnoses![0].status, 'cancelled')
})

test('取消时代码里有临时日志：先叫它删，核对通过才关闭报告、收口计划；没过等用户决定', () => {
  const tk = bugTask({ plans: [], steps: [] })
  applyPlan(tk, {
    steps: [
      { title: '查根因', status: 'done' },
      { title: '交诊断报告', status: 'running' },
    ],
  })
  submitDiagnosis(tk, input(), id)
  const found = [{ file: 'src/a.ts', line: 3, text: "console.log('[排查-x] L1')" }]
  const r = decideDiagnosis(tk, 1, { approve: false, cancel: true, notes: [], overall: '' }, id, undefined, {
    found,
    drop: [],
    revertFix: false,
    pre: {},
  })
  assert.ok(r.ok && r.message.includes('src/a.ts:3'), '交给子对话删日志的话')
  const d = tk.bug!.diagnoses![0]
  assert.equal(d.cleanup?.state, 'running')
  assert.ok(openPlan(tk), '删干净之前计划不收口')
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['src/a.ts'] }, '只能改有日志的文件')
  const left = [{ file: 'src/a.ts', left: found, blank: [], extra: [], removed: [] }]
  assert.ok(settleCleanup(tk, { state: 'failed', failed: left }, id))
  assert.ok(openPlan(tk), '没删干净：计划不收口')
  assert.match(tk.messages.at(-1)!.text, /还剩 1 处临时日志/)
  d.cleanup!.state = 'running'
  assert.ok(settleCleanup(tk, { state: 'done' }, id))
  assert.equal(openPlan(tk), undefined)
  assert.match(tk.messages.at(-1)!.text, /临时日志已删干净（1 处）/)
  assert.ok('deny' in editScope(tk.bug!.diagnoses!), '关闭后不再改文件')
})

test('交报告时取代码快照、核对原文：对不上拒收、什么都不改；校准了行号写进回执', () => {
  const tk = bugTask()
  const src = {
    read: (f: string) => (f === 'web/src/lib/login.ts' ? 'a\n// [排查-登录] L1\nif (n > max) retry()\nb' : undefined),
  }
  const ref = (text: string) => ({
    stack: [
      { id: 'S1', file: 'web/src/lib/login.ts', line: 3, fn: 'retry' },
      { id: 'S2', parent: 'S1', role: 'fault', file: 'web/src/lib/login.ts', line: 3, fn: 'if (n > max)' },
    ],
    codeRefs: [
      { id: 'C1', file: 'web/src/lib/login.ts', start: 1, end: 3, marks: [{ line: 2, text, level: 'fault' }] },
    ],
  })
  const bad = submitDiagnosis(tk, input(ref('n >= max')), id, undefined, src)
  assert.equal(bad.ok, false)
  assert.match(bad.info, /login\.ts:2 里没有「n >= max」/)
  assert.equal(tk.bug?.diagnoses?.length ?? 0, 0)
  const good = submitDiagnosis(tk, input(ref('n > max')), id, undefined, src)
  ok(good)
  assert.match(good.info, /面板提醒：\n- web\/src\/lib\/login\.ts:2 里没有「n > max」，第 3 行有/)
  const d = tk.bug!.diagnoses![0]
  assert.equal(d.codeRefs[0].marks[0].line, 3)
  assert.match(d.codeRefs[0].snapshot!.text, /if \(n > max\) retry\(\)/)
  assert.match(diagnosisMarkdown(d), /```ts start=2 marks=/, '整段跟着挪了一行')
})

test('快速级别：根因和修复方案合成一版交，用户确认一次就开始修；弹窗里根因那几节也在', () => {
  // 实测（2026-11-05）：一行就能修的 Bug 也要确认根因、方案、验证三道
  const tk = bugTask()
  const r = submitDiagnosis(tk, input({ phase: 'plan' }), id)
  ok(r)
  assert.match(r.info, /一起确认根因和修复方案/)
  const md = diagnosisMarkdown(tk.bug!.diagnoses![0], undefined, { list: tk.bug?.diagnoses })
  assert.match(md, /根因和修复方案一起确认/)
  assert.match(md, /## 根因（已证实）\nmax 用的是秒/)
  assert.match(md, /## 证据链/)
  ok(decideDiagnosis(tk, 1, yes, id))
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['web/src/lib/login.ts'] })
  assert.match(diagnosisMarkdown(tk.bug!.diagnoses![0], undefined, { list: tk.bug?.diagnoses }), /你同意了根因和方案/)
})

test('根因那一版：返回写明只确认根因；提前写的修法不摆出来，只留一行提示', () => {
  const tk = bugTask()
  const r = submitDiagnosis(tk, input({ phase: 'cause', level: 'quick' }), id)
  ok(r)
  assert.match(r.info, /只请用户确认根因.*标成草案.*不要说在等他确认方案/)
  // 用户 2026-11-07 确认的设计：根因页不再摆修复方案草案，免得以为在确认方案
  const cause = diagnosisMarkdown(tk.bug!.diagnoses![0])
  assert.match(cause, /已经想好修法，同意根因后单独交一版方案给你确认/)
  assert.doesNotMatch(cause, /候选方案|修复方案草案/)
  // 同意根因后交的方案不算合成的一版
  ok(decideDiagnosis(tk, 1, yes, id))
  const p = submitDiagnosis(tk, input({ phase: 'plan' }), id)
  ok(p)
  assert.match(p.info, /等用户确认修复方案/)
  assert.doesNotMatch(diagnosisMarkdown(tk.bug!.diagnoses![1], undefined, { list: tk.bug?.diagnoses }), /一起确认/)
})

test('第几版（用户 2026-11-06 定）：按意见修改、阶段往下走不升版本；回到更早的阶段、换掉确认过的方案才升', () => {
  const tk = bugTask()
  const note = { approve: false, notes: [{ quote: '', kind: 'question' as const, comment: '为什么？' }], overall: '' }
  const last = () => tk.bug!.diagnoses!.at(-1)!
  // 论证两轮：同一版
  ok(submitDiagnosis(tk, evidenceInput(), id))
  ok(decideDiagnosis(tk, last().version, { ...yes, approve: false, supply: true, logs: 'max=30' }, id))
  ok(submitDiagnosis(tk, evidenceInput({ next: '上一轮 max=30 还分不清' }), id))
  assert.equal(last().rev, 1, '论证多轮还是第 1 版')
  ok(decideDiagnosis(tk, last().version, { ...yes, approve: false, supply: true, logs: 'max=30' }, id))
  // 往下走到根因；用户提了疑问，逐条回答后再交：还是同一版
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  ok(decideDiagnosis(tk, last().version, note, id))
  const same = submitDiagnosis(tk, input({ phase: 'cause', answers: [{ id: 1, answer: '查了，证据够' }] }), id)
  ok(same)
  assert.equal(last().rev, 1, '按意见修改不升版本')
  assert.match(same.info, /已交第 1 版的根因（这一版的第 2 轮，按意见修改不升版本号）（报告 #4）/)
  // 用户否决根因、回到论证：之前的结论不成立，第 2 版
  ok(decideDiagnosis(tk, last().version, note, id))
  const back = submitDiagnosis(tk, evidenceInput({ answers: [{ id: 1, answer: '证据不够，重新加日志' }] }), id)
  ok(back)
  assert.equal(last().rev, 2)
  assert.match(back.info, /已交第 2 版（论证）.*第 1 版的结论作废/)
  ok(decideDiagnosis(tk, last().version, { ...yes, approve: false, supply: true, logs: 'max=30' }, id))
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  ok(decideDiagnosis(tk, last().version, yes, id))
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  assert.equal(last().rev, 2, '根因 → 方案往下走还是第 2 版')
  ok(decideDiagnosis(tk, last().version, yes, id))
  // 修的时候要多改文件：换掉确认过的方案，第 3 版
  ok(submitDiagnosis(tk, input({ phase: 'plan', files: ['web/src/lib/login.ts', 'web/src/lib/api.ts'] }), id))
  assert.equal(last().rev, 3)
  ok(decideDiagnosis(tk, last().version, yes, id))
  approveFix(tk)
  assert.equal(last().rev, 3, '交修复还是第 3 版')
  ok(done(tk))
  ok(submitDiagnosis(tk, verifyInput(), id))
  assert.equal(last().rev, 3, '交验证还是第 3 版')
  // 验证没过、重出方案：第 4 版
  ok(decideDiagnosis(tk, last().version, note, id))
  ok(submitDiagnosis(tk, input({ phase: 'plan', answers: [{ id: 1, answer: '换修法' }] }), id))
  assert.equal(last().rev, 4)
  assert.match(tk.messages.at(-1)!.text, /你对第 3 版的验证提了 1 条意见/)
})

test('论证的日志一次加够（用户 2026-11-06 定）：至少两个假设、每个待验证的假设都有日志、每处写对应哪个', () => {
  const tk = bugTask()
  const info = (over: Partial<DiagnosisInput>) => submitDiagnosis(tk, evidenceInput(over), id).info
  assert.match(
    info({ hypotheses: [{ id: 'H1', text: '单位混用', status: 'open', basis: '' }] }),
    /至少两个候选假设/,
    '只列一个假设就是只盯眼前那一处',
  )
  assert.match(
    info({
      hypotheses: [
        { text: '单位混用', status: 'open', basis: '' },
        { text: '计数被重置', status: 'open', basis: '' },
      ],
    }),
    /待验证的假设要写 id/,
  )
  const two = [
    { id: 'H1', text: '单位混用', status: 'open', basis: '' },
    { id: 'H2', text: '计数被重置', status: 'open', basis: '' },
  ]
  assert.match(info({ hypotheses: two }), /没有日志能判真假：H2/, '每个待验证的假设这一轮都要覆盖到')
  assert.match(
    info({ hypotheses: two, logPlan: [{ id: 'L1', file: 'a.ts', print: 'x', hypothesis: '' }] }),
    /hypothesis（对应的假设编号，或「路标」）/,
  )
  ok(
    submitDiagnosis(
      tk,
      evidenceInput({
        hypotheses: two,
        logPlan: [
          {
            id: 'L1',
            file: 'web/src/lib/login.ts',
            print: "console.log('[排查-登录] L1', retries, max)",
            hypothesis: 'h1、H2',
          },
          { id: 'L2', file: 'web/src/lib/api.ts', print: "console.log('[排查-登录] L2 进入')", hypothesis: '路标' },
        ],
      }),
      id,
    ),
  )
})

test('连续退回（分析稿 B8）：同一段里第 3 次让它停下交给用户换模型；用户再发话重新数，交成功清零', () => {
  const tk = bugTask({ messages: [{ id: 'u1', role: 'user', text: '查一下' }] as Task['messages'] })
  const bad = () => submitDiagnosis(tk, input({ phase: 'cause', symptom: '' }), id)
  assert.match(bad().info, /第 1 次被退回/)
  assert.match(bad().info, /第 2 次被退回/)
  assert.match(bad().info, /连续第 3 次被退回.*end_turn（outcome: blocked）.*换一个能力更强的模型/s)
  assert.deepEqual(tk.bug?.case?.rejects, { n: 3, total: 3, since: 'u1' })
  tk.messages.push({ id: 'u2', role: 'user', text: '换了模型，继续' } as Task['messages'][number])
  assert.match(bad().info, /第 1 次被退回/, '用户发了新消息：重新数')
  ok(submitDiagnosis(tk, input({ phase: 'cause' }), id))
  assert.deepEqual(tk.bug?.case?.rejects, { n: 0, total: 4, since: 'u2' }, '交成功清零，总数留着')
  // Agent 不能自己写退回次数
  updateBugCase(tk, { rejects: { n: 0, total: 0, since: '' } } as unknown as DiagnosisInput)
  assert.equal(tk.bug?.case?.rejects?.total, 4)
})

test('不用改代码（分析稿 B5）：根因带 noFix，同意后不交方案、只放行删临时日志，没改代码就能收尾', () => {
  const tk = bugTask()
  agreeCause(tk, { noFix: { kind: 'config', how: '把 retry.max 改成 3' } } as Partial<DiagnosisInput>)
  const d = tk.bug!.diagnoses!.at(-1)!
  assert.equal(bugStage(tk), '收尾')
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: [] })
  assert.equal(diagnosisGate(tk, []), '')
  assert.match(diagnosisGate(tk, ['web/src/lib/login.ts']), /不用改代码.*login\.ts/)
  const md = diagnosisMarkdown(d, undefined, { list: tk.bug?.diagnoses })
  assert.match(md, /不用改代码：改配置/)
  assert.match(md, /怎么处理（不用改代码）[\s\S]*retry\.max 改成 3/)
  // 传 {} 去掉：之后照常要交修复方案
  const tk2 = bugTask()
  ok(updateBugCase(tk2, { noFix: { kind: 'config', how: 'x' } } as unknown as DiagnosisInput))
  ok(updateBugCase(tk2, { noFix: {} } as unknown as DiagnosisInput))
  assert.equal(tk2.bug?.case?.noFix, undefined)
})
