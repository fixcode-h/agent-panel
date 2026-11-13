import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import { decideDiagnosis, pendingDiagnosis, submitDiagnosis, type DiagnosisInput } from './diagnosis.ts'
import { diagnosisMarkdown } from './diagnosis-md.ts'
import { cleanDiff, editPatch } from './fix.ts'
import { editScope } from './phase.ts'
import type { BugSource } from './quotes.ts'
import type { Task } from '../schema.ts'

/** 修复这一步（用户 2026-11-10 定）：修完给用户看改了哪些代码、为什么，确认了才验证；对代码有疑问交回逐条判断 */
setLang('zh')

const RAW = `diff --git a/web/src/lib/login.ts b/web/src/lib/login.ts
index 1111111..2222222 100644
--- a/web/src/lib/login.ts
+++ b/web/src/lib/login.ts
@@ -40,5 +40,6 @@ export function retry() {
   let retries = 0
-  const max = config.timeoutSec
+  const max = MAX_RETRIES
+  console.log('[排查-登录] L1', retries)
   while (retries < max) {
@@ -80,3 +81,4 @@ function other() {
   a()
+  console.log('[排查-登录] L2')
   b()
`

test('取 diff：去掉文件头和临时日志，只剩临时日志的那一段整段不要', () => {
  const c = cleanDiff(RAW)
  assert.equal(c.add, 1)
  assert.equal(c.del, 1)
  assert.equal(c.isNew, false)
  assert.doesNotMatch(c.diff, /排查-|diff --git|\+\+\+ b\//)
  assert.match(c.diff, /^@@ -40,5 \+40,6 @@/)
  assert.doesNotMatch(c.diff, /@@ -80/)
  assert.equal(cleanDiff('@@ -1 +1,2 @@\n a\n+console.log("[排查-x] L1")\n').add, 0)
  assert.equal(cleanDiff('--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1\n').isNew, true)
})

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  symptom: '登录超时后一直转圈',
  repro: 'npm test -- login.test.ts',
  location: 'web/src/lib/login.ts:40',
  stack: [
    { id: 'S1', file: 'web/src/lib/login.ts', line: 40, fn: 'retry' },
    { id: 'S2', parent: 'S1', role: 'fault', file: 'web/src/lib/login.ts', line: 44, fn: 'retries < max' },
  ],
  evidence: '日志 retry 3',
  rootCause: 'max 用的是秒，retries 按次数累加',
  confirmed: true,
  fix: 'login.ts 把 max 换成次数上限常量',
  files: ['web/src/lib/login.ts'],
  risk: '只影响登录重试',
  verify: 'login.test.ts 的超时用例改前失败、改后通过',
  level: 'quick',
  attribution: { category: 'recent', change: 'a1b2c3', author: '', date: '', title: '重试改成按秒', how: 'blame' },
  rating: { tier: 'low', percent: 95 },
  ...over,
})
let n = 0
const id = () => `id${++n}`
const yes = { approve: true, notes: [], overall: '' }
const ok = (r: { ok: boolean; info?: string; error?: string }) => assert.ok(r.ok, r.info ?? r.error ?? '')
const src = (diffs: Record<string, string>): BugSource => ({ read: () => undefined, diff: (f) => diffs[f] ?? '' })
const bugTask = () =>
  ({
    bug: { kind: 'report', diagnoses: [] },
    requests: [],
    messages: [],
    changes: [
      { path: 'web/src/lib/login.ts', add: 2, del: 1 },
      { path: 'web/src/lib/login.test.ts', add: 3, del: 0 },
    ],
  }) as unknown as Task
const TEST_DIFF =
  '--- /dev/null\n+++ b/web/src/lib/login.test.ts\n@@ -0,0 +1,3 @@\n+test("超时", () => {\n+  assert.equal(retry(), 3)\n+})\n'
const fixed = { 'web/src/lib/login.ts': RAW, 'web/src/lib/login.test.ts': TEST_DIFF }
const changes = [
  { file: 'web/src/lib/login.ts', what: '`max` 换成 `MAX_RETRIES`', why: 'retries 按次数累加，上限也要按次数' },
  { file: 'web/src/lib/login.test.ts', what: '加超时用例', why: '改前失败、改后通过，防回归', isNew: true },
]

