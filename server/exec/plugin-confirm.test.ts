/**
 * 插件确认卡的「这个对话里一直允许」（插件接口 17）：点了记成 plugin:<key> 规则，之后同一个 key 直接允许、留一行记录；
 * 不同的 key 照常出卡；卡上带插件给的说法和 diff。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import { pluginConfirm } from './plugin-confirm.ts'
import { answerRequest } from './requests.ts'

setLang('zh')

test('插件确认：一直允许记成对话规则，同一个 key 之后不再出卡，别的 key 照问', async () => {
  const task = {
    id: 'pc',
    mode: 'agent',
    projectId: 'p',
    messages: [],
    steps: [],
    requests: [],
    allowRules: [],
  } as unknown as Task
  let n = 0
  const ctx = { task, signal: new AbortController().signal, newId: () => `r${++n}`, changed: () => {} }
  const run = { step: '', agentId: 'a' }
  const own = new Set<string>()
  const always = { rule: 'feishu:read:doxA', ruleLabel: '读取《需求文档》' }

  const first = pluginConfirm(ctx, run, { title: '读取飞书文档', detail: '链接', ...always, diff: '@@\n-a\n+b' }, own)
  const [req] = task.requests
  assert.equal(req.kind, 'tool')
  assert.equal(req.rule, 'plugin:feishu:read:doxA')
  assert.equal(req.ruleLabel, '读取《需求文档》')
  assert.equal(req.diff, '@@\n-a\n+b')
  answerRequest(task, req.id, { allow: true, always: true }, () => 'm1')
  assert.deepEqual(await first, { allow: true, always: true, message: '' })
  assert.deepEqual(task.allowRules, ['plugin:feishu:read:doxA'])
  assert.match(task.messages.at(-1)!.text, /之后的读取《需求文档》都自动允许/)

  // 同一个 key：不出卡，直接允许并留一行
  const again = await pluginConfirm(ctx, run, { title: '读取飞书文档', ...always }, own)
  assert.deepEqual(again, { allow: true, always: true, message: '' })
  assert.equal(task.requests.length, 0)
  assert.match(task.messages.at(-1)!.text, /按这个对话的放行规则自动允许（读取《需求文档》）/)

  // 别的 key 照常出卡；只点「允许」不记规则
  const other = pluginConfirm(ctx, run, { title: '读取另一篇', rule: 'feishu:read:doxB', ruleLabel: 'B' }, own)
  answerRequest(task, task.requests[0].id, { allow: true }, () => 'm2')
  assert.deepEqual(await other, { allow: true, message: '' })
  assert.deepEqual(task.allowRules, ['plugin:feishu:read:doxA'])

  // 没给 always：普通的允许 / 拒绝卡，没有规则
  const plain = pluginConfirm(ctx, run, { title: '写入' }, own)
  assert.equal(task.requests[0].rule, undefined)
  answerRequest(task, task.requests[0].id, { allow: false }, () => 'm3')
  assert.equal((await plain).allow, false)
})
