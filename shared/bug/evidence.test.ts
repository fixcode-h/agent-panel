import assert from 'node:assert/strict'
import test from 'node:test'
import { envEmpty, envMd, envOf, parseCommits, parseDirty } from './env.ts'
import {
  fileLead,
  lineSpan,
  logPathIn,
  logPathsIn,
  newlineOffsets,
  newRange,
  pastedLog,
  relatedLines,
  tidyLog,
  looksUtf16,
} from './log-watch.ts'
import { patchFilesOf, patchKindOf, restoreConflicts, applyErrorLines } from './patch.ts'
import { BugEnv, Diagnosis } from './diagnosis-schema.ts'
import { diagnosisView } from './diagnosis-md.ts'

/** 诊断报告的取证（分析稿 B1 / B3 / B4）：补丁放哪些文件、日志文件怎么认和取、环境怎么解析和显示 */

const diag = (o: Record<string, unknown>) =>
  Diagnosis.parse({ version: 1, at: '2026-11-10T00:00:00Z', status: 'pending', ...o })

test('环境：git log / status 的输出解析成提交和未提交文件，超过 30 个只记个数', () => {
  const log = ['a1b2c3d\0修角标\0李四\x002026-11-09', 'e4f5a6b\0标题里有 | 竖线\0王五\x002026-11-08', ''].join('\n')
  assert.deepEqual(parseCommits(log), [
    { hash: 'a1b2c3d', title: '修角标', author: '李四', date: '2026-11-09' },
    { hash: 'e4f5a6b', title: '标题里有 | 竖线', author: '王五', date: '2026-11-08' },
  ])
  const st = [
    ' M src/a.ts',
    'R  old.ts -> new.ts',
    '?? "dir with space/x.ts"',
    ...Array.from({ length: 31 }, (_, i) => `?? f${i}.ts`),
  ]
  const d = parseDirty(st.join('\n'))
  assert.equal(d.files.length, 30)
  assert.deepEqual(d.files.slice(0, 3), ['src/a.ts', 'new.ts', 'dir with space/x.ts'])
  assert.equal(d.more, 4)
})

test('环境：取不到的项省略；旧报告没有 env 不出这一节，后面几版沿用第一份的', () => {
  const env = BugEnv.parse({
    os: 'Linux 6.1 (x64)',
    branch: 'dev',
    commits: [{ hash: 'a1b2c3d', title: '修角标', author: '李四', date: '2026-11-09' }],
  })
  const md = envMd(env)
  assert.match(md, /Linux 6\.1/)
  assert.match(md, /`dev`/)
  assert.match(md, /李四/)
  assert.doesNotMatch(md, /Node\.js|依赖锁文件|没提交的改动/)
  // 关掉「写作者」时提交表不带作者
  assert.doesNotMatch(envMd(env, { author: false }), /李四/)
  assert.ok(envEmpty(undefined))
  assert.equal(envMd(BugEnv.parse({})), '')
  const first = diag({ env })
  const second = diag({ version: 2 })
  assert.deepEqual(envOf(second, [first, second]), first.env)
  // 报告「依据和背景」里有这一节；没有 env 的旧报告没有
  assert.match(diagnosisView(second, first, { list: [first, second] }).background, /环境（面板自动采集）/)
  assert.doesNotMatch(diagnosisView(diag({}), undefined, {}).background, /环境（面板自动采集）/)
  // 坏数据不拦报告：env 整个读不进来就当没有
  assert.equal(diag({ env: 'oops' }).env, undefined)
})

test('取日志：从「日志在哪」里认出文件路径，控制台、网址认不出', () => {
  assert.equal(logPathIn('日志在 logs/app.log，按 [排查-角标] 过滤'), 'logs/app.log')
  assert.equal(logPathIn('`C:\\Game\\Saved\\Logs\\Town.log`'), 'C:\\Game\\Saved\\Logs\\Town.log')
  assert.equal(logPathIn('"Saved/Logs/My Game.log"'), 'Saved/Logs/My Game.log')
  assert.equal(logPathIn('/var/log/app/server.out。'), '/var/log/app/server.out')
  assert.deepEqual(logPathsIn('浏览器开发者工具的控制台'), [])
  assert.deepEqual(logPathsIn('http://localhost:5173/debug.log'), [])
  assert.deepEqual(logPathsIn('[排查-角标]'), [])
  assert.equal(logPathIn(undefined), '')
})

