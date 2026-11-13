import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import {
  decideDiagnosis,
  diagnosisMessage,
  pendingDiagnosis,
  submitDiagnosis,
  type DiagnosisInput,
} from './diagnosis.ts'
import { bugChatPart, chatDeny, chatSaid, chatStale, retractChat, syncChat } from './chat.ts'
import { editScope, verOf } from './phase.ts'
import type { Task, TaskMessage } from '../schema.ts'

/**
 * 诊断报告跟上对话（用户 2026-11-13 定，设计稿「诊断报告-跟随子对话聊天更新」）：
 * 用户不点报告、在对话里聊着定了方案时，它带 fromChat 交新的一版（原话由面板取），
 * 用户在对话里确认过的直接记为确认、流程接着走；面板按事实提示报告没跟上；用户能撤回
 */
setLang('zh')

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  symptom: '登录超时后一直转圈',
  repro: 'npm test -- login.test.ts：超时用例失败',
  location: 'web/src/lib/login.ts:40 retry → api.ts:12 fetch',
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
const yes = { approve: true, notes: [], overall: '' }

/** 消息时间：从现在往后挪，保证排在刚交的报告后面 */
let clock = Date.now() + 1000
const later = (ms = 60_000) => new Date((clock += ms)).toISOString()
const msg = (role: TaskMessage['role'], text: string, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id: id(),
  role,
  agentId: '',
  step: '',
  text,
  tools: [],
  at: later(),
  ...extra,
})
const say = (tk: Task, text: string) => {
  const m = msg('user', text)
  tk.messages.push(m)
  return m
}

/** 同意根因、交方案（还在等确认） */
const planPending = () => {
  const tk = bugTask()
  ok(submitDiagnosis(tk, input(), id))
  ok(decideDiagnosis(tk, 1, yes, id))
  ok(submitDiagnosis(tk, input({ phase: 'plan' }), id))
  return tk
}

test('只认用户在对话里亲口说的：别的对话转来的、面板推的、报告上做决定后交过去的那段话都不算', () => {
  const tk = bugTask()
  const a = say(tk, '先看看日志')
  tk.messages.push(
    msg('user', '父对话转来的', {
      peer: { id: 'p', title: '', name: '', rel: 'parent', kind: 'task' } as TaskMessage['peer'],
    }),
  )
  tk.messages.push(msg('system', '后台命令跑完了', { panel: 'background' }))
  // 报告上做决定：先记一行，页面马上把交给它的话作为用户消息发过去
  const line = diagnosisMessage(id(), 1, '你同意了第 1 版的根因', later())
  tk.messages.push(line)
  tk.messages.push({
    ...msg('user', '用户同意了第 1 版的根因。现在设计修复方案'),
    at: new Date(Date.parse(line.at) + 50).toISOString(),
  })
  const b = say(tk, '改成按次数吧')
  assert.deepEqual(
    chatSaid(tk.messages, '').map((x) => x.id),
    [a.id, b.id],
  )
  assert.deepEqual(
    chatSaid(tk.messages, a.at).map((x) => x.id),
    [b.id],
    '只取某个时间之后的',
  )
})

test('报告在等确认、用户在对话里让它改：改文件的拦截指出正路（带 fromChat 交一版），不再只说等用户回复', () => {
  const tk = planPending()
  const scope = editScope(tk.bug!.diagnoses!)
  assert.ok('deny' in scope)
  assert.equal(chatDeny(tk, scope.deny), scope.deny, '用户没说话时照旧')
  say(tk, '调整吧，改成次数上限常量')
  const deny = chatDeny(tk, scope.deny)
  assert.match(deny, /用户在那之后直接在对话里说了话/)
  assert.match(deny, /fromChat/)
  assert.match(deny, /confirm: true/)
  assert.match(deny, /不要用脚本或命令绕过/)
})

