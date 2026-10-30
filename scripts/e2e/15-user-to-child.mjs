/**
 * 用户直接在子对话里发消息：子对话自己接着做，父对话计划里挂一步等它（不往父对话流里发消息），做完把状态报回父对话并叫起它，汇报里带上用户的原话。
 *
 * 以前父对话计划里没人等这个子对话：做完的上报只进父对话的收件箱，父对话不会被叫起，
 * 一直以为子对话停在「已完成」（用户报过）。
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs）。
 */
import assert from 'node:assert/strict'

import { runShard } from './harness.mjs'

await runShard('用户直接发给子对话后通知父对话', async (api) => {
  const { call, sleep, waitFor, waitDone, step, setupBase } = api
  const { project, B } = await setupBase()
  let parent = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    prompt: '统筹父对话',
  })
  parent = await waitDone(parent.id, 20000)
  let kid = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    parentTaskId: parent.id,
    prompt: '子对话第一件事',
  })
  kid = await waitDone(kid.id, 20000)
  await waitFor(async () => (await call('GET', `/tasks/${parent.id}`)).status === 'done', { label: '父对话空闲' })
  // 同一轮只报一次：CLI 报完这一轮和整次执行收尾都会走到上报，以前因为 status 不同报了两条一样的
  const reports = (p) => p.messages.filter((m) => m.panel === 'child' && /【子对话状态】/.test(m.text))
  await sleep(500)
  assert.equal(reports(await call('GET', `/tasks/${parent.id}`)).length, 1, '子对话一轮做完，父对话里只有一条状态')

  await call('POST', `/tasks/${kid.id}/messages`, { text: 'USER_DIRECT 用户直接让子对话再做一件事' })
  const noted = await call('GET', `/tasks/${parent.id}`)
  const plan = noted.plans?.at(-1)
  const waitStep = plan?.steps.find((s) => s.waits?.some((w) => w.kind === 'child' && w.ref === kid.id))
  assert.ok(waitStep, '父对话计划里挂上一步等这个子对话')
  // 用户直接交代是状态不是信（ADR 0034）：父对话流里不再记一行，只在计划那一步写明
  assert.ok(
    !noted.messages.some((m) => /【用户直接交代子对话】|用户直接交代/.test(m.text)),
    '父对话流里不再记「用户直接交代」的消息',
  )
  assert.match(waitStep.note ?? '', /你直接交代了新要求/, '父计划那一步写明你直接交代了新要求')

  await waitDone(kid.id, 20000)
  const woken = await waitFor(
    async () => {
      const p = await call('GET', `/tasks/${parent.id}`)
      const s = p.plans?.at(-1)?.steps.find((x) => x.id === waitStep.id)
      // 父对话这时本来空闲：之后多出的 AI 回复只可能是子对话的状态把它叫起来的
      const replied = p.messages.some((m) => m.role === 'agent' && m.at > noted.updatedAt)
      return s?.status === 'done' && replied ? p : null
    },
    { timeout: 20000, label: '子对话做完后父对话计划那一步收口，并被叫起来处理' },
  )
  const fresh = reports(woken).filter((m) => m.at > noted.updatedAt)
  assert.equal(fresh.length, 1, '父对话收到子对话这次做完的状态，只有一条')
  // 带的是这一轮的回复，不是上一轮留下的摘要（task.summary 要等整次执行收尾才更新）
  const latest = (await call('GET', `/tasks/${kid.id}`)).messages.filter((m) => m.role === 'agent').at(-1)
  assert.ok(fresh[0].text.includes(latest.text.replace(/\s+/g, ' ').trim().slice(0, 60)), '状态里带的是这一轮的结果')
  assert.ok(fresh[0].text.includes('USER_DIRECT'), '汇报里带上用户直接交代的原话')
  step('用户直接发给子对话：父对话计划挂上等它，做完收口那一步并叫起父对话；每轮只报一条状态')
})