test('交修复：改了的文件都要写改了什么、为什么；报告上是原因和实际 diff，确认了才能验证', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  assert.match(submitDiagnosis(tk, input({ phase: 'fix' }), id, undefined, src(fixed)).info, /changes 要写/)
  assert.match(
    submitDiagnosis(tk, input({ phase: 'fix', changes: [{ ...changes[0], why: '' }] }), id, undefined, src(fixed)).info,
    /缺 file、what 或 why/,
  )
  assert.match(
    submitDiagnosis(tk, input({ phase: 'fix', changes: [changes[0]] }), id, undefined, src(fixed)).info,
    /这些文件改了，changes 里没写：web\/src\/lib\/login\.test\.ts/,
  )
  assert.match(submitDiagnosis(tk, input({ phase: 'fix', changes }), id, undefined, src({})).info, /还没有改任何代码/)
  ok(submitDiagnosis(tk, input({ phase: 'fix', changes }), id, undefined, src(fixed)))
  const d = pendingDiagnosis(tk)!
  assert.equal(d.phase, 'fix')
  assert.equal(d.rev, 1, '阶段往下走不升版本')
  assert.deepEqual(
    d.fixFiles.map((f) => [f.file, f.add, f.del, f.isNew]),
    [
      ['web/src/lib/login.ts', 1, 1, false],
      ['web/src/lib/login.test.ts', 3, 0, true],
    ],
  )
  const md = diagnosisMarkdown(d, tk.bug!.diagnoses![0], { list: tk.bug?.diagnoses })
  assert.match(md, /改了 2 个文件 · \+4 −1/)
  assert.match(md, /## 改了哪些文件/)
  assert.match(md, /retries 按次数累加，上限也要按次数/)
  assert.match(md, /## 改动的代码/)
  assert.match(md, /### login\.ts\n\n`max` 换成/)
  assert.match(md, /```diff file=web%2Fsrc%2Flib%2Flogin\.ts\n@@ -40,5 \+40,6 @@[\s\S]*\+ {2}const max = MAX_RETRIES/)
  assert.doesNotMatch(md, /排查-登录/)
  // 修复等你确认：不能改文件、不能交验证
  assert.ok('deny' in editScope(tk.bug!.diagnoses!))
  assert.match(submitDiagnosis(tk, input({ phase: 'verify' }), id).info, /还在等用户确认/)
  const r = decideDiagnosis(tk, d.version, yes, id)
  assert.ok(r.ok && /现在验证/.test(r.message) && /交 phase: verify/.test(r.message))
  assert.match(tk.messages.at(-1)!.text, /你确认了第 1 版的修复/)
})

test('对修复的代码提疑问：放行方案里的文件，它逐条判断，对的改代码、不对的用事实反驳，再交修复还是同一版', () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  ok(submitDiagnosis(tk, input({ phase: 'fix', changes }), id, undefined, src(fixed)))
  const note = {
    approve: false,
    notes: [{ quote: 'const max = MAX_RETRIES', comment: '上限写死成常量，配置还有用吗？', kind: 'question' as const }],
    overall: '',
  }
  const r = decideDiagnosis(tk, 2, note, id)
  assert.ok(r.ok)
  assert.match(r.message, /stance: adopted/)
  assert.match(r.message, /stance: disagree，用事实反驳/)
  assert.match(r.message, /重新交 phase: fix（还是第 1 版）/)
  assert.deepEqual(editScope(tk.bug!.diagnoses!), { files: ['web/src/lib/login.ts'] }, '说得对要能改代码')
  assert.match(submitDiagnosis(tk, input({ phase: 'fix', changes }), id, undefined, src(fixed)).info, /还没回答：1/)
  ok(
    submitDiagnosis(
      tk,
      input({
        phase: 'fix',
        changes,
        answers: [{ id: 1, answer: '配置 timeoutSec 还给请求超时用，见 `api.ts:12`', stance: 'disagree' }],
      }),
      id,
      undefined,
      src(fixed),
    ),
  )
  const d = pendingDiagnosis(tk)!
  assert.equal(d.phase, 'fix')
  assert.equal(d.rev, 1)
  assert.match(diagnosisMarkdown(d, tk.bug!.diagnoses!.at(-2), { list: tk.bug?.diagnoses }), /（\*\*不同意\*\*）：配置/)
})

// 用户 2026-11-11 报：P4 工程（不是 git）修复页把改过的 C++、Lua 整个文件都画成新增。
// 不是 git 时 diff 取不到，改用 Agent 改文件时记下的改动，不和空文件比
const edit = (label: string, input: string, failed = false) => ({ kind: 'edit', label, detail: '', input, failed })
test('不是 git 的工程：修复页的 diff 拼 Agent 改文件时记下的改动，不把整个文件画成新增', () => {
  const msgs = [
    {
      tools: [
        edit('Source/Reset.cpp', '@@ -440,3 +440,4 @@\n   if (a)\n-    Old();\n+    New();\n+    More();'),
        edit('Source/Reset.cpp', '{\n  "file_path": "Source/Reset.cpp"\n}'),
        edit('Source/Reset.cpp', '@@ -1 +1 @@\n-x\n+y', true),
        edit('Script/new.lua', '+local M = {}\n+return M'),
      ],
    },
  ] as unknown as Task['messages']
  assert.equal(
    editPatch(msgs, 'Source/Reset.cpp'),
    '@@ -440,3 +440,4 @@\n   if (a)\n-    Old();\n+    New();\n+    More();',
  )
  assert.equal(editPatch(msgs, 'Script/new.lua'), '@@ @@\n+local M = {}\n+return M')
  assert.equal(editPatch(msgs, 'Other.cpp'), undefined)

  const tk = bugTask()
  tk.changes = [{ path: 'Source/Reset.cpp', add: 2, del: 1 }]
  tk.messages.push(...msgs)
  const p4: BugSource = { read: () => undefined, diff: () => undefined }
  ok(submitDiagnosis(tk, input({ phase: 'plan', files: ['Source/Reset.cpp'] }), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  const why = [{ file: 'Source/Reset.cpp', what: '换成 New', why: '旧的会重复触发' }]
  ok(submitDiagnosis(tk, input({ phase: 'fix', files: ['Source/Reset.cpp'], changes: why }), id, undefined, p4))
  const d = pendingDiagnosis(tk)!
  assert.deepEqual(
    d.fixFiles.map((f) => [f.file, f.add, f.del, f.isNew]),
    [['Source/Reset.cpp', 2, 1, false]],
  )
  assert.match(d.fixFiles[0].diff, /^@@ -440,3 \+440,4 @@\n {3}if \(a\)\n- {4}Old\(\);/)
})