test('取日志：引用日志文件、写明从第几行看的那句话不算日志正文', () => {
  const ref = '@/home/me/shop/logs/app.log 从第 412 行往后看：这是复现期间新增的日志（第 412–431 行）。'
  assert.deepEqual(fileLead(ref)?.path, '/home/me/shop/logs/app.log')
  assert.equal(pastedLog(ref), '')
  assert.equal(
    fileLead('@"C:\\My Game\\Saved\\Logs\\Town.log" 从第 3 行往后看')?.path,
    'C:\\My Game\\Saved\\Logs\\Town.log',
  )
  // 真贴了日志的照旧是正文
  assert.equal(pastedLog('[排查-支付] L1 total=1\nmore'), '[排查-支付] L1 total=1\nmore')
  assert.equal(pastedLog('/var/log/app.log\n[排查-支付] L1\nmore'), '/var/log/app.log\n[排查-支付] L1\nmore')
})

test('取日志：从记下的大小读到末尾，文件变小算轮转、超过上限截尾；相关行按 [排查- 筛', () => {
  assert.deepEqual(newRange(100, 250), { from: 100, length: 150, total: 150, truncated: false, rotated: false })
  assert.deepEqual(newRange(500, 80), { from: 0, length: 80, total: 80, truncated: false, rotated: true })
  assert.deepEqual(newRange(0, 3000, 1000), { from: 0, length: 1000, total: 3000, truncated: true, rotated: false })
  assert.equal(
    relatedLines('a\n[排查-角标] L1 left=0\r\nb\n[排查-角标] L2 hit'),
    '[排查-角标] L1 left=0\n[排查-角标] L2 hit',
  )
  // 截尾时丢掉最后半行；BOM 和 \r\n 收拾掉
  assert.equal(tidyLog('\ufeffa\r\nb\r\nhal', true), 'a\nb')
  assert.equal(tidyLog('a\r\nb'), 'a\nb')
  // 数行：起点在行尾从下一行算，起点在一行中间从这一行算；UTF-16 的「上」(4E0A) 低字节不算换行
  assert.deepEqual(newlineOffsets(Buffer.from('a\nbc\n'), false), [1, 4])
  assert.deepEqual(newlineOffsets(Buffer.from('上\n', 'utf16le'), true), [2])
  assert.deepEqual(lineSpan({ before: 2, total: 5, endsWithNewline: true, size: 30 }), { startLine: 3, endLine: 5 })
  assert.deepEqual(lineSpan({ before: 2, total: 5, endsWithNewline: false, size: 30 }), { startLine: 3, endLine: 6 })
  assert.deepEqual(lineSpan({ before: 0, total: 0, endsWithNewline: false, size: 0 }), { startLine: 1, endLine: 0 })
  assert.ok(looksUtf16(Buffer.from('hello log', 'utf16le')))
  assert.ok(!looksUtf16(Buffer.from('hello log', 'utf8')))
})

test('排查补丁：等你复现放日志计划的文件，验证放方案的文件，别的时候不能放', () => {
  const evidence = diag({
    phase: 'evidence',
    logPlan: [
      { id: 'L1', file: 'src/a.ts', print: 'x' },
      { id: 'L2', file: './src/b.ts:12', print: 'y' },
    ],
    awaiting: { at: 'x', added: [] },
  })
  assert.equal(patchKindOf(evidence), 'logs')
  assert.deepEqual(patchFilesOf([evidence], 'logs'), ['src/a.ts', 'src/b.ts'])
  assert.equal(patchKindOf({ ...evidence, awaiting: undefined }), undefined)
  assert.equal(patchKindOf({ ...evidence, status: 'answered' }), undefined)
  const plan = diag({ phase: 'plan', version: 2, status: 'approved', files: ['src/a.ts', 'src/c.ts'] })
  const verify = diag({ phase: 'verify', version: 3 })
  assert.equal(patchKindOf(verify), 'fix')
  assert.deepEqual(patchFilesOf([evidence, plan, verify], 'fix'), ['src/a.ts', 'src/c.ts'])
  assert.equal(patchKindOf(diag({ phase: 'cause' })), undefined)
})

test('排查补丁：放了之后用户又改过的文件算冲突；git 报错整理成几行', () => {
  const state = {
    kind: 'logs' as const,
    at: '',
    files: { 'a.ts': { before: 'h0', after: 'h1' }, 'n.ts': { before: 'absent', after: 'h2' } },
  }
  assert.deepEqual(restoreConflicts(state, { 'a.ts': 'h1', 'n.ts': 'h2' }), [])
  assert.deepEqual(restoreConflicts(state, { 'a.ts': 'h9', 'n.ts': 'h2' }), ['a.ts'])
  // 补丁新建的文件被用户删了：也算改过
  assert.deepEqual(restoreConflicts(state, { 'a.ts': 'h1' }), ['n.ts'])
  assert.deepEqual(
    applyErrorLines(
      'error: patch failed: src/a.ts:3\nerror: src/a.ts: patch does not apply\nerror: src/a.ts: patch does not apply\n',
    ),
    ['patch failed: src/a.ts:3', 'src/a.ts: patch does not apply'],
  )
})
