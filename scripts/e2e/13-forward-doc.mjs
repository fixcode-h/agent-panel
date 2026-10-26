/**
 * 「禁止子对话执行」的角色（runIn: 'parent'，ADR 0019）
 *
 * 覆盖整条链路，不是提示词：
 * - 子对话里点名「文档」时不在子对话里建子任务，而是转交父对话创建（父对话没在跑也能接：排队 + 叫起一轮）；
 * - 子对话点名的计划步骤立即标完成，子对话照常收尾，不被这个外部子任务卡住；
 * - 父对话那边出现这个子任务，并写明是哪个子对话请求的；
 * - 角色开关改完立即生效：改成「任意对话」后，同一个子对话里直接本地派。
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs）。
 */
import assert from 'node:assert/strict'

import { runShard } from './harness.mjs'

await runShard('禁止子对话执行的角色转交父对话', async (api) => {
  const { call, calls, waitFor, waitDone, step, setupBase } = api
  const { project, B } = await setupBase()
  const docAgent = (await call('GET', '/agents')).find((a) => a.name === '文档')
  assert.ok(docAgent, '内置「文档」角色在启动时已经装好')
  assert.equal(docAgent.runIn, 'parent', '「文档」默认禁止子对话执行')

  // 父对话先跑完：转交时它没在跑，走的是「排队 + 叫起一轮」那条路
  let parent = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })
  parent = await waitDone(parent.id, 20000)

  const kid = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    parentTaskId: parent.id,
    prompt: 'FORWARD_DOC 给这次改动补文档',
  })
  const done = await waitDone(kid.id, 30000)
  assert.equal(done.status, 'done', '子对话能正常收尾，不被转交出去的文档任务卡住')

  const kidTask = await call('GET', `/tasks/${done.id}`)
  assert.equal(kidTask.steps.filter((s) => s.slot === 'sub').length, 0, '子对话里不建这个子任务')
  const planStep = (kidTask.plans.at(-1)?.steps ?? []).find((s) => s.title === '补文档')
  assert.ok(planStep, '子对话列出了补文档这一步')
  assert.equal(planStep.status, 'done', '点名的步骤立即标完成，不等父对话那边的结果')
  assert.ok(
    kidTask.messages.some((m) => /已转交父对话/.test(m.text)),
    '子对话里留一条可读的记录，收尾总结能说明这件事',
  )

  // 父对话那边：子任务真的建出来了，并写明是谁请求的
  const withSub = await waitFor(
    async () => {
      const p = await call('GET', `/tasks/${parent.id}`)
      return p.steps.find((s) => s.slot === 'sub' && s.title === '补文档') ? p : null
    },
    { timeout: 30000, label: '父对话里出现转交来的子任务' },
  )
  const sub = withSub.steps.find((s) => s.slot === 'sub')
  assert.equal(sub.agentId, docAgent.id, '用点名的「文档」角色跑')
  assert.ok(
    withSub.messages.some((m) => /请求创建子任务「补文档」/.test(m.text)),
    '父对话里写明是哪个子对话请求的',
  )
  // 唤醒和正式记录只写一处正文：以前两处都写全文，父对话里会出现两条一模一样的请求
  assert.equal(
    withSub.messages.filter((m) => /请求创建子任务「补文档」/.test(m.text)).length,
    1,
    '父对话里只有一条正式的请求记录',
  )
  step('子对话派「文档」：不在子对话里建，转交父对话创建，点名的步骤立即完成')

  // 父对话正在跑（working）时：直接派进这一轮，不用等它下一轮
  const busy = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    prompt: 'SLOW 父对话正在跑',
  })
  await waitFor(() => calls().some((c) => (c.input ?? '').includes('SLOW 父对话正在跑')), { label: '父对话开始执行' })
  const busyKid = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    parentTaskId: busy.id,
    prompt: 'FORWARD_DOC 父对话忙时补文档',
  })
  await waitDone(busyKid.id, 30000)
  const busyTask = await call('GET', `/tasks/${busy.id}`)
  assert.ok(
    busyTask.steps.find((s) => s.slot === 'sub' && s.title === '补文档'),
    '父对话正在跑时，转交的直接派进这一轮',
  )
  await waitDone(busy.id, 40000)
  step('父对话正在跑时：转交直接派进这一轮，不等下一轮')

  // 用户改开关立即生效：改成「任意对话」后，同一个父对话下再派就在子对话里本地建
  await call('PUT', `/agents/${docAgent.id}`, { ...docAgent, runIn: 'any' })
  const local = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    parentTaskId: parent.id,
    prompt: 'FORWARD_DOC 这次在子对话里补文档',
  })
  const localDone = await waitDone(local.id, 30000)
  const localTask = await call('GET', `/tasks/${localDone.id}`)
  const localSub = localTask.steps.find((s) => s.slot === 'sub')
  assert.ok(localSub, '改成「任意对话」后，子对话里直接建这个子任务')
  assert.equal(localSub.agentId, docAgent.id, '用点名的「文档」角色跑')
  // 改回默认值（分片各有自己的数据目录，这里只是让状态回到出厂设置）
  await call('PUT', `/agents/${docAgent.id}`, { ...docAgent })
  step('改角色开关立即生效：改成「任意对话」就在子对话里本地派')
})