test('用户在对话里确认了：带 fromChat.confirm 交，顶掉还在等确认的上一份，记为确认、小版本，流程接着走', () => {
  const tk = planPending()
  const plan = pendingDiagnosis(tk)!
  // 没写 fromChat：上一份还在等确认，不能重复交
  assert.match(submitDiagnosis(tk, input({ phase: 'plan' }), id).info, /还在等用户确认，不要重复交/)
  // 写了 fromChat，但用户在那之后没说过话
  assert.match(
    submitDiagnosis(tk, input({ phase: 'plan', fromChat: { confirm: true } }), id).info,
    /没有在对话里直接说过话/,
  )
  const q = say(tk, '检测范围是怎么定的')
  const go = say(tk, '调整吧，就按次数上限来改')
  const r = submitDiagnosis(tk, input({ phase: 'plan', fix: '改成次数上限', fromChat: { confirm: true } }), id)
  ok(r)
  assert.match(r.info, /已交第 1\.1 版的修复方案/)
  assert.match(r.info, /面板已把这一版记为用户确认/)
  assert.match(r.info, /不用结束这一轮/)
  assert.match(r.info, /用户确认了第 1 版的修复方案，按它修/, '交给它的话和用户点同意时同一段')
  const list = tk.bug!.diagnoses!
  const d = list.at(-1)!
  assert.equal(plan.status, 'superseded')
  assert.equal(d.status, 'approved')
  assert.deepEqual(d.approvedBy, { kind: 'chat', id: go.id, at: go.at })
  assert.deepEqual(
    d.chat?.map((x) => x.text),
    [q.text, go.text],
    '原话由面板取，不让它抄',
  )
  assert.equal(verOf(d, list), '1.1')
  assert.match(tk.messages.at(-1)!.text, /按你在对话里说的更新了诊断报告：第 1\.1 版修复方案，你在对话里确认过/)
  // 确认了就能按方案改文件，收尾前照常交修复
  assert.deepEqual(editScope(list), { files: ['web/src/lib/login.ts'] })
})

test('没带 confirm：只把对话里聊出来的更新进报告，还要用户在报告上确认；论证这一版不能在对话里确认', () => {
  const tk = planPending()
  say(tk, '要不要换成统一的重试工具？')
  const r = submitDiagnosis(tk, input({ phase: 'plan', fromChat: true }), id)
  ok(r)
  const d = tk.bug!.diagnoses!.at(-1)!
  assert.equal(d.status, 'pending')
  assert.equal(d.approvedBy, undefined)
  assert.equal(d.chat?.length, 1)
  assert.match(r.info, /现在结束这一轮回复/)
  assert.match(tk.messages.at(-1)!.text, /等你确认/)

  say(tk, '先加日志看看吧')
  assert.match(
    submitDiagnosis(tk, input({ phase: 'evidence', confirmed: false, fromChat: { confirm: true } }), id).info,
    /论证（要加的日志）这一版要用户在报告上同意，fromChat 不能带 confirm/,
  )
})

test('报告没跟上对话：面板按事实提示（说了几句、多改了哪些文件），每轮提示词里提醒它交回报告', () => {
  const tk = planPending()
  assert.equal(chatStale(tk), undefined)
  assert.equal(bugChatPart({ task: tk }), '')
  say(tk, '改成按次数吧')
  tk.changes = [{ path: 'web/src/lib/api.ts', add: 1, del: 1 }] as Task['changes']
  const s = chatStale(tk)!
  assert.equal(s.said.length, 1)
  assert.deepEqual(s.files, ['web/src/lib/api.ts'])
  const part = bugChatPart({ task: tk })
  assert.match(part, /^## 诊断报告要跟上对话/)
  assert.match(part, /第 1 版报告（修复方案，报告 #2）还在等用户确认，用户在那之后直接在对话里说了 1 句话/)
})

test('用户点「让它按对话更新报告」：对话里记一行，交给它的话带原话；这段话本身不算用户在对话里说的', () => {
  const tk = planPending()
  assert.equal(syncChat(tk, () => {}).ok, false)
  say(tk, '就按次数上限来吧')
  const r = syncChat(tk, (v, text) => tk.messages.push(diagnosisMessage(id(), v, text, later())))
  assert.ok(r.ok)
  assert.match(r.message, /「就按次数上限来吧」/)
  assert.match(r.message, /fromChat/)
  assert.match(tk.messages.at(-1)!.text, /你请它按对话更新第 1 版诊断报告/)
  tk.messages.push({ ...msg('user', r.message), at: new Date(Date.parse(tk.messages.at(-1)!.at) + 100).toISOString() })
  assert.equal(chatStale(tk)!.said.length, 1)
})

test('「不是这个意思」：撤回在对话里的确认，这一版回到等用户确认，改文件重新被拦', () => {
  const tk = planPending()
  say(tk, '改吧')
  ok(submitDiagnosis(tk, input({ phase: 'plan', fromChat: { confirm: true } }), id))
  const d = tk.bug!.diagnoses!.at(-1)!
  const line = (v: number, text: string) => tk.messages.push(diagnosisMessage(id(), v, text, later()))
  assert.equal(retractChat(tk, d.version - 1, line).ok, false, '只能撤回最新一版')
  const r = retractChat(tk, d.version, line)
  assert.ok(r.ok)
  assert.match(r.message, /用户撤回了在对话里对第 1 版（修复方案，报告 #\d+）的确认/)
  assert.equal(d.status, 'pending')
  assert.equal(d.approvedBy, undefined)
  assert.match(tk.messages.at(-1)!.text, /你撤回了在对话里对第 1\.1 版的确认/)
  assert.ok('deny' in editScope(tk.bug!.diagnoses!))
  assert.equal(retractChat(tk, d.version, line).ok, false, '撤回过的不能再撤')
})
