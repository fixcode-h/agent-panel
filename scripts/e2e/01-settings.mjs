/**
 * 端到端测试分片：新装默认、设置保存与检测、Agent 引入循环
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'

import { runShard } from './harness.mjs'

await runShard('设置与 CLI 检测', async (api) => {
  const { baseUrl: base, call, step, putSettings, createAgents } = api

  const fresh = await call('GET', '/settings')
  assert.ok(
    Object.values(fresh.clis).length && Object.values(fresh.clis).every((c) => !c.enabled),
    '新装时 CLI 默认不启用',
  )
  assert.ok((await call('GET', '/clis')).every((c) => !c.enabled))
  step('新装时 CLI 默认都不启用')

  // 保存设置：四个 CLI 都指向假 CLI，检测都通过
  await putSettings()
  const clis = await call('GET', '/clis?refresh=1')
  assert.deepEqual(
    clis.map((c) => [c.id, c.installed]),
    [
      ['claude', true],
      ['codex', true],
      ['commandcode', true],
      ['pi', true],
    ],
  )
  assert.match(clis[1].version, /fake 0.0.1/)
  step('设置保存，各个 CLI 都能检测到')

  // 甲、乙、丙三个 Agent，后面几个分片的开场数据也按这三个建
  const { A, B } = await createAgents()
  {
    // 引入会绕回自己时拒绝保存；引入自己的直接去掉
    const put = (a, o) =>
      fetch(`${base}/agents/${a.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...a, ...o }),
      })
    assert.equal((await put(A, { includes: [B.id, A.id] })).status, 200)
    assert.deepEqual((await call('GET', '/agents')).find((a) => a.id === A.id).includes, [B.id])
    const r = await put(B, { includes: [A.id] })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /循环：乙 → 甲 → 乙/)
    assert.equal((await put(A, { includes: [] })).status, 200)
    step('Agent 引入：会形成循环的拒绝保存')
  }
})
