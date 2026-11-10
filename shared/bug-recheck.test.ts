import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { Diagnosis, type Recheck, type RecheckRun } from './bug-diagnosis-schema.ts'
import { needsRecheck, ranInConversation, recheckMd, recheckVerdict, TEST_FILE } from './bug-recheck.ts'
import { fixBriefMd, fixBriefMissing, fixBriefOf } from './bug-fix-brief.ts'

/** 面板复核回归测试（分析稿 B9）：只看退出码判「改前失败、改后通过」，跑不了的照实标出来 */
setLang('zh')

const run = (code: number | null, over: Partial<RecheckRun> = {}): RecheckRun => ({
  code,
  out: code === 0 ? 'ok 1 passed' : 'not ok 1 超时用例',
  ms: 1200,
  timedOut: false,
  error: '',
  ...over,
})
const rc = (items: Recheck['items'], state: Recheck['state'] = 'done'): Recheck => ({ state, why: '', at: 'x', items })
const item = (before?: RecheckRun, after?: RecheckRun, skip = '') => ({ command: 'npm test', before, after, skip })

test('复核结论：每条改前失败、改后通过才算通过；改前就通过（测试拦不住）或改后失败算没通过；超时、跑不了算部分', () => {
  assert.equal(recheckVerdict(undefined), 'none')
  assert.equal(recheckVerdict(rc([], 'running')), 'running')
  assert.equal(recheckVerdict(rc([item(run(1), run(0))])), 'pass')
  assert.equal(recheckVerdict(rc([item(run(0), run(0))])), 'fail')
  assert.equal(recheckVerdict(rc([item(run(1), run(1))])), 'fail')
  assert.equal(recheckVerdict(rc([item(run(null, { timedOut: true }), run(0))])), 'partial')
  assert.equal(recheckVerdict(rc([item(run(null, { error: '取不到改前的代码' }), run(0))])), 'partial')
  // 一条没在对话里跑过（面板不替它跑）：另一条通过也只算部分
  assert.equal(recheckVerdict(rc([item(run(1), run(0)), item(undefined, undefined, '没跑过')])), 'partial')
  assert.equal(recheckVerdict(rc([item(undefined, undefined, '没跑过')])), 'none')
})

test('只重跑对话里跑过的命令；测试文件按路径认', () => {
  const messages = [{ tools: [{ kind: 'run' as const, label: 'npm  test -- login.test.ts', detail: '' }] }]
  assert.ok(ranInConversation('npm test -- login.test.ts', messages))
  assert.ok(!ranInConversation('rm -rf build', messages))
  assert.ok(!ranInConversation('', messages))
  for (const f of ['a/b.test.ts', 'tests/x.py', 'pkg/foo_test.go', 'test_util.py', 'src/__tests__/a.js'])
    assert.ok(TEST_FILE.test(f), f)
  assert.ok(!TEST_FILE.test('src/latest.ts'))
})

test('验证页上照实写：改前改后的退出码、输出；没写命令的标「面板没有复核」', () => {
  const d = Diagnosis.parse({ version: 2, at: 'x', phase: 'fix', status: 'pending' })
  assert.match(recheckMd(d), /面板没有复核：档案里没写能直接跑的回归测试命令/)
  d.result = {
    reproBefore: '',
    reproAfter: '',
    impactChecks: [],
    regressionTests: [],
    commands: ['npm test'],
    runs: '',
  }
  assert.ok(needsRecheck(d))
  assert.match(recheckMd(d), /这一轮结束后面板会跑：`npm test`/)
  d.recheck = rc([item(run(1), run(0))])
  assert.ok(!needsRecheck(d))
  const md = recheckMd(d)
  assert.match(md, /每条都是改前失败、改后通过/)
  assert.match(md, /✓ 失败（退出码 1/)
  assert.match(md, /✓ 通过（退出码 0/)
  assert.match(md, /not ok 1 超时用例/)
  d.recheck = rc([item(run(null, { error: '找不到对话开始时的提交' }), run(1))])
  const bad = recheckMd(d)
  assert.match(bad, /对不上/)
  assert.match(bad, /面板没有复核：找不到对话开始时的提交/)
  // 论证、根因、方案没有这一节
  assert.equal(recheckMd(Diagnosis.parse({ version: 1, at: 'x', phase: 'plan' })), '')
})

test('直接修的 Bug（kind: "fix"）收尾要写根因一句，面板出只读的简版报告', () => {
  assert.equal(fixBriefMissing({ bugFix: false }, {}), '')
  assert.match(fixBriefMissing({ bugFix: true }, {}), /handoff\.cause 写根因一句/)
  assert.equal(fixBriefMissing({ bugFix: true }, { cause: '单位混用' }), '')
  const b = fixBriefOf({ cause: 'max 用的是秒\n细节' }, '换成次数上限', 'npm test 通过', ['src/a.ts'], 'x')
  const md = fixBriefMd(b)
  assert.match(md.split('\n')[0], /^修复简报：max 用的是秒$/)
  assert.match(md, /\*\*改了什么\*\*\n\n换成次数上限/)
  assert.match(md, /`src\/a\.ts`/)
  assert.match(md, /\*\*怎么验证的\*\*\n\nnpm test 通过/)
})
