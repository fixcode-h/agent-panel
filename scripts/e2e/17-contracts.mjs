/**
 * 端到端测试分片：正式后端的接口返回和前后端共用的契约对得上（重构文档第 9 条，ADR 0062）。
 *
 * 跑的是 shared/api-contract/probe.ts 那一份探查，演示后端在 web/src/lib/demo-contract.test.ts 里跑同一份：
 * 设置、分类、标签、角色、工作流、项目分类、项目、定时计划、任务列表。哪边少了字段，报错里直接写出是哪个接口。
 * 子对话栏和任务详情由 server/task-api-contract.test.ts 在单测里查（这里没有子对话）。
 */
import assert from 'node:assert/strict'

import { probeContracts } from '../../shared/api-contract/probe.ts'
import { runShard } from './harness.mjs'

await runShard('接口契约', async (api) => {
  const { call, step, setupBase, waitDone } = api
  const { project } = await setupBase()
  // 项目里放一个做完的对话：任务列表不能是空的，不然列表的形状什么也没查到
  const chat = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: '',
    cli: 'claude',
    prompt: '契约',
  })
  await waitDone(chat.id, 20000)
  step('基础数据和一个做完的对话')

  // harness 的 call 把 204 无内容读成 null，契约里无内容是 undefined
  const report = await probeContracts(async (method, url, body) => (await call(method, url, body)) ?? undefined)
  assert.deepEqual(report.problems, [], report.problems.join('\n'))
  assert.ok(report.checked.length >= 20, `探查走过的接口太少：${report.checked.join('、')}`)
  step(`正式后端 ${report.checked.length} 个接口的返回形状和契约一致`)
})
