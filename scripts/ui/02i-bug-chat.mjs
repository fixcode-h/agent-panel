/**
 * 界面检查分片：诊断报告跟上对话（用户 2026-11-13 定，设计稿「诊断报告-跟随子对话聊天更新」）：
 * 用户没点报告、在子对话里聊着定了方案，它按对话交新的一版（依据的原话由面板取），用户在对话里确认过的直接记为确认；
 * 之后又在对话里说了话，报告顶上提示没跟上；看错了点「不是这个意思」撤回。演示数据从头生成，不依赖别的分片
 */

import { runShard } from './harness.mjs'
import { childView, openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { check, errors, settle } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  await p.evaluate((k) => {
    const db = JSON.parse(localStorage.getItem(k))
    const parent = db.tasks.find((x) => x.title.includes('购物车右上角'))
    // 用一个已经停下的子对话（演示里在跑的子对话会被模拟执行改写消息）
    const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
    Object.assign(kid, { resolved: false, status: 'done', working: false, bug: { kind: 'report' }, requests: [] })
    const t0 = Date.now() - 60 * 60 * 1000
    const at = (min) => new Date(t0 + min * 60 * 1000).toISOString()
    const base = {
      symptom: '购物车角标在删除最后一件商品后仍显示 1',
      rootCause: '`web/src/cart/store.ts:52` 删除最后一件时提前 return，没有通知订阅者',
      confirmed: true,
      files: ['web/src/cart/store.ts'],
      verify: 'store.test.ts 新增「删除最后一件后角标归零」',
      level: 'standard',
      answers: [],
      notes: [],
      overall: '',
      before: [],
    }
    const options = [
      { id: 'A', title: '去掉提前 return', change: '`remove` 删完总是派发 `cart:change`', files: [] },
      { id: 'B', title: '角标自己订阅存储', change: 'badge.ts 直接监听 storage 事件', files: [] },
    ]
    const say = (id, min, text) => ({ id, role: 'user', agentId: '', step: '', text, tools: [], at: at(min) })
    const q1 = say('chat-q1', 20, '角标为什么不直接监听存储？那样别的地方删也能跟上')
    const q2 = say('chat-q2', 30, '就按角标自己订阅存储来改吧')
    kid.messages.push(q1, q2)
    kid.bug.diagnoses = [
      { ...base, phase: 'cause', version: 1, rev: 1, at: at(0), status: 'approved', decidedAt: at(5) },
      {
        ...base,
        phase: 'plan',
        version: 2,
        rev: 1,
        at: at(10),
        status: 'superseded',
        fix: '去掉提前 return，统一在末尾派发 change',
        options,
        chosen: { id: 'A', why: '修在源头', whyNotOthers: 'B 只是绕过' },
      },
      {
        ...base,
        phase: 'plan',
        version: 3,
        rev: 1,
        at: at(31),
        status: 'approved',
        decidedAt: at(31),
        files: ['web/src/cart/badge.ts'],
        fix: '角标直接监听存储里的购物车数量，不再依赖 change 事件',
        options,
        chosen: { id: 'B', why: '你在对话里定的：别的入口删商品也能跟上', whyNotOthers: 'A 只修了这一个入口' },
        whatChanged: '按你在对话里说的，选定方案从 A 换成 B',
        chat: [q1, q2].map(({ id, at, text }) => ({ id, at, text })),
        approvedBy: { kind: 'chat', id: q2.id, at: q2.at },
      },
    ]
    // 确认之后你又在对话里说了一句：报告顶上提示可能没跟上
    kid.messages.push(say('chat-q3', 45, '结算页的角标也一起改成监听存储'))
    localStorage.setItem(`task-child:${parent.id}`, kid.id)
    localStorage.removeItem(`task-run:${parent.id}`)
    localStorage.setItem(k, JSON.stringify(db))
  }, 'agent-panel-demo-v3')
  await p.reload()
  await backToTask()

  // 运行区的报告卡片写「对话里确认」，点「查看报告」打开
  const card = childView(p).locator('.proc-list')
  await card
    .getByText('对话里确认', { exact: true })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('按对话：报告卡片上没有写「对话里确认」'))
  await card.getByRole('button', { name: '查看报告' }).last().click()
  const dlg = p.getByRole('dialog')
  await dlg
    .getByText('依据你在对话里说的（2 句）', { exact: false })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('按对话：报告上没有「依据你在对话里说的」'))
  await settle(p)
  for (const text of [
    '就按角标自己订阅存储来改吧',
    '你在对话里确认了',
    '比第 1 版：结论已改',
    '不是这个意思',
    '这份报告之后你在对话里说了 1 句，报告可能没跟上。',
    '让它按对话更新报告',
  ])
    if (!(await dlg.getByText(text, { exact: false }).count())) errors.push(`按对话：报告上没有显示「${text}」`)
  if (!(await dlg.getByText('第 1.1 版 · 修复方案 · 按对话', { exact: false }).count()))
    errors.push('按对话：版本标签没有写「第 1.1 版 · 修复方案 · 按对话」')
  await check(p, '诊断报告-按对话更新', ['依据你在对话里说的'])

  // 「不是这个意思」：撤回在对话里的确认，这一版回到等你确认，底栏出现确认按钮
  await dlg.getByRole('button', { name: '不是这个意思' }).click()
  await dlg
    .getByRole('button', { name: '确认方案，开始修' })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('按对话：撤回后这一版没有回到等你确认'))
  if (await dlg.getByRole('button', { name: '不是这个意思' }).count())
    errors.push('按对话：撤回后还显示「不是这个意思」')
  await check(p, '诊断报告-按对话-撤回后')
})
